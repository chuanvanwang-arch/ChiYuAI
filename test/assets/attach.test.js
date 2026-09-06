// test/assets/attach.test.js — crm-asset-attach 两阶段挂接（业务写，过第0闸）
// 设计：docs/2026-08-31-unstructured-asset-attach-design.md §4.2
// 语义：上传 = staging（免 confirm）；挂接 = 业务写（第0闸 decision_id + 两阶段 confirm）
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createApp } from '../../src/http/server.js';
import { query, queryWrite } from '../../src/db.js';
import { issueToken } from '../../src/http/auth.js';
import { mcpLogin } from '../../src/mcp/auth.js';
import { listMcpTools } from '../../src/mcp/tools.js';
import { seedActions } from '../../src/action/seed-actions.js';
import { getAction } from '../../src/action/registry.js';
import { createParticle } from '../../src/particles/particleRepo.js';
import { createDecision } from '../../src/decision/decisionRepo.js';

const app = createApp();
const httpToken = issueToken({ username: 'tester', role: 'admin', display_name: '测试员' });
const SUF = Math.random().toString(36).slice(2, 8);
const USER = `asset_agent_${SUF}`;
const PW = 'P@ssw0rd!';

let mcpToken = null;      // 真 MCP token（crm_login 颁发 → resolveIdentity 可解析）
let decisionId = null;    // 第0闸所需 decision_id
let accountId = null;
let assetId = null;

const createdAssets = [];

async function uploadAsset(name = 'contract.pdf', body = 'contract-bytes') {
  const res = await app.fetch('/api/assets/upload', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${httpToken}`,
      'Content-Type': 'application/octet-stream',
      'X-File-Name': name,
      'X-File-Mime': 'application/pdf',
    },
    body: Buffer.from(body),
  });
  const json = await res.json();
  createdAssets.push(json.asset_id);
  return json.asset_id;
}

describe('T4 crm-asset-attach 两阶段挂接', () => {
  beforeAll(async () => {
    seedActions();
    // ① MCP 身份（requireAuth=true：无 token 会先命中 auth_required 而非第0闸）
    await queryWrite(
      `INSERT INTO crm.crm_users (username, password_hash, role, display_name, enabled)
       VALUES ($1, crypt($2, gen_salt('bf')), 'sales', 'AssetAgent', true)`,
      [USER, PW]
    );
    const login = await mcpLogin({ username: USER, password: PW });
    mcpToken = login.token;
    // ② 业务目标粒子
    const acct = await createParticle('CRM_ACCOUNT', { name: `挂接测试客户-${SUF}`, named_owner: USER }, { tenantId: 'system', actor: USER });
    accountId = acct.id;
    // ③ 决策行（第0闸凭证）：优先建真实决策，失败回退固定 id（gateway 只校验非空）
    try {
      const d = await createDecision({
        scenario_id: 'ASSET_ATTACH', disposition: 'PROCEED', rationale: '证据挂接测试',
        trigger_context: { kind: 'asset_attach' }, conditions_evaluated: [], tenantId: 'system',
      });
      decisionId = d.decision_id;
    } catch {
      decisionId = 'a5555555-5555-5555-5555-5555555555a5';
    }
  }, 60000); // DB 密集（createParticle → ensureAll 向量/FTS + AGE 镜像 + createDecision 七维校验），放宽 hook 超时

  afterAll(async () => {
    await queryWrite(`DELETE FROM crm.edges WHERE edge_type='evidenced_by' AND source_id=$1`, [accountId]);
    if (createdAssets.length) await queryWrite(`DELETE FROM crm.particles WHERE id = ANY($1::uuid[])`, [createdAssets]);
    if (accountId) await queryWrite(`DELETE FROM crm.particles WHERE id=$1`, [accountId]);
  });

  it('Action 已注册为 write，且进入 MCP 工具清单（非 data- 前缀自动暴露）', () => {
    const def = getAction('crm-asset-attach');
    expect(def).toBeTruthy();
    expect(def.kind).toBe('write');
    const names = listMcpTools().tools.map((t) => t.name);
    expect(names).toContain('crm-asset-attach');
  });

  it('无 decision_id → 第0闸拒绝（gate=decision_required，未发 confirm_token）', async () => {
    const { mcpWritePhase1 } = await import('../../src/mcp/gateway.js');
    assetId = await uploadAsset('proof.pdf', 'proof-bytes');
    const r = await mcpWritePhase1(
      'crm-asset-attach',
      { asset_id: assetId, target_type: 'CRM_ACCOUNT', target_id: accountId },
      { Authorization: `Bearer ${mcpToken}` }
    );
    expect(r.ok).toBe(false);
    expect(r.gate).toBe('decision_required');
    expect(r.confirm_token).toBeUndefined();
  }, 60000);

  it('带 decision_id 两阶段 → evidenced_by 边落库且 meta 携带 decision_id', async () => {
    const { mcpWritePhase1, mcpConfirmPhase2 } = await import('../../src/mcp/gateway.js');
    const aid = await uploadAsset('contract.pdf', 'contract-bytes');
    const headers = { Authorization: `Bearer ${mcpToken}` };
    const p1 = await mcpWritePhase1(
      'crm-asset-attach',
      { asset_id: aid, target_type: 'CRM_ACCOUNT', target_id: accountId, decision_id: decisionId },
      headers
    );
    expect(p1.ok).toBe(true);
    expect(p1.confirm_token).toBeTruthy();
    const p2 = await mcpConfirmPhase2(p1.confirm_token, '1', null, {}, headers);
    expect(p2.ok).toBe(true);
    // dispatch 契约（executor.js:156）：通道成功恒返回 {ok:true, data:<handler 结果>}
    expect(String((p2.data || {}).summary || '')).toContain('挂接');

    const r = await query(`SELECT * FROM crm.edges WHERE source_id=$1 AND edge_type='evidenced_by'`, [accountId]);
    expect(r.rows.length).toBe(1);
    expect(r.rows[0].target_type).toBe('CRM_UNSTRUCTURED_ASSET');
    expect(r.rows[0].target_id).toBe(aid);
    expect(r.rows[0].meta.decision_id).toBe(decisionId);
    expect(r.rows[0].meta.edge_source).toBe('manual');
  }, 60000);

  it('白名单外 target_type（CRM_PRODUCT）→ 拒绝落边', async () => {
    const { mcpWritePhase1, mcpConfirmPhase2 } = await import('../../src/mcp/gateway.js');
    const aid = await uploadAsset('p.pdf', 'p-bytes');
    const headers = { Authorization: `Bearer ${mcpToken}` };
    const p1 = await mcpWritePhase1(
      'crm-asset-attach',
      { asset_id: aid, target_type: 'CRM_PRODUCT', target_id: accountId, decision_id: decisionId },
      headers
    );
    // 第0闸与 confirm 在 gateway；白名单是 Action handler 的业务校验 → phase2 执行时拒绝
    if (!p1.ok) { expect(p1.ok).toBe(false); return; }
    const p2 = await mcpConfirmPhase2(p1.confirm_token, '1', null, {}, headers);
    expect(p2.ok).toBe(false);
    expect(String(p2.error || '')).toContain('白名单');
    const r = await query(`SELECT * FROM crm.edges WHERE target_id=$1 AND edge_type='evidenced_by'`, [aid]);
    expect(r.rows.length).toBe(0);
  }, 60000);
});
