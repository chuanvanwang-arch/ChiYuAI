// src/billing/refundService.js — 退款编排（微信/支付宝退款 + 写 payment_order→refunded + 订阅转 grace）
// fail-open：网关异常由调用方（routes）捕获，不阻断主链路；仅状态落地。
import { query, queryWrite } from '../db.js';
import { readConfig } from '../config/configStore.js';
import { buildAuthHeader } from './wechatV3.js';
import { signParams } from './alipayPage.js';

export async function requestRefund({ outTradeNo, reason = '', amount, gatewayFn }) {
  const po = await query(`SELECT * FROM crm.payment_order WHERE out_trade_no=$1`, [outTradeNo]);
  if (!po.rows[0]) return { ok: false, error: 'order not found' };
  if (po.rows[0].status !== 'paid') return { ok: false, error: 'order not paid' };
  const s = (await readConfig('billing-settings', { tenantId: 'system' }))?.value || {};
  const prov = po.rows[0].provider;
  let res;
  if (gatewayFn) res = await gatewayFn();                                   // 测试注入
  else if (prov === 'wechat') res = await wechatRefund(po.rows[0], s.wechat, reason);
  else if (prov === 'alipay') res = await alipayRefund(po.rows[0], s.alipay, reason);
  else return { ok: false, error: 'unsupported provider' };
  if (res?.status === 'SUCCESS' || res?.ok) {
    await queryWrite(`UPDATE crm.payment_order SET status='refunded', refund_at=now() WHERE out_trade_no=$1`, [outTradeNo]);
    await queryWrite(`UPDATE crm.tenant_subscription SET status='grace', grace_until=now()+interval '7 days' WHERE online_order_no=$1`, [outTradeNo]);
    return { ok: true, refund_id: res.refund_id, provider: prov };
  }
  return { ok: false, error: 'refund not success' };
}

async function wechatRefund(order, w, reason) {
  const url = '/v3/refund/domestic/refunds';
  const body = JSON.stringify({
    out_trade_no: order.out_trade_no,
    out_refund_no: 'rf' + Date.now(),
    reason: reason || '用户申请退款',
    amount: { refund: Math.round(Number(order.amount) * 100), total: Math.round(Number(order.amount) * 100), currency: 'CNY' },
  });
  const auth = buildAuthHeader({ mchid: w.mch_id, serialNo: w.serial_no, privPem: w.private_key_pem, method: 'POST', url, body });
  const r = await fetch(`https://api.mch.weixin.qq.com${url}`, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json', Accept: 'application/json' },
    body,
  });
  const j = await r.json();
  return { refund_id: j.out_refund_no, status: j.status }; // SUCCESS / PROCESSING / ABNORMAL
}

async function alipayRefund(order, a, reason) {
  const params = {
    app_id: a.app_id, method: 'alipay.trade.refund', charset: 'utf-8', sign_type: 'RSA2',
    timestamp: new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-'), version: '1.0',
    biz_content: JSON.stringify({ out_trade_no: order.out_trade_no, refund_amount: Number(order.amount).toFixed(2), refund_reason: reason || '用户申请退款' }),
  };
  const signed = signParams(params, a.private_key);
  const qs = Object.keys(signed).map((k) => `${k}=${encodeURIComponent(signed[k])}`).join('&');
  const r = await fetch(`https://openapi.alipay.com/gateway.do?${qs}`);
  const j = await r.json();
  const resp = j.alipay_trade_refund_response;
  return { refund_id: resp?.trade_no, status: resp?.code === '10000' ? 'SUCCESS' : 'FAIL' };
}
