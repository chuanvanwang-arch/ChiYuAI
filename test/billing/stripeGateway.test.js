// test/billing/stripeGateway.test.js — Stripe 网关适配器（验签 + Session 构造 + webhook 状态机，T3）
import { test, expect, beforeAll, afterAll } from 'vitest';
import { queryWrite } from '../../src/db.js';
import { verifyWebhook, buildCheckoutSession, handleCheckoutCompleted } from '../../src/billing/stripeGateway.js';

const T = '__stripe_t';
beforeAll(async () => {
  await queryWrite(`INSERT INTO crm.tenants (tenant_id,name,status) VALUES ($1,'t','active') ON CONFLICT (tenant_id) DO NOTHING`, [T]);
});
afterAll(async () => {
  // 禁 DELETE；测试租户用 UPDATE 置 retired 软清理（项目铁律）
  await queryWrite(`UPDATE crm.tenants SET status='retired' WHERE tenant_id=$1`, [T]);
});

test('verifyWebhook 验签失败返回 false（无密钥）', async () => {
  const ok = await verifyWebhook('payload', 'sig', '');
  expect(ok).toBe(false);
});

test('buildCheckoutSession 构造 Stripe Checkout 参数（mock fetch）', async () => {
  const origFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ id: 'cs_test_123', url: 'https://checkout.stripe.com/c/pay/test' }) });
  try {
    const s = await buildCheckoutSession('pro', 'monthly', 'tenant-X', { successUrl: 'http://x/s', cancelUrl: 'http://x/c' });
    expect(s.id).toBe('cs_test_123');
    expect(s.url).toContain('checkout.stripe.com');
  } finally { global.fetch = origFetch; }
});

test('handleCheckoutCompleted 缴费成功触发状态机', async () => {
  const r = await handleCheckoutCompleted({ id: 'cs_test_123', metadata: { tenant_id: T, plan_id: 'pro', mode: 'upgrade' } });
  expect(r.ok).toBe(true);
});
