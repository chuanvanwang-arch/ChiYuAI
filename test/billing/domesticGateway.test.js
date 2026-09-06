import { describe, it, expect } from 'vitest';
import { verifyWechatNotify, verifyAlipayNotify, applyPaymentResult } from '../../src/billing/domesticGateway.js';

describe('domesticGateway 单元', () => {
  it('verifyWechatNotify 无平台证书/api_v3_key 返回 false', async () => {
    expect(await verifyWechatNotify({}, '{}', {})).toBe(false);
    expect(await verifyWechatNotify({}, '{}', { apiV3Key: '', platformCertPem: '' })).toBe(false);
  });
  it('verifyAlipayNotify 无支付宝公钥返回 false', async () => {
    expect(await verifyAlipayNotify({ out_trade_no: 'x' }, {})).toBe(false);
  });
  it('applyPaymentResult 缺参返回 ok:false', async () => {
    const r = await applyPaymentResult({ tenantId: null, planId: null });
    expect(r.ok).toBe(false);
  });
});
