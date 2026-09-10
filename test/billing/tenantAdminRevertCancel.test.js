// test/billing/tenantAdminRevertCancel.test.js — 退订恢复（B 方案）端到端（TR1–TR6）
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import { query, queryWrite } from '../../src/db.js';

vi.mock('../../src/http/auth.js', () => ({ resolveMe: vi.fn() }));
const { resolveMe } = await import('../../src/http/auth.js');
const { createBillingRouter } = await import('../../src/http/billingRoutes.js');

const NS = '__rc_' + process.pid + '_' + Date.now();
const T = NS + '_tenant';
let server = null, baseUrl = '';

const role = (r = 'admin') => resolveMe.mockReturnValue({ ok: true, role: r, tenantId: 'system', username: 'tester' });
async function call(action, body, r = 'admin') {
  role(r);
  const res = await fetch(`${baseUrl}/api/billing/tenant-admin/${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const tenantRow = async (tid) => (await query(`SELECT status, retired_at, plan FROM crm.tenants WHERE tenant_id=$1`, [tid])).rows[0];
const subRow = async (tid) => (await query(`SELECT status FROM crm.tenant_subscription WHERE tenant_id=$1`, [tid])).rows[0];
const decisionCount = async (frag) => (await query(`SELECT count(*)::int c FROM crm.decision WHERE rationale LIKE '%' || $1 || '%'`, [frag])).rows[0].c;

async function setupActiveTenant(tid) {
  // tenants PK = tenant_id（直接 UPSERT）
  await queryWrite(`INSERT INTO crm.tenants (tenant_id,name,status,plan) VALUES ($1,$1,'active','free') ON CONFLICT (tenant_id) DO UPDATE SET status='active',plan='free',retired_at=NULL`, [tid]);
  // tenant_subscription UNIQUE(tenant_id,plan_id,started_at) — 先清再插避免 now() 漂移
  await queryWrite(`DELETE FROM crm.tenant_subscription WHERE tenant_id=$1`, [tid]);
  await queryWrite(`INSERT INTO crm.tenant_subscription (tenant_id,plan_id,status,started_at,expires_at) VALUES ($1,'free','active',now(),now()+'10 days')`, [tid]);
}

beforeAll(async () => {
  await setupActiveTenant(T);
  const app = express();
  app.use(express.json());
  app.use(createBillingRouter());
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', () => { baseUrl = `http://127.0.0.1:${server.address().port}`; r(); }); });
});
afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  await queryWrite(`DELETE FROM crm.tenants WHERE tenant_id=$1`, [T]).catch(() => {});
  await queryWrite(`DELETE FROM crm.tenant_subscription WHERE tenant_id=$1`, [T]).catch(() => {});
});

describe('revert-cancel（退订恢复）', () => {
  it('TR1 退订→恢复 → tenants.status=active、retired_at=NULL、subscription.status=active', async () => {
    await setupActiveTenant(T);
    // 1. 退订
    const c = await call('cancel', { tenantId: T, reason: '测试退订' });
    expect(c.status).toBe(200); expect(c.body.ok).toBe(true);
    expect((await tenantRow(T)).status).toBe('retired');
    expect((await subRow(T)).status).toBe('canceled');
    // 2. 恢复
    const r = await call('revert-cancel', { tenantId: T, reason: '误点，退订恢复' });
    expect(r.status).toBe(200); expect(r.body.ok).toBe(true);
    expect(r.body.status).toBe('active');
    expect(r.body.tenantReverted).toBe(1);
    expect(r.body.subReverted).toBe(1);
    // 3. 落库校验
    const tn = await tenantRow(T);
    expect(tn.status).toBe('active');
    expect(tn.retired_at).toBeNull();
    expect((await subRow(T)).status).toBe('active');
  });

  it('TR2 非 retired 状态幂等（noop:true，status 原样返回）', async () => {
    await setupActiveTenant(T);
    // 当前 active，恢复是无操作
    const r = await call('revert-cancel', { tenantId: T });
    expect(r.status).toBe(200);
    expect(r.body.noop).toBe(true);
    expect(r.body.status).toBe('active');
  });

  it('TR3 system 租户拒绝 → 400', async () => {
    const r = await call('revert-cancel', { tenantId: 'system' });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('system');
  });

  it('TR4 不存在租户 → 404', async () => {
    const r = await call('revert-cancel', { tenantId: '__ghost__' });
    expect(r.status).toBe(404);
    expect(r.body.error).toContain('not found');
  });

  it('TR5 sales 角色无权限 → 403', async () => {
    await setupActiveTenant(T);
    await call('cancel', { tenantId: T });
    const r = await call('revert-cancel', { tenantId: T }, 'sales');
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('forbidden');
    // 状态未被翻转（仍 retired → 销售无权救）
    expect((await tenantRow(T)).status).toBe('retired');
  });

  it('TR6 决策第 0 闸落库（revert-cancel 决策行）', async () => {
    await setupActiveTenant(T);
    await call('cancel', { tenantId: T });
    const before = await decisionCount('revert-cancel');
    await call('revert-cancel', { tenantId: T, reason: 'TR6 audit' });
    const after = await decisionCount('revert-cancel');
    expect(after).toBe(before + 1);
  });
});
