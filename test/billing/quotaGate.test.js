// test/billing/quotaGate.test.js
import { expect, test, beforeAll } from 'vitest';
import { queryWrite } from '../../src/db.js';
import { seedBillingPlans } from '../helpers/seedBillingPlans.js';
import { enforceTokenQuota, TokenQuotaError } from '../../src/billing/quotaGate.js';

// 唯一租户（无 DELETE 清理，项目铁律：绝对禁止 DELETE）
const T = '__tokg_t_' + process.pid + '_' + Date.now();
const period = new Date().toISOString().slice(0, 7);
beforeAll(async () => {
  await seedBillingPlans(); // 幂等播种完整 5 档
  await queryWrite(`INSERT INTO crm.tenants (tenant_id, name, status, plan) VALUES ($1,'tokg','active','free') ON CONFLICT (tenant_id) DO UPDATE SET plan='free'`, [T]);
  await queryWrite(`INSERT INTO crm.token_accounting (actor, action, tokens_in, tokens_out, source, tenant_id, created_at) VALUES ($1,'a',30000,30000,'llm',$2,now())`, ['alice', T]); // 60000 > 50000
});

test('免费档用量超 included_tokens → 抛 TokenQuotaError', async () => {
  await expect(enforceTokenQuota(T, period)).rejects.toBeInstanceOf(TokenQuotaError);
});

test('付费档（bill 模式）未达安全上限 → 放行', async () => {
  await queryWrite(`UPDATE crm.tenants SET plan='pro' WHERE tenant_id=$1`, [T]);
  await expect(enforceTokenQuota(T, period)).resolves.toMatchObject({ ok: true });
});

test('付费档用量超 token_hard_cap → 抛 TokenQuotaError', async () => {
  // 累加插入高用量（不 DELETE）：原有 60000 + 此处 4000000 = 4060000 > 3000000 硬上限
  await queryWrite(`INSERT INTO crm.token_accounting (actor, action, tokens_in, tokens_out, source, tenant_id, created_at) VALUES ($1,'a',2000000,2000000,'llm',$2,now())`, ['alice', T]);
  await expect(enforceTokenQuota(T, period)).rejects.toBeInstanceOf(TokenQuotaError);
});

test('system 平台租户恒豁免 Token 封顶（对齐席位/权益豁免）', async () => {
  const r = await enforceTokenQuota('system', period);
  expect(r.ok).toBe(true);
  expect(r.exempt).toBe(true);
  expect(r.mode).toBe('unlimited');
});
