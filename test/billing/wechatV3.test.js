// test/billing/wechatV3.test.js — 微信 v3 签名/验签/AES-GCM 纯函数（无 PG）
// 使用运行时动态生成的 RSA 密钥对，避免硬编码密钥进仓库；仅验证算法往返正确性。
import { describe, test, expect } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import {
  generateSignature, buildAuthHeader, verifyWechatSignature,
  aes256gcmDecrypt, aes256gcmEncrypt,
} from '../../src/billing/wechatV3.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
const vk = publicKey;

describe('wechatV3 crypto', () => {
  test('generateSignature 确定性 + 可验签', () => {
    const ts = '1700000000', nonce = 'abc', method = 'POST', url = '/v3/pay/transactions/native', body = '{}';
    const sig = generateSignature({ privPem, method, url, ts, nonce, body });
    const ok = verifyWechatSignature({ pubKey: vk, ts, nonce, method, url, body, sig });
    expect(ok).toBe(true);
  });
  test('buildAuthHeader 格式 WECHATPAY2-SHA256-RSA2048 ...', () => {
    const h = buildAuthHeader({ mchid: 'm1', serialNo: 's1', privPem, method: 'POST', url: '/x', body: '{}' });
    expect(h).toContain('WECHATPAY2-SHA256-RSA2048');
    expect(h).toContain('mchid="m1"');
    expect(h).toContain('serial_no="s1"');
  });
  test('aes256gcmDecrypt 往返', () => {
    const key = 'k'.repeat(32);
    const nonce = 'n'.repeat(12);
    const ad = 'a';
    const ct = aes256gcmEncrypt(key, nonce, ad, 'hello');
    expect(aes256gcmDecrypt(key, nonce, ad, ct)).toBe('hello');
  });
});
