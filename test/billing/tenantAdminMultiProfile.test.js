// test/billing/tenantAdminMultiProfile.test.js — 一租户多行业画像端到端（T7–T16）
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import { query, queryWrite } from '../../src/db.js';

vi.mock('../../src/http/auth.js', () => ({ resolveMe: vi.fn() }));
const { resolveMe } = await import('../../src/http/auth.js');
const { createBillingRouter } = await import('../../src/http/billingRoutes.js');

const NS = '__mp_' + process.pid + '_' + Date.now();
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
async function subsRow(tenantId) {
  role();
  const d = await (await fetch(`${baseUrl}/api/billing/tenant-subscriptions`)).json();
  return (d.rows || []).find((x) => x.tenant_id === tenantId);
}
const profileOf = async (tenantId) => (await query(`SELECT value FROM crm.config_store WHERE tenant_id=$1 AND key='tenant-profile'`, [tenantId])).rows[0]?.value;
const decisionCount = async (frag) => (await query(`SELECT count(*)::int c FROM crm.decision WHERE rationale LIKE '%' || $1 || '%'`, [frag])).rows[0].c;

const CHEM_TPL = JSON.stringify({ meta: { industry_label: '化工' }, prototypes: { PRODUCT: { label: '化工产品', edgeTypes: ['supplies'] } } });
const EDU_TPL = JSON.stringify({ meta: { industry_label: '培训' }, prototypes: { PRODUCT: { label: '培训产品', edgeTypes: ['teaches'] }, COURSE: { label: '课程' } } });

beforeAll(async () => {
  await queryWrite(`INSERT INTO crm.tenants (tenant_id,name,status,plan) VALUES ($1,$1,'active','free') ON CONFLICT (tenant_id) DO UPDATE SET status='active',plan='free',retired_at=NULL`, [T]);
  await queryWrite(`INSERT INTO crm.tenant_subscription (tenant_id,plan_id,status,started_at,expires_at) VALUES ($1,'free','active',now(),now()+'10 days')`, [T]);
  await queryWrite(`INSERT INTO crm.config_store (tenant_id,key,value) VALUES ('system','tenant-profile-template-chem',$1::jsonb) ON CONFLICT (tenant_id,key) DO UPDATE SET value=EXCLUDED.value`, [CHEM_TPL]);
  await queryWrite(`INSERT INTO crm.config_store (tenant_id,key,value) VALUES ('system','tenant-profile-template-edu',$1::jsonb) ON CONFLICT (tenant_id,key) DO UPDATE SET value=EXCLUDED.value`, [EDU_TPL]);
  const app = express();
  app.use(express.json());
  app.use(createBillingRouter());
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', () => { baseUrl = `http://127.0.0.1:${server.address().port}`; r(); }); });
});
afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  await queryWrite(`DELETE FROM crm.tenants WHERE tenant_id=$1`, [T]).catch(() => {});
  await queryWrite(`DELETE FROM crm.config_store WHERE tenant_id=$1 AND key='tenant-profile'`, [T]).catch(() => {});
});

describe('assign-profile 多行业', () => {
  it('T7 单行业追加 → industries 长度 1', async () => {
    const r = await call('assign-profile', { tenantId: T, templateIds: ['chem'] });
    expect(r.body.ok).toBe(true);
    expect(r.body.industries).toEqual([{ id: 'chem', label: '化工' }]);
    expect((await profileOf(T)).industries.length).toBe(1);
  });
  it('T8 多行业一次性追加 → 长度 2', async () => {
    const r = await call('assign-profile', { tenantId: T, templateIds: ['edu'] });
    expect(r.body.ok).toBe(true);
    expect((await profileOf(T)).industries.length).toBe(2);
  });
  it('T9 同名类型 C 静默覆盖 → conflict_keys 含 PRODUCT，后者覆盖', async () => {
    // 重置为 chem+edu 两个都含 PRODUCT 的状态
    await queryWrite(`DELETE FROM crm.config_store WHERE tenant_id=$1 AND key='tenant-profile'`, [T]);
    const a = await call('assign-profile', { tenantId: T, templateIds: ['chem'] });
    expect(a.body.ok).toBe(true);
    const b = await call('assign-profile', { tenantId: T, templateIds: ['edu'] });
    expect(b.body.ok).toBe(true);
    expect(b.body.merge_meta.conflict_keys).toEqual(['PRODUCT']);
    const v = await profileOf(T);
    expect(v.industries.length).toBe(2);
    expect(v.industries[1].prototypes.PRODUCT.label).toBe('培训产品'); // edu 覆盖 chem
  });
  it('T12 幂等：重复 assign 同 templateIds → noop 长度不变', async () => {
    const before = (await profileOf(T)).industries.length;
    const r = await call('assign-profile', { tenantId: T, templateIds: ['chem', 'edu'] });
    expect(r.body.skipped).toBe(true);
    expect((await profileOf(T)).industries.length).toBe(before);
  });
});

describe('remove-profile', () => {
  it('T10 移除行业 → 长度-1，config_store 行不删（禁物理 DELETE）', async () => {
    const before = (await query(`SELECT count(*)::int c FROM crm.config_store WHERE tenant_id=$1 AND key='tenant-profile'`, [T])).rows[0].c;
    expect(before).toBeGreaterThan(0);
    const r = await call('remove-profile', { tenantId: T, industryId: 'edu' });
    expect(r.body.ok).toBe(true);
    expect(r.body.removed.id).toBe('edu');
    expect((await profileOf(T)).industries.length).toBe(1);
    const after = (await query(`SELECT count(*)::int c FROM crm.config_store WHERE tenant_id=$1 AND key='tenant-profile'`, [T])).rows[0].c;
    expect(after).toBe(before); // 行数不减少
  });
  it('T10b 移除不存在的行业 → 400', async () => {
    expect((await call('remove-profile', { tenantId: T, industryId: 'nope' })).status).toBe(400);
  });
});

describe('订阅全景行业列', () => {
  it('T11 tenant-subscriptions 返回 industries 数组', async () => {
    const row = await subsRow(T);
    expect(Array.isArray(row.profile_summary.industries)).toBe(true);
    expect(row.profile_summary.industries.some((i) => i.id === 'chem')).toBe(true);
  });
});

describe('权限与保护', () => {
  it('T13 system 租户 assign/remove → 400', async () => {
    expect((await call('assign-profile', { tenantId: 'system', templateIds: ['chem'] })).status).toBe(400);
    expect((await call('remove-profile', { tenantId: 'system', industryId: 'chem' })).status).toBe(400);
  });
  it('T14 非特权角色 → 403', async () => {
    expect((await call('assign-profile', { tenantId: T, templateIds: ['chem'] }, 'sales')).status).toBe(403);
    expect((await call('remove-profile', { tenantId: T, industryId: 'chem' }, 'sales')).status).toBe(403);
  });
  it('T14b 参数缺失 → 400', async () => {
    expect((await call('assign-profile', { tenantId: T })).status).toBe(400);
    expect((await call('remove-profile', { tenantId: T })).status).toBe(400);
  });
});

describe('决策第0闸', () => {
  it('T15 assign/remove 各自落 decision 行（rationale 含 industry id）', async () => {
    await queryWrite(`DELETE FROM crm.config_store WHERE tenant_id=$1 AND key='tenant-profile'`, [T]);
    await call('assign-profile', { tenantId: T, templateIds: ['chem'] });
    expect(await decisionCount('profile+=chem')).toBeGreaterThanOrEqual(1);
    await call('remove-profile', { tenantId: T, industryId: 'chem' });
    expect(await decisionCount('profile-=chem')).toBeGreaterThanOrEqual(1);
  });
});
