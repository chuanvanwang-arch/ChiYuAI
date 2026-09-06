// test/billing/tenantPlan.e2e.test.js — 管理台「设定租户档位」端到端（真实 express + 真实库，仅 mock 登录身份）
// 取证点：改一次档位 → 租户权益集合与功能可达性必须**立即**随之变化（无缓存、无重启依赖）。
//   这是「平台套餐是否真的启用了」最直接的判据：配置面改动必须能穿透到运行期闸门。
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import { query } from '../../src/db.js';
import { seedBillingPlans } from '../helpers/seedBillingPlans.js';
import { resolveEntitlements } from '../../src/billing/entitlements.js';

// 登录身份由用例控制（admin / sales）；其余链路（路由、校验、DB 写入、权益解析）全部真实
vi.mock('../../src/http/auth.js', () => ({ resolveMe: vi.fn() }));
const { resolveMe } = await import('../../src/http/auth.js');
const { createBillingRouter } = await import('../../src/http/billingRoutes.js');

const NS = '__tp_' + process.pid + '_' + Date.now();
const T = NS + '_tenant';
let server = null;
let baseUrl = '';

async function setPlan(planId, role = 'admin') {
  resolveMe.mockReturnValue({ ok: true, role, tenantId: 'system' });
  const res = await fetch(`${baseUrl}/api/admin/tenant-plan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenantId: T, planId }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const planOf = async () => (await query(`SELECT plan FROM crm.tenants WHERE tenant_id=$1`, [T])).rows[0]?.plan;

beforeAll(async () => {
  await seedBillingPlans('tenantPlan.e2e');
  const { queryWrite } = await import('../../src/db.js');
  await queryWrite(
    `INSERT INTO crm.tenants (tenant_id, name, status, plan) VALUES ($1,$1,'active','free')
     ON CONFLICT (tenant_id) DO UPDATE SET plan='free'`, [T]
  );
  const app = express();
  app.use(express.json());
  app.use(createBillingRouter());
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', () => { baseUrl = `http://127.0.0.1:${server.address().port}`; r(); }); });
});

afterAll(async () => { if (server) await new Promise((r) => server.close(r)); });

describe('管理台设档 → 运行期闸门即时生效', () => {
  it('admin 设为 pro：落库且权益立即含 decision_autonomy', async () => {
    const r = await setPlan('pro');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(await planOf()).toBe('pro');
    const e = await resolveEntitlements(T);
    expect(e.has('decision_autonomy')).toBe(true);
  });

  it('admin 改回 starter：权益立即收回（无缓存、无重启）', async () => {
    const r = await setPlan('starter');
    expect(r.status).toBe(200);
    expect(await planOf()).toBe('starter');
    const e = await resolveEntitlements(T);
    expect(e.has('decision_autonomy')).toBe(false);
    expect(e.has('core_crm')).toBe(true);
  });

  it('非法 planId → 400 且不动数据（防静默降级到免费档）', async () => {
    const before = await planOf();
    const r = await setPlan('__no_such_plan__');
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/planId 不存在/);
    expect(await planOf()).toBe(before);
  });

  it('非特权角色（sales）→ 403', async () => {
    const before = await planOf();
    const r = await setPlan('enterprise', 'sales');
    expect(r.status).toBe(403);
    expect(await planOf()).toBe(before);
  });

  it('缺失参数 → 400', async () => {
    resolveMe.mockReturnValue({ ok: true, role: 'admin', tenantId: 'system' });
    const res = await fetch(`${baseUrl}/api/admin/tenant-plan`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tenantId: T }),
    });
    expect(res.status).toBe(400);
  });
});
