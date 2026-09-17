// test/leadPoolMineTab.test.js — 需求①「私海 Tab + 回退公海」链路守卫
// 真实范式（对齐 leadPoolPage.test.js）：createApp() + issueToken + 真连 crm_native_test
// 覆盖：
//   ① GET /api/lead-pool/mine——仅返回本租户 stage=S0P 且 owner_id=me（归属过滤 + 租户隔离）
//   ② 只读零写（GET 端点，无副作用）
//   ③ 前端「回退公海」按钮 → POST /api/action/crm-lead-return（复用既有 Action，deferDecisionMint 自 mint）
//   ④ crm-lead-return 在 registry（端点可达前提）
// 判据⑨/⑰：守卫扫描范围覆盖新产生点（前端 Tab + 端点 + Action）
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { createApp } from '../src/http/server.js';
import { query, queryWrite } from '../src/db.js';
import { issueToken } from '../src/http/auth.js';

const app = createApp();
const mkDeal = (tenantId, name, stage, ownerId = null, extra = {}) =>
  queryWrite(
    `INSERT INTO particles (tenant_id, type, slug, title, state, payload, decision_id)
     VALUES ($1, 'CRM_DEAL', 'crm-deal', $2, 'ACTIVE', $3::jsonb, NULL) RETURNING id`,
    [tenantId, name, JSON.stringify({ name, stage, owner_id: ownerId, ...extra })]
  );
const getPayload = async (id) =>
  (await query(`SELECT payload FROM particles WHERE id=$1`, [id])).rows[0].payload;

beforeEach(async () => {
  await query(`TRUNCATE particles, edges, events CASCADE`);
});

describe('GET /api/lead-pool/mine（我的私海，只读）', () => {
  it('仅返回本租户 S0P 且 owner_id=me（归属过滤 + 租户隔离）', async () => {
    const tok = issueToken({ username: 'salesA', role: 'sales', tenantId: 'tA' });
    // tA：两条 S0P 归属 salesA、一条归属 salesB（不应出现在 salesA 私海）
    await mkDeal('tA', 'mine-1', 'S0P', 'salesA');
    await mkDeal('tA', 'mine-2', 'S0P', 'salesA');
    await mkDeal('tA', 'others-1', 'S0P', 'salesB');
    // tB 隔离：salesA 在 tB 的任何 S0P 均不可见
    await mkDeal('tB', 'tB-1', 'S0P', 'salesA');
    const r = await app.fetch('/api/lead-pool/mine', { headers: { authorization: `Bearer ${tok}` } });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.total).toBe(2);
    const names = j.items.map((x) => x.name).sort();
    expect(names).toEqual(['mine-1', 'mine-2']);
    expect(j.items.every((x) => typeof x.in_pool_days === 'number')).toBe(true);
  }, 30000);

  it('未登录 401；缺用户名 400', async () => {
    const r = await app.fetch('/api/lead-pool/mine');
    expect(r.status).toBe(401);
    const noNameTok = issueToken({ role: 'sales', tenantId: 'tX' }); // 无 username/display_name
    const r2 = await app.fetch('/api/lead-pool/mine', { headers: { authorization: `Bearer ${noNameTok}` } });
    expect(r2.status).toBe(400);
  }, 30000);

  it('只读零写：GET 后无新增/变更粒子', async () => {
    const tok = issueToken({ username: 'salesRO', role: 'sales', tenantId: 'tRO' });
    await mkDeal('tRO', 'ro-1', 'S0P', 'salesRO');
    const before = (await query(`SELECT count(*)::int n FROM particles`, [])).rows[0].n;
    await app.fetch('/api/lead-pool/mine', { headers: { authorization: `Bearer ${tok}` } });
    const after = (await query(`SELECT count(*)::int n FROM particles`, [])).rows[0].n;
    expect(after).toBe(before);
  }, 30000);
});

describe('回退公海链路（需求①：私海 → 公海闭环）', () => {
  it('crm-lead-return 已在 registry（前端端点可达前提）', async () => {
    const { getAction } = await import('../src/action/registry.js');
    const { seedActions } = await import('../src/action/seed-actions.js');
    seedActions();
    const def = getAction('crm-lead-return');
    expect(def).not.toBeNull();
    expect(def.kind).toBe('write');
    expect(def.deferDecisionMint).toBe(true); // HTTP 直调自 mint 决策（leadPoolPage 已实证路径）
  }, 30000);

  it('回退后 stage=S0 + owner=null + 原因/入池时间重置（写走 /api/action）', async () => {
    const tok = issueToken({ username: 'retA', role: 'sales', tenantId: 'tR' });
    const id = (await mkDeal('tR', 'toReturn', 'S0P', 'retA')).rows[0].id;
    const r = await app.fetch('/api/action/crm-lead-return', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${tok}` },
      body: JSON.stringify({ deal_id: id, reason_code: 'no_project' }),
    });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);
    const p = await getPayload(id);
    expect(p.stage).toBe('S0');            // 回到公海
    expect(p.owner_id).toBe(null);         // 清归属
    expect(p.prev_owner_id).toBe('retA');  // 审计留痕
    expect(p.return_reason).toBe('no_project');
    expect(p.returned_at).toBeTruthy();
    expect(p.pooled_at).toBeTruthy();      // T4：退回重置入池时间
  }, 30000);

  it('非法 reason_code 被拒（RETURN_REASONS 白名单）', async () => {
    const tok = issueToken({ username: 'retB', role: 'sales', tenantId: 'tR2' });
    const id = (await mkDeal('tR2', 'bad', 'S0P', 'retB')).rows[0].id;
    const r = await app.fetch('/api/action/crm-lead-return', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${tok}` },
      body: JSON.stringify({ deal_id: id, reason_code: 'whatever' }),
    });
    expect(r.status).toBe(400);
  }, 30000);
});

describe('lead-pool.html 私海 Tab 前端契约', () => {
  it('含 panel-mine 结构 + /api/lead-pool/mine 端点调用 + 回退 Action', () => {
    const html = readFileSync('src/web/lead-pool.html', 'utf8');
    expect(html).toContain('id="panel-mine"');
    expect(html).toContain("fetch('/api/lead-pool/mine'");
    expect(html).toContain("fetch('/api/action/crm-lead-return'");
    expect(html).toContain('RETURN_REASONS');
    expect(html).toContain('loadMine()');
  });
});
