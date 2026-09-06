// test/billing/sandboxE2E.test.js — 离线沙箱确认（不连外网，用动态密钥对模拟微信/支付宝沙箱网关）
// 验证：填 config_store['billing-settings'] → createPayment 走真实分支（非 simulate）→ 落 payment_order(pending)
//       → 异步回调验签 → applyPaymentResult → payment_order(paid) + 订阅状态机
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { queryWrite, query } from '../../src/db.js';
import { aes256gcmEncrypt } from '../../src/billing/wechatV3.js';
import { signParams } from '../../src/billing/alipayPage.js';

// ── 动态生成沙箱 RSA 密钥对（商户私钥 + 平台公钥）──
const kp = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const privPem = kp.privateKey;
const pubPem = kp.publicKey;
const apiV3Key = randomBytes(32); // Buffer（aes256gcm 接受 Buffer）
const serialNo = randomBytes(8).toString('hex').toUpperCase();

const TENANT = '__sandbox';
const PLAN_WECHAT = 'pro';
const PLAN_ALIPAY = 'starter';

// 模拟生产：billing-settings 配置（含真实字段名 api_v3_key）
const SANDBOX_SETTINGS = {
  enabled_providers: ['wechat', 'alipay'],
  default_provider: 'wechat',
  wechat: {
    appid: 'wxSandboxAppid',
    mch_id: '190000Sandbox',
    serial_no: serialNo,
    api_v3_key: apiV3Key.toString('base64'), // 配置里是 base64 字符串；domesticGateway 透传给 crypto 时由调用方转 Buffer
    private_key_pem: privPem,
    platform_cert_pem: pubPem, // 沙箱用公钥 PEM 验签（生产为 X509 证书，createPublicKey 兼容）
    notify_url: 'https://sandbox.example.com/api/billing/wechat/notify',
  },
  alipay: {
    app_id: '2021SandboxAppid',
    private_key: privPem,
    alipay_public_key: pubPem,
    notify_url: 'https://sandbox.example.com/api/billing/alipay/notify',
  },
  stripe: { enabled: false },
};

// mock configStore.readConfig：billing-settings 返回沙箱；billing-plans 返回含 pro/starter 的档位
vi.mock('../../src/config/configStore.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    readConfig: vi.fn(async (key) => {
      if (key === 'billing-settings') return { value: SANDBOX_SETTINGS };
      if (key === 'billing-plans') return { value: [
        { plan_id: 'pro', included_seats: 10, seat_unit_price: 100, included_tokens: 1000000, token_overage_unit_price: 0.01, entitlements: ['crm'], token_overage_mode: 'bill', token_hard_cap: 3000000 },
        { plan_id: 'starter', included_seats: 5, seat_unit_price: 0, included_tokens: 600000, token_overage_unit_price: 0.01, entitlements: ['crm'], token_overage_mode: 'bill', token_hard_cap: 600000 },
      ] };
      return null;
    }),
  };
});

// mock fetch：微信 native 下单返回明文 code_url（沙箱网关行为）
vi.stubGlobal('fetch', vi.fn(async (url) => {
  if (String(url).includes('/v3/pay/transactions/native')) {
    return { ok: true, json: async () => ({ code_url: 'weixin://wxpay/bizpayurl?pr=sandbox_' + Date.now() }) };
  }
  return { ok: false, text: async () => 'not found' };
}));

// 延迟 import（确保 mock 生效）
const { createPayment, verifyWechatNotify, verifyAlipayNotify, applyPaymentResult, markOrderPaid } = await import('../../src/billing/domesticGateway.js');

beforeAll(async () => {
  await queryWrite(`INSERT INTO crm.tenants (tenant_id, name, status, plan) VALUES ($1,'sandbox','active','free') ON CONFLICT (tenant_id) DO UPDATE SET plan='free'`, [TENANT]);
});
afterAll(async () => {
  await queryWrite(`DELETE FROM crm.payment_order WHERE tenant_id=$1`, [TENANT]);
  await queryWrite(`DELETE FROM crm.tenant_subscription WHERE tenant_id=$1`, [TENANT]);
  await queryWrite(`DELETE FROM crm.tenants WHERE tenant_id=$1`, [TENANT]);
});

// 简化：直接用 node:crypto 在测试内签名回调（避免循环依赖）
import { createSign } from 'node:crypto';
function signWechatCallbackHeader(priv, ts, nonce, bodyStr) {
  const s = createSign('RSA-SHA256');
  s.update(`${ts}\n${nonce}\n${bodyStr}\n`);
  s.end();
  return s.sign(priv, 'base64');
}

describe('沙箱确认：真实支付全链路（离线 mock 网关）', () => {
  it('微信：填 api_v3_key 配置后 createPayment 走真实分支（非 simulate）并落 payment_order(pending)', async () => {
    const r = await createPayment({ provider: 'wechat', planId: PLAN_WECHAT, cycle: 'monthly', tenantId: TENANT, mode: 'upgrade' });
    expect(r.simulate).toBeFalsy();
    expect(r.provider).toBe('wechat');
    expect(r.qrUrl).toContain('weixin://wxpay');
    const o = await query(`SELECT status, provider, amount FROM crm.payment_order WHERE out_trade_no=$1`, [r.order.outTradeNo]);
    expect(o.rows[0].status).toBe('pending');
    expect(o.rows[0].provider).toBe('wechat');
  });

  it('微信：异步回调验签 + 解密 + 落单 + 订阅状态机（upgrade）', async () => {
    const r = await createPayment({ provider: 'wechat', planId: PLAN_WECHAT, cycle: 'monthly', tenantId: TENANT, mode: 'upgrade' });
    const outTradeNo = r.order.outTradeNo;
    const transactionId = 'wxSandboxTxn' + Date.now();
    const plaintext = JSON.stringify({ out_trade_no: outTradeNo, trade_state: 'SUCCESS', transaction_id: transactionId, amount: { total: 9900 } });
    const nonce = randomBytes(12).toString('base64');
    const cipher = aes256gcmEncrypt(apiV3Key, nonce, 'transaction', plaintext);
    const body = JSON.stringify({ id: 'evt1', create_time: new Date().toISOString(), resource: { ciphertext: cipher, nonce, associated_data: 'transaction' } });
    const ts = Math.floor(Date.now() / 1000).toString();
    const cbNonce = randomBytes(16).toString('hex');
    const sig = signWechatCallbackHeader(privPem, ts, cbNonce, body);
    const headers = { 'wechatpay-signature': sig, 'wechatpay-timestamp': ts, 'wechatpay-nonce': cbNonce };
    const dec = await verifyWechatNotify(headers, body, { apiV3Key, platformCertPem: pubPem });
    expect(dec).toBeTruthy();
    expect(dec.out_trade_no).toBe(outTradeNo);
    expect(dec.trade_state).toBe('SUCCESS');
    // 忠实于生产 notify 路由顺序：先 markOrderPaid，再 applyPaymentResult
    await markOrderPaid(outTradeNo);
    const applied = await applyPaymentResult({ tenantId: TENANT, planId: PLAN_WECHAT, mode: 'upgrade', outTradeNo });
    expect(applied.ok).toBe(true);
    const po = await query(`SELECT status FROM crm.payment_order WHERE out_trade_no=$1`, [outTradeNo]);
    expect(po.rows[0].status).toBe('paid');
    const sub = await query(`SELECT status, plan_id, online_order_no FROM crm.tenant_subscription WHERE tenant_id=$1 ORDER BY started_at DESC LIMIT 1`, [TENANT]);
    expect(sub.rows[0].status).toBe('active');
    expect(sub.rows[0].plan_id).toBe(PLAN_WECHAT);
    expect(sub.rows[0].online_order_no).toBe(outTradeNo);
    const t = await query(`SELECT plan FROM crm.tenants WHERE tenant_id=$1`, [TENANT]);
    expect(t.rows[0].plan).toBe(PLAN_WECHAT);
  });

  it('支付宝：createPayment 返回 redirectUrl（非 simulate）', async () => {
    const r = await createPayment({ provider: 'alipay', planId: PLAN_ALIPAY, cycle: 'monthly', tenantId: TENANT, mode: 'renew' });
    expect(r.simulate).toBeFalsy();
    expect(r.provider).toBe('alipay');
    expect(r.redirectUrl).toContain('openapi.alipay.com/gateway.do');
  });

  it('支付宝：异步回调验签（RSA2）通过', async () => {
    const payload = { out_trade_no: 'alSandbox' + Date.now(), trade_status: 'TRADE_SUCCESS', trade_no: 'alTxn1', receipt_amount: '99.00' };
    const signed = signParams(payload, privPem);
    const verified = await verifyAlipayNotify(signed, { alipayPubKey: pubPem });
    expect(verified).toBeTruthy();
    expect(verified.out_trade_no).toBe(payload.out_trade_no);
    expect(verified.trade_status).toBe('TRADE_SUCCESS');
  });

  it('回归：无凭据（api_v3_key 为空）时微信走 simulate', async () => {
    // 临时替换配置读取为缺凭据
    const { readConfig } = await import('../../src/config/configStore.js');
    const orig = readConfig;
    // 直接验证当 wechat.api_v3_key 缺失，createPayment 的逻辑分支
    const emptyW = { ...SANDBOX_SETTINGS, wechat: { ...SANDBOX_SETTINGS.wechat, api_v3_key: '', appid: '', mch_id: '', serial_no: '', private_key_pem: '' } };
    readConfig.mockImplementation(async (key) => key === 'billing-settings' ? { value: emptyW } : null);
    const r = await createPayment({ provider: 'wechat', planId: PLAN_WECHAT, tenantId: TENANT });
    expect(r.simulate).toBe(true);
    readConfig.mockImplementation(async (key) => key === 'billing-settings' ? { value: SANDBOX_SETTINGS } : null);
    void orig;
  });
});
