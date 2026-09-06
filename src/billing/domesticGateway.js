// src/billing/domesticGateway.js — 国内支付网关（微信支付 Native + 支付宝 page 支付）
// 凭据来自 config_store['billing-settings']；无凭据走 simulate 模式（开发期可跑，填凭据即生产）。
// 真实下单/验签/解密走 wechatV3.js / alipayPage.js（原生 HTTP 封装，零新增重依赖）。
import { readConfig } from '../config/configStore.js';
import { createSubscription, renewSubscription, upgradeSubscription } from './subscriptionService.js';
import { buildAuthHeader, wechatNativeOrderRequest, aes256gcmDecrypt, verifyWechatCallback } from './wechatV3.js';
import { alipayPagePayRequest, verifyAlipaySign } from './alipayPage.js';
import { createPublicKey, randomUUID } from 'node:crypto';
import { queryWrite } from '../db.js';

const DEFAULTS = {
  enabled_providers: ['wechat', 'alipay'],
  default_provider: 'wechat',
  wechat: { appid: '', mch_id: '', serial_no: '', private_key_pem: '', platform_cert_pem: '', api_v3_key: '', notify_url: '' },
  alipay: { app_id: '', private_key: '', alipay_public_key: '', notify_url: '' },
  stripe: { enabled: false },
};

export async function loadSettings() {
  const row = await readConfig('billing-settings', { tenantId: 'system' });
  const v = row?.value || {};
  return {
    enabled_providers: v.enabled_providers || DEFAULTS.enabled_providers,
    default_provider: v.default_provider || DEFAULTS.default_provider,
    wechat: { ...DEFAULTS.wechat, ...(v.wechat || {}) },
    alipay: { ...DEFAULTS.alipay, ...(v.alipay || {}) },
    stripe: { ...DEFAULTS.stripe, ...(v.stripe || {}) },
  };
}

// 落支付订单（pending），返回内部 id
async function persistOrder(o) {
  const r = await queryWrite(
    `INSERT INTO crm.payment_order (order_id, out_trade_no, tenant_id, plan_id, cycle, mode, provider, amount, status, qr_url, redirect_url)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$10) RETURNING id`,
    [o.order_id, o.out_trade_no, o.tenantId, o.planId, o.cycle, o.mode, o.provider, o.amount, o.qr_url || null, o.redirect_url || null]
  );
  return r.rows[0].id;
}

// 构建支付单：wechat→二维码(code_url)；alipay→跳转收银台(url)；无凭据→simulate
export async function createPayment({ provider, planId, cycle, tenantId, mode = 'upgrade' }) {
  const s = await loadSettings();
  const prov = provider || s.default_provider || 'wechat';
  const order = { tenantId, planId, cycle: cycle || 'monthly', mode, provider: prov };
  const amt = Number(process.env.PAY_TEST_AMT || '99.00');
  if (prov === 'wechat') {
    const w = s.wechat;
    if (!w.appid || !w.mch_id || !w.api_v3_key || !w.serial_no || !w.private_key_pem) return { simulate: true, order };
    const outTradeNo = randomUUID().replace(/-/g, '');
    const orderId = 'WO' + Date.now().toString(36) + outTradeNo.slice(0, 6);
    const code_url = await wechatNativeOrderRequest({
      mchid: w.mch_id, serialNo: w.serial_no, privPem: w.private_key_pem,
      appid: w.appid, notifyUrl: w.notify_url, outTradeNo, totalFee: Math.round(amt * 100),
      description: `订阅-${planId}`,
    });
    await persistOrder({ order_id: orderId, out_trade_no: outTradeNo, tenantId, planId, cycle: order.cycle, mode, provider: 'wechat', amount: amt, qr_url: code_url });
    return { qrUrl: code_url, provider: 'wechat', order: { ...order, outTradeNo, orderId } };
  }
  if (prov === 'alipay') {
    const a = s.alipay;
    if (!a.app_id || !a.private_key) return { simulate: true, order };
    const outTradeNo = randomUUID().replace(/-/g, '');
    const orderId = 'AL' + Date.now().toString(36) + outTradeNo.slice(0, 6);
    const redirectUrl = await alipayPagePayRequest({
      appId: a.app_id, privPem: a.private_key, notifyUrl: a.notify_url,
      outTradeNo, totalAmount: amt, subject: `订阅-${planId}`,
    });
    await persistOrder({ order_id: orderId, out_trade_no: outTradeNo, tenantId, planId, cycle: order.cycle, mode, provider: 'alipay', amount: amt, redirect_url: redirectUrl });
    return { redirectUrl, provider: 'alipay', order: { ...order, outTradeNo, orderId } };
  }
  if (prov === 'stripe') {
    if (!s.stripe?.enabled) return { disabled: true, provider: 'stripe' };
    return { provider: 'stripe', order };
  }
  return { simulate: true, order };
}

// 微信 v3 异步通知：验签（平台证书）+ 解密 resource → 返回明文交易
// 失败（验签不通过）返回 false；成功返回 { out_trade_no, trade_state, transaction_id, amount }
export async function verifyWechatNotify(headers, rawBodyStr, { apiV3Key, platformCertPem }) {
  if (!platformCertPem || !apiV3Key) return false;
  try {
    const pubKey = createPublicKey(platformCertPem);
    const sig = headers['wechatpay-signature'];
    const ts = headers['wechatpay-timestamp'];
    const nonce = headers['wechatpay-nonce'];
    const ok = verifyWechatCallback({ pubKey, ts, nonce, bodyStr: rawBodyStr, sig });
    if (!ok) return false;
    const body = JSON.parse(rawBodyStr);
    const res = body.resource;
    // apiV3Key 支持 base64 字符串（配置存字符串，运行期转 Buffer）或 Buffer（测试直接传）
    const key = Buffer.isBuffer(apiV3Key) ? apiV3Key : Buffer.from(apiV3Key, 'base64');
    const plain = aes256gcmDecrypt(key, res.nonce, res.associated_data || '', res.ciphertext);
    const dec = JSON.parse(plain);
    return { out_trade_no: dec.out_trade_no, trade_state: dec.trade_state, transaction_id: dec.transaction_id, amount: dec.amount?.total };
  } catch { return false; }
}

// 支付宝异步通知：验签（支付宝公钥）→ 返回业务字段
export async function verifyAlipayNotify(payload, { alipayPubKey }) {
  if (!alipayPubKey) return false;
  try {
    const ok = verifyAlipaySign(payload, alipayPubKey);
    if (!ok) return false;
    return { out_trade_no: payload.out_trade_no, trade_status: payload.trade_status, trade_no: payload.trade_no, amount: payload.receipt_amount };
  } catch { return false; }
}

// 支付结果落地：复用订阅状态机；写 online_order_no 锚点（供退款/对账）
export async function applyPaymentResult({ tenantId, planId, mode = 'upgrade', cycle = 'monthly', outTradeNo }) {
  if (!tenantId || !planId) return { ok: false, error: 'missing params' };
  if (mode === 'renew') await renewSubscription(tenantId, planId, cycle, outTradeNo);
  else if (mode === 'upgrade') await upgradeSubscription(tenantId, planId, cycle);
  else await createSubscription(tenantId, planId, cycle);
  if (outTradeNo) {
    await queryWrite(
      `UPDATE crm.tenant_subscription SET online_order_no=$1
       WHERE tenant_id=$2 AND status IN ('active','pending')
         AND id = (SELECT id FROM crm.tenant_subscription WHERE tenant_id=$2 AND status IN ('active','pending') ORDER BY started_at DESC LIMIT 1)`,
      [outTradeNo, tenantId]
    );
  }
  return { ok: true };
}

// 标记订单为已支付（回调成功后由 routes 调用）
export async function markOrderPaid(outTradeNo) {
  await queryWrite(`UPDATE crm.payment_order SET status='paid', paid_at=now() WHERE out_trade_no=$1`, [outTradeNo]);
}

// 标记订单为已退款（退款回调成功后由 routes 调用）
export async function markOrderRefunded(outTradeNo) {
  await queryWrite(`UPDATE crm.payment_order SET status='refunded', refund_at=now() WHERE out_trade_no=$1`, [outTradeNo]);
}
