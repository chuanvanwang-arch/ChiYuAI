// test/billing/planQuotaFields.test.js
import { readFileSync } from 'fs';
import { expect, test } from 'vitest';
import { getPlan } from '../../src/billing/billingService.js';
import { seedBillingPlans } from '../helpers/seedBillingPlans.js';

test('seed 文件含 token_overage_mode / token_hard_cap 字段', () => {
  const sql = readFileSync('db/seed-billing-config.sql', 'utf8');
  expect(sql).toContain('token_overage_mode');
  expect(sql).toContain('token_hard_cap');
});

test('getPlan 返回 token_overage_mode / token_hard_cap', async () => {
  await seedBillingPlans(); // 幂等播种完整 5 档，保证运行顺序无关
  const f = await getPlan('any-tenant');
  expect(f.token_overage_mode).toBe('block');
  expect(f.token_hard_cap).toBeNull();
  const p = await getPlan('pro-tenant'); // plan 缺省回退首档，此处用 tenant 无 plan → default free；直接断言字段存在
  expect(p).toHaveProperty('token_overage_mode');
});
