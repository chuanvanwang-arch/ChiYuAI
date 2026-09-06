// src/billing/alipayPage.js — 支付宝开放平台 RSA2 签名 / 验签 / page 支付 URL（纯函数 + 网络封装）
// 凭据来自 config_store['billing-settings'].alipay；无凭据由调用方回落 simulate。
import { createSign, createVerify } from 'node:crypto';

// 构造待签名串：过滤 sign/sign_type/空值，按 key 字典序拼接 k=v&k=v
export function buildSignContent(params) {
  return Object.keys(params)
    .filter((k) => k !== 'sign' && k !== 'sign_type' && params[k] !== '' && params[k] != null)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
}

// RSA2（SHA256withRSA）签名，返回带 sign/sign_type 的完整参数
export function signParams(params, privPem) {
  const content = buildSignContent(params);
  const sign = createSign('RSA-SHA256');
  sign.update(content, 'utf8'); sign.end();
  return { ...params, sign: sign.sign(privPem, 'base64'), sign_type: 'RSA2' };
}

// 验签（回调/异步通知）：用支付宝公钥
export function verifyAlipaySign(params, alipayPubPem) {
  const { sign, sign_type, ...rest } = params;
  const content = buildSignContent(rest);
  const v = createVerify('RSA-SHA256');
  v.update(content, 'utf8'); v.end();
  try { return v.verify(alipayPubPem, sign, 'base64'); } catch { return false; }
}

// 构造 page 支付跳转 URL（表单 GET 等效）
export function buildPagePayUrl({ appId, privPem, gateway, returnUrl, notifyUrl, bizContent, method = 'alipay.trade.page.pay' }) {
  const base = {
    app_id: appId,
    method,
    format: 'JSON',
    charset: 'utf-8',
    sign_type: 'RSA2',
    timestamp: new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-'),
    version: '1.0',
    biz_content: JSON.stringify(bizContent),
    ...(returnUrl ? { return_url: returnUrl } : {}),
    ...(notifyUrl ? { notify_url: notifyUrl } : {}),
  };
  const signed = signParams(base, privPem);
  const qs = Object.keys(signed).map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(signed[k])}`).join('&');
  return `${gateway}?${qs}`;
}

// 支付宝 page 支付真实网络下单（返回 redirectUrl）
export async function alipayPagePayRequest({ appId, privPem, gateway, notifyUrl, returnUrl, outTradeNo, totalAmount, subject }) {
  const url = buildPagePayUrl({
    appId, privPem, gateway: gateway || 'https://openapi.alipay.com/gateway.do',
    notifyUrl, returnUrl,
    bizContent: {
      out_trade_no: outTradeNo,
      product_code: 'FAST_INSTANT_TRADE_PAY',
      total_amount: Number(totalAmount).toFixed(2),
      subject: subject || '订阅',
    },
  });
  return url;
}
