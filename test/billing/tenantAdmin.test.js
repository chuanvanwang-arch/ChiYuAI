// test/billing/tenantAdmin.test.js — 租户管理操作台端到端（真实 express + 真实库，mock 登录身份）
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import { query, queryWrite } from '../../src/db.js';
import { seedBillingPlans } from '../helpers/seedBillingPlans.js';

vi.mock('../../src/http/auth.js', () => ({ resolveMe: vi.fn() }));
const { resolveMe } = await import('../../src/http/auth.js');
const { createBillingRouter } = await import('../../src/http/billingRoutes.js');

const NS = '__ta_' + process.pid + '_' + Date.now();
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
const col = async (c, val) => (await query(`SELECT ${c} FROM crm.tenants WHERE tenant_id=$1`, [val])).rows[0]?.[c];
const subStatus = async (val) => (await query(`SELECT status FROM crm.tenant_subscription WHERE tenant_id=$1 ORDER BY started_at DESC LIMIT 1`, [val])).rows[0]?.status;
const decisionCount = async (frag) => (await query(`SELECT count(*)::int c FROM crm.decision WHERE rationale LIKE '%' || $1 || '%'`, [frag])).rows[0].c;

beforeAll(async () => {
  await seedBillingPlans('tenantAdmin');
  await queryWrite(`INSERT INTO crm.tenants (tenant_id,name,status,plan) VALUES ($1,$1,'active','free') ON CONFLICT (tenant_id) DO UPDATE SET status='active',plan='free',retired_at=NULL`, [T]);
  await queryWrite(`INSERT INTO crm.tenant_subscription (tenant_id,plan_id,status,started_at,expires_at) VALUES ($1,'free','active',now(),now()+'10 days')`, [T]);
  const demoTpl = JSON.stringify({ meta: { template_id: 'demo', industry_label: '演示' }, prototypes: { DEMO_CUST: { label: '演示客户', flow: ['lead', 'won'] } } });
  await queryWrite(`INSERT INTO crm.config_store (tenant_id,key,value) VALUES ('system','tenant-profile-template-demo',$1::jsonb) ON CONFLICT (tenant_id,key) DO UPDATE SET value=EXCLUDED.value`, [demoTpl]);
  const app = express();
  app.use(express.json());
  app.use(createBillingRouter());
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', () => { baseUrl = `http://127.0.0.1:${server.address().port}`; r(); }); });
});
afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  await queryWrite(`DELETE FROM crm.tenants WHERE tenant_id=$1`, [T]).catch(() => {});
});

describe('权限与保护', () => {
  it('T1 非特权角色 → 403', async () => { expect((await call('freeze', { tenantId: T }, 'sales')).status).toBe(403); });
  it('T2 system 租户硬拒（freeze/cancel/change-plan/assign-profile）', async () => {
    expect((await call('freeze', { tenantId: 'system' })).status).toBe(400);
    expect((await call('cancel', { tenantId: 'system' })).status).toBe(400);
    expect((await call('change-plan', { tenantId: 'system', planId: 'pro' })).status).toBe(400);
    expect((await call('assign-profile', { tenantId: 'system', templateId: 'demo' })).status).toBe(400);
  });
  it('T2b 缺失参数 → 400', async () => { expect((await call('freeze', {})).status).toBe(400); });
});

describe('冻结/解冻链路', () => {
  it('T3 freeze → 租户置 suspended', async () => {
    expect((await call('freeze', { tenantId: T })).body.ok).toBe(true);
    expect(await col('status', T)).toBe('suspended');
  });
  it('T4 unfreeze → 恢复 active', async () => {
    expect((await call('unfreeze', { tenantId: T })).body.ok).toBe(true);
    expect(await col('status', T)).toBe('active');
  });
  it('T4b 重复 freeze 幂等 noop', async () => {
    await call('freeze', { tenantId: T });
    const r = await call('freeze', { tenantId: T });
    expect(r.body.noop).toBe(true);
    await call('unfreeze', { tenantId: T });
  });
});

describe('延期', () => {
  it('T5 合法天数 → expires_at 顺延', async () => {
    const before = (await query(`SELECT expires_at FROM crm.tenant_subscription WHERE tenant_id=$1 ORDER BY started_at DESC LIMIT 1`, [T])).rows[0].expires_at;
    expect((await call('extend', { tenantId: T, days: 30 })).body.ok).toBe(true);
    const after = (await query(`SELECT expires_at FROM crm.tenant_subscription WHERE tenant_id=$1 ORDER BY started_at DESC LIMIT 1`, [T])).rows[0].expires_at;
    expect(new Date(after) - new Date(before)).toBe(30 * 86400000);
  });
  it('T5b days=null/0/400/abc → 400（含 null 不静默置 0）', async () => {
    expect((await call('extend', { tenantId: T, days: null })).status).toBe(400);
    expect((await call('extend', { tenantId: T, days: 0 })).status).toBe(400);
    expect((await call('extend', { tenantId: T, days: 400 })).status).toBe(400);
    expect((await call('extend', { tenantId: T, days: 'abc' })).status).toBe(400);
  });
  it('T5c 无订阅 → 400', async () => {
    const U = NS + '_nosub';
    await queryWrite(`INSERT INTO crm.tenants (tenant_id,name,status,plan) VALUES ($1,$1,'active','free') ON CONFLICT (tenant_id) DO NOTHING`, [U]);
    expect((await call('extend', { tenantId: U, days: 30 })).status).toBe(400);
  });
});

describe('退订（软）', () => {
  it('T6 cancel → retired + 订阅 cancelled，行数不减少（禁删）', async () => {
    const tenantBefore = (await query(`SELECT count(*)::int c FROM crm.tenants WHERE tenant_id=$1`, [T])).rows[0].c;
    const subBefore = (await query(`SELECT count(*)::int c FROM crm.tenant_subscription WHERE tenant_id=$1`, [T])).rows[0].c;
    const cR = await call('cancel', { tenantId: T });
    expect(cR.body.ok).toBe(true);
    expect(await col('status', T)).toBe('retired');
    expect(await subStatus(T)).toBe('canceled');
    expect((await query(`SELECT count(*)::int c FROM crm.tenants WHERE tenant_id=$1`, [T])).rows[0].c).toBe(tenantBefore);
    expect((await query(`SELECT count(*)::int c FROM crm.tenant_subscription WHERE tenant_id=$1`, [T])).rows[0].c).toBe(subBefore);
  });
  it('T6b retired 不可解冻', async () => { expect((await call('unfreeze', { tenantId: T })).status).toBe(400); });
});

describe('改套餐', () => {
  it('T7 合法档位 → tenants.plan 更新 + 新订阅 upgraded_from=admin-grant', async () => {
    const U = NS + '_plan';
    await queryWrite(`INSERT INTO crm.tenants (tenant_id,name,status,plan) VALUES ($1,$1,'active','free') ON CONFLICT (tenant_id) DO UPDATE SET status='active',plan='free'`, [U]);
    await queryWrite(`INSERT INTO crm.tenant_subscription (tenant_id,plan_id,status,started_at,expires_at) VALUES ($1,'free','active',now(),now()+'10 days')`, [U]);
    const cpR = await call('change-plan', { tenantId: U, planId: 'pro' });
    expect(cpR.body.ok).toBe(true);
    expect((await query(`SELECT plan FROM crm.tenants WHERE tenant_id=$1`, [U])).rows[0].plan).toBe('pro');
    expect((await query(`SELECT upgraded_from FROM crm.tenant_subscription WHERE tenant_id=$1 ORDER BY started_at DESC LIMIT 1`, [U])).rows[0].upgraded_from).toBe('admin-grant');
  });
  it('T7b 非法 planId → 400', async () => { expect((await call('change-plan', { tenantId: T, planId: '__nope__' })).status).toBe(400); });
});

describe('行业画像分配', () => {
  it('T8 分配 → 租户 tenant-profile 落 v2 industries[]（含模板 prototypes + meta.template_id）', async () => {
    const U = NS + '_prof';
    await queryWrite(`INSERT INTO crm.tenants (tenant_id,name,status,plan) VALUES ($1,$1,'active','free') ON CONFLICT (tenant_id) DO NOTHING`, [U]);
    const r = await call('assign-profile', { tenantId: U, templateIds: ['demo'] });
    expect(r.body.ok).toBe(true);
    expect(r.body.industries[0]).toMatchObject({ id: 'demo', label: '演示' });
    const v = (await query(`SELECT value FROM crm.config_store WHERE tenant_id=$1 AND key='tenant-profile'`, [U])).rows[0].value;
    expect(v.version).toBe(2);
    expect(Array.isArray(v.industries)).toBe(true);
    expect(v.industries[0].id).toBe('demo');
    expect(v.industries[0].assigned_from_template_id).toBe('demo');
    expect(v.industries[0].prototypes.DEMO_CUST.label).toBe('演示客户');
  });
  it('T8b 不存在模板 → 400', async () => { expect((await call('assign-profile', { tenantId: T, templateIds: ['__x__'] })).status).toBe(400); });
});

describe('第0闸', () => {
  it('T9 每个写动作落 decision 行（CALIBRATION_CHANGE）', async () => {
    const U = NS + '_gate';
    await queryWrite(`INSERT INTO crm.tenants (tenant_id,name,status,plan) VALUES ($1,$1,'active','free') ON CONFLICT (tenant_id) DO NOTHING`, [U]);
    await queryWrite(`INSERT INTO crm.tenant_subscription (tenant_id,plan_id,status,started_at,expires_at) VALUES ($1,'free','active',now(),now()+'10 days')`, [U]);
    const c0 = await decisionCount('tenant:' + U);
    await call('freeze', { tenantId: U });
    await call('extend', { tenantId: U, days: 5 });
    await call('change-plan', { tenantId: U, planId: 'starter' });
    await call('assign-profile', { tenantId: U, templateIds: ['demo'] });
    await call('cancel', { tenantId: U });
    const c1 = await decisionCount('tenant:' + U);
    expect(c1 - c0).toBe(5);
  });
});

describe('订阅全景 profile_summary', () => {
  it('T10 tenant-subscriptions 含 profile_summary', async () => {
    role('admin');
    const profVal = JSON.stringify({ meta: { industry_label: '演示' }, prototypes: { X: {} } });
    await queryWrite(`INSERT INTO crm.config_store (tenant_id,key,value) VALUES ($1,'tenant-profile',$2::jsonb) ON CONFLICT (tenant_id,key) DO UPDATE SET value=EXCLUDED.value`, [T, profVal]);
    const res = await fetch(`${baseUrl}/api/billing/tenant-subscriptions`, { headers: {} });
    const j = await res.json();
    const row = (j.rows || []).find((r) => r.tenant_id === T);
    expect(row).toBeTruthy();
    expect(row.profile_summary).toBeTruthy();
    expect(Array.isArray(row.profile_summary.industries)).toBe(true);
    expect(row.profile_summary.industries[0].label).toBe('演示');
  });
});
