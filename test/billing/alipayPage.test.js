// test/billing/alipayPage.test.js — 支付宝 RSA2 签名/验签/URL 纯函数（无 PG）
// 运行时动态生成密钥对，避免硬编码进仓库；仅验证算法往返正确性。
import { describe, test, expect } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { buildSignContent, signParams, verifyAlipaySign, buildPagePayUrl } from '../../src/billing/alipayPage.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const pubPem = publicKey.export({ type: 'spki', format: 'pem' });

describe('alipay RSA2', () => {
  test('buildSignContent 排序拼接（去 sign/sign_type/空值）', () => {
    const c = buildSignContent({ b: '2', a: '1', sign: 'x', sign_type: 'RSA2', empty: '' });
    expect(c).toBe('a=1&b=2');
  });
  test('signParams + verifyAlipaySign 往返', () => {
    const params = { app_id: '1', method: 'alipay.trade.page.pay', charset: 'utf-8', timestamp: '2026-09-05 00:00:00' };
    const signed = signParams(params, privPem);
    expect(signed.sign).toBeTruthy();
    const ok = verifyAlipaySign({ ...params, sign: signed.sign, sign_type: 'RSA2' }, pubPem);
    expect(ok).toBe(true);
  });
  test('buildPagePayUrl 含网关+签名+biz_content', () => {
    const url = buildPagePayUrl({
      appId: '1', privPem, gateway: 'https://openapi.alipay.com/gateway.do',
      bizContent: { out_trade_no: 'ot1', total_amount: '99.00', subject: 'pro' },
    });
    expect(url).toContain('https://openapi.alipay.com/gateway.do');
    expect(url).toContain('sign=');
    expect(url).toContain('biz_content=');
    expect(decodeURIComponent(url)).toContain('"out_trade_no":"ot1"');
  });
});
