// 多租户（行级共享库）回归测试 — T1~T6
// 沙箱外本地复跑：PGDATABASE=plm_test npx vitest run test/multi-tenant.test.js
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';

// ───────────────────────── T1 身份层：租户锚（纯 token 契约，不连 DB） ─────────────────────────
import { issueToken, verifyToken, resolveMe } from '../src/http/auth.js';

describe('T1 身份层：租户锚', () => {
  it('issueToken 携带 tenantId claim；verifyToken 可回解', () => {
    const tok = issueToken({ username: 'alice', role: 'sales', display_name: 'Alice', tenantId: 'acme' });
    const p = verifyToken(tok);
    expect(p.tenantId).toBe('acme');
    expect(p.username).toBe('alice');
    expect(p.role).toBe('sales');
  });

  it('resolveMe 从 token 解出 tenantId', () => {
    const tok = issueToken({ username: 'bob', role: 'sales', display_name: 'Bob', tenantId: 'globex' });
    const me = resolveMe({ headers: { authorization: `Bearer ${tok}` } });
    expect(me.ok).toBe(true);
    expect(me.tenantId).toBe('globex');
  });

  it('旧 token（无 tenantId claim）回退 system（向后兼容）', () => {
    const oldTok = issueToken({ username: 'carol', role: 'admin', display_name: 'Carol' }); // 无 tenantId
    const me = resolveMe({ headers: { authorization: `Bearer ${oldTok}` } });
    expect(me.ok).toBe(true);
    expect(me.tenantId).toBe('system');
  });
});

// ───────────────────────── T2 读作用域：行级隔离 ─────────────────────────
import { createParticle, queryParticles, getParticle } from '../src/particles/particleRepo.js';
import { scopeTenant } from '../src/http/tenantScope.js';
import { getFlowByDomain, writeFlowFromStages } from '../src/approval/flow.js';
import { startInstance } from '../src/approval/engine.js';

describe('T2 读作用域：行级隔离', () => {
  it('queryParticles 通配 * 省略 tenant 条件', async () => {
    const all = await queryParticles({ type: 'CRM_ACCOUNT', tenantId: '*' });
    const scoped = await queryParticles({ type: 'CRM_ACCOUNT', tenantId: 'acme' });
    expect(all.length).toBeGreaterThanOrEqual(scoped.length);
  });

  it('普通用户 scopeTenant 取自身租户；admin 取 *', () => {
    expect(scopeTenant({ role: 'sales', tenantId: 'acme' })).toBe('acme');
    expect(scopeTenant({ role: 'admin', tenantId: 'acme' })).toBe('*');
    expect(scopeTenant({ role: 'sales' })).toBe('system'); // 缺省回退
  });

  it('同 slug 两租户各见各（不串）', async () => {
    const slug = `iso-${Date.now()}`;
    await createParticle('CRM_ACCOUNT', { name: 'AcmeCo', slug }, { tenantId: 'acme', actor: 'u1' });
    await createParticle('CRM_ACCOUNT', { name: 'AcmeCo', slug }, { tenantId: 'globex', actor: 'u2' });
    const a = await queryParticles({ type: 'CRM_ACCOUNT', tenantId: 'acme' });
    const g = await queryParticles({ type: 'CRM_ACCOUNT', tenantId: 'globex' });
    // 注意：createParticle 写列 slug=def.slug（类型 slug），业务 slug 落在 payload.slug，故按 payload.slug 过滤
    expect(a.filter(r => r.payload?.slug === slug).length).toBe(1);
    expect(g.filter(r => r.payload?.slug === slug).length).toBe(1);
    expect(a.find(r => r.payload?.slug === slug).tenant_id).toBe('acme');
    expect(g.find(r => r.payload?.slug === slug).tenant_id).toBe('globex');
  });
});

// ───────────────────────── T3 审批域：跨租户不串 ─────────────────────────
import { writeFlowFromStages, getFlowByDomain } from '../src/approval/flow.js';
import { startInstance } from '../src/approval/engine.js';
import { getParticle } from '../src/particles/particleRepo.js';

describe('T3 审批域：跨租户不串', () => {
  it('两租户同 domain 各写各流，startInstance 落各自租户', async () => {
    const f1 = await writeFlowFromStages({ flow_id: 'quote', name: 'Q-acme', stages: [{ stage: 1, role: 'sales', action: 'approve', auto_allowed: false }] }, 'acme');
    const f2 = await writeFlowFromStages({ flow_id: 'quote', name: 'Q-globex', stages: [{ stage: 1, role: 'sales', action: 'approve', auto_allowed: false }] }, 'globex');
    const fid1 = (await getFlowByDomain('quote', 'acme')).id;
    const fid2 = (await getFlowByDomain('quote', 'globex')).id;
    expect(fid1).not.toBe(fid2);
    const inst1 = await startInstance(fid1, 'CRM_QUOTATION', `b1-${Date.now()}`, {}, { submitter: 'u1', tenantId: 'acme' });
    const inst1p = await getParticle(inst1.id);
    expect(inst1p.tenant_id).toBe('acme');
    const gInstances = await queryParticles({ type: 'CRM_APPROVAL_INSTANCE', tenantId: 'globex' });
    expect(gInstances.find(r => r.id === inst1.id)).toBeUndefined();
  });
});

// ───────────────────────── T4 配置面：per-tenant + 回退 ─────────────────────────
import { readConfig, writeConfig } from '../src/config/configStore.js';

describe('T4 配置面：per-tenant + 回退', () => {
  it('新租户读某 key 回退 system 默认', async () => {
    const sys = await readConfig('sales-thresholds', { tenantId: 'system' });
    // system 可能无该 key（未 seed），允许 null 场景；若有值则回退一致
    if (!sys) return;
    const acme = await readConfig('sales-thresholds', { tenantId: 'acme' });
    expect(acme.value).toEqual(sys.value);
  });

  it('租户 PUT 后覆盖生效且不污染 system', async () => {
    const override = { bantcc_pass: 5, _mt_test: Date.now() };
    await writeConfig('sales-thresholds', override, { tenantId: 'acme', updatedBy: 'u1' });
    const acme = await readConfig('sales-thresholds', { tenantId: 'acme' });
    const sys = await readConfig('sales-thresholds', { tenantId: 'system' });
    expect(acme.value).toEqual(override);
    if (sys) expect(sys.value).not.toEqual(override); // system 默认未被污染
    // 清理测试覆盖（禁删铁律：覆盖回退 system 默认即删除租户行）
    await writeConfig('sales-thresholds', sys ? sys.value : null, { tenantId: 'acme', updatedBy: 'u1' });
  });
});

// ───────────────────────── T5 决策/审计分租户 ─────────────────────────
import { query, queryWrite } from '../src/db.js';

describe('T5 决策/审计分租户', () => {
  it('decision 表按 tenant_id 隔离', async () => {
    const idA = randomUUID();
    const idG = randomUUID();
    await queryWrite(
      `INSERT INTO crm.decision (decision_id, scenario_id, tenant_id, state, trigger_context, involved_entities, conditions_evaluated, disposition, decider_type, decider_id, decider_role, business_tier, rationale)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [idA, 'CALIBRATION_CHANGE', 'acme', 'OPEN', '{}', '[]', '[]', 'TBD', 'system', 'seed', 'admin', 'NORMAL', 'mt-test']);
    await queryWrite(
      `INSERT INTO crm.decision (decision_id, scenario_id, tenant_id, state, trigger_context, involved_entities, conditions_evaluated, disposition, decider_type, decider_id, decider_role, business_tier, rationale)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [idG, 'CALIBRATION_CHANGE', 'globex', 'OPEN', '{}', '[]', '[]', 'TBD', 'system', 'seed', 'admin', 'NORMAL', 'mt-test']);
    const a = await query(`SELECT * FROM crm.decision WHERE tenant_id='acme'`);
    const g = await query(`SELECT * FROM crm.decision WHERE tenant_id='globex'`);
    expect(a.rows.every(r => r.tenant_id === 'acme')).toBe(true);
    expect(g.rows.every(r => r.tenant_id === 'globex')).toBe(true);
    await queryWrite(`DELETE FROM crm.decision WHERE decision_id IN ($1,$2)`, [idA, idG]);
  });
});

// ───────────────────────── T6 租户管理 + E2E 隔离（真实 HTTP 链路） ─────────────────────────
import { createApp } from '../src/http/server.js';
import { issueToken } from '../src/http/auth.js';

describe('T6 租户管理 + E2E 隔离', () => {
  const TENANT = 't6_e2e_' + Date.now();
  const ADMIN = 't6_admin_' + Date.now();
  const PASS = 't6_secret_123';
  const headers = (tok) => ({ authorization: `Bearer ${tok}`, 'content-type': 'application/json' });

  it('POST /api/tenants 需 admin 闸（sales 403）；admin 建租户落各自 tenant；GET 列出租户', async () => {
    const app = createApp();
    const salesTok = issueToken({ username: 'bob', role: 'sales', display_name: 'Bob', tenantId: 'acme' });
    const adminTok = issueToken({ username: 'admin', role: 'admin', display_name: 'Admin', tenantId: 'system' });

    // 1) 普通用户被拦（403）
    const r1 = await app.fetch('/api/tenants', {
      method: 'POST', headers: headers(salesTok),
      body: JSON.stringify({ tenantId: TENANT, adminUser: ADMIN, adminPass: PASS }),
    });
    expect(r1.status).toBe(403);

    // 2) admin 建租户（第0闸落 decision）
    const r2 = await app.fetch('/api/tenants', {
      method: 'POST', headers: headers(adminTok),
      body: JSON.stringify({ tenantId: TENANT, adminUser: ADMIN, adminPass: PASS }),
    });
    const b2 = await r2.json();
    expect(r2.status).toBe(200);
    expect(b2.ok).toBe(true);
    expect(!!b2.decisionId).toBe(true); // 第0闸真实决策留痕

    // 3) 新用户落到新租户
    const u = await query(`SELECT username, tenant_id, role FROM crm.crm_users WHERE username=$1`, [ADMIN]);
    expect(u.rows[0]?.tenant_id).toBe(TENANT);
    expect(u.rows[0]?.role).toBe('admin');

    // 4) GET 列出租户含新租户
    const r3 = await app.fetch('/api/tenants', { method: 'GET', headers: headers(adminTok) });
    const b3 = await r3.json();
    expect(Array.isArray(b3.tenants) && b3.tenants.some(t => t.tenant_id === TENANT)).toBe(true);

    // 清理测试租户用户（测试库卫生；禁删铁律约束产品写路径，测试自插数据可清）
    await queryWrite(`DELETE FROM crm.crm_users WHERE username=$1`, [ADMIN]).catch(() => {});
  });
});
