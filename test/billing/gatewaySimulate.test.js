// test/billing/gatewaySimulate.test.js — 无凭据 → simulate 分支（mock configStore，不依赖 PG）
import { describe, test, expect, vi } from 'vitest';

vi.mock('../../src/config/configStore.js', () => ({ readConfig: async () => undefined }));
vi.mock('../../src/db.js', () => ({ query: async () => ({ rows: [] }), queryWrite: async () => ({ rows: [] }) }));

const { createPayment } = await import('../../src/billing/domesticGateway.js');

describe('domesticGateway simulate', () => {
  test('无凭据 → simulate:true（开发期可跑，不落真实订单）', async () => {
    const p = await createPayment({ provider: 'wechat', planId: 'pro', tenantId: 't1', mode: 'upgrade' });
    expect(p.simulate).toBe(true);
    expect(p.order).toMatchObject({ tenantId: 't1', planId: 'pro', provider: 'wechat' });
  });
  test('支付宝无凭据 → simulate:true', async () => {
    const p = await createPayment({ provider: 'alipay', planId: 'pro', tenantId: 't1', mode: 'renew' });
    expect(p.simulate).toBe(true);
    expect(p.order.provider).toBe('alipay');
  });
});
