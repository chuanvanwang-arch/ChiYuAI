// test/billing/subscriptionService.test.js — 订阅状态机 + 实时费用 + 模块归因（T2）
import { test, expect, beforeAll, afterAll } from 'vitest';
import { query, queryWrite } from '../../src/db.js';
import { createSubscription, renewSubscription, upgradeSubscription, expireSweep, computeLiveCost, bumpModuleUsage } from '../../src/billing/subscriptionService.js';

const T = '__sub_test';
beforeAll(async () => {
  await queryWrite(`INSERT INTO crm.tenants (tenant_id,name,status) VALUES ($1,'t','active') ON CONFLICT (tenant_id) DO NOTHING`, [T]);
});
afterAll(async () => {
  // 禁 DELETE；测试租户数据用软清理：UPDATE 置 retired（项目铁律）
  await queryWrite(`UPDATE crm.tenants SET status='retired' WHERE tenant_id=$1`, [T]);
});

test('createSubscription 生成 pending 订阅', async () => {
  const s = await createSubscription(T, 'pro', 'monthly');
  expect(s.status).toBe('pending');
  expect(s.plan_id).toBe('pro');
});

test('renewSubscription 延长 expires_at', async () => {
  const s = await createSubscription(T, 'pro', 'monthly');
  const before = s.expires_at;
  const r = await renewSubscription(T, 'pro', 'monthly');
  expect(new Date(r.expires_at) > new Date(before)).toBe(true);
});

test('upgradeSubscription 切换 plan + 记录 upgraded_from', async () => {
  await queryWrite(`UPDATE crm.tenants SET plan='starter' WHERE tenant_id=$1`, [T]);
  const s = await createSubscription(T, 'starter', 'monthly');
  const u = await upgradeSubscription(T, 'pro');
  expect(u.plan_id).toBe('pro');
  expect(u.upgraded_from).toBe('starter');
});

test('expireSweep 将过期订阅转 expired + 回落 free', async () => {
  // 造一条 expires_at 已过的订阅
  await queryWrite(`INSERT INTO crm.tenant_subscription (tenant_id,plan_id,status,expires_at)
    VALUES ($1,'pro','active',now()-interval '1 day')`, [T]);
  const r = await expireSweep();
  expect(r.some(x => x.tenant_id === T)).toBe(true);
  const t = await query(`SELECT plan FROM crm.tenants WHERE tenant_id=$1`, [T]);
  expect(['free', null].includes(t.rows[0]?.plan)).toBe(true);
});

test('computeLiveCost 返回实时费用', async () => {
  const c = await computeLiveCost(T);
  expect(typeof c.total_fee).toBe('number');
  expect(c).toHaveProperty('token_in');
  expect(c).toHaveProperty('seat_count');
});

test('bumpModuleUsage 按(tenant,module,period)累计', async () => {
  // 复位该行保证用例幂等（禁 DELETE 铁律：UPDATE 归零而非删行）
  await queryWrite(`UPDATE crm.module_usage SET calls=0,tokens_in=0,tokens_out=0 WHERE tenant_id=$1 AND module='ai_agents'`, [T]);
  await bumpModuleUsage(T, 'ai_agents', { calls: 1, tokensIn: 100, tokensOut: 50 });
  const r = await query(`SELECT calls, tokens_in::int, tokens_out::int FROM crm.module_usage WHERE tenant_id=$1 AND module='ai_agents'`, [T]);
  expect(r.rows[0].calls).toBe(1);
  expect(r.rows[0].tokens_in).toBe(100);
});
