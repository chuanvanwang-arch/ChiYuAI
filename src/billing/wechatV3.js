// src/billing/wechatV3.js — 微信支付 v3 签名 / 验签 / AES-256-GCM 加解密（纯函数 + 网络封装）
// 凭据来自 config_store['billing-settings'].wechat；无凭据由调用方回落 simulate。
import { createSign, createVerify, createPrivateKey, createPublicKey, randomBytes, createDecipheriv, createCipheriv } from 'node:crypto';

// 微信 v3 签名串：METHOD\nURL\nTIMESTAMP\nNONCE_STR\nBODY\n
export function generateSignature({ privPem, method, url, ts, nonce, body = '' }) {
  const message = `${method}\n${url}\n${ts}\n${nonce}\n${body}\n`;
  const sign = createSign('RSA-SHA256');
  sign.update(message);
  sign.end();
  return sign.sign(privPem, 'base64');
}

// Authorization 头：WECHATPAY2-SHA256-RSA2048 mchid="..",nonce_str="..",signature="..",timestamp="..",serial_no=".."
export function buildAuthHeader({ mchid, serialNo, privPem, method, url, body = '' }) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = randomBytes(16).toString('hex');
  const signature = generateSignature({ privPem, method, url, ts, nonce, body });
  return `WECHATPAY2-SHA256-RSA2048 mchid="${mchid}",nonce_str="${nonce}",signature="${signature}",timestamp="${ts}",serial_no="${serialNo}"`;
}

// 用平台证书公钥验签（回调 Wechatpay-Signature）
export function verifyWechatSignature({ pubKey, ts, nonce, method, url, body, sig }) {
  const message = `${method}\n${url}\n${ts}\n${nonce}\n${body}\n`;
  const v = createVerify('RSA-SHA256');
  v.update(message); v.end();
  try { return v.verify(pubKey, sig, 'base64'); } catch { return false; }
}

// 微信 v3 异步通知验签（验签串格式：{timestamp}\n{nonce}\n{body}\n，与请求签名不同）
export function verifyWechatCallback({ pubKey, ts, nonce, bodyStr, sig }) {
  const msg = `${ts}\n${nonce}\n${bodyStr}\n`;
  const v = createVerify('RSA-SHA256');
  v.update(msg); v.end();
  try { return v.verify(pubKey, sig, 'base64'); } catch { return false; }
}

// AES-256-GCM 解密回包 resource.ciphertext（base64）；associatedData 通常为 'transaction'
export function aes256gcmDecrypt(apiV3Key, nonce, associatedData, ciphertextB64) {
  const buf = Buffer.from(ciphertextB64, 'base64');
  const authTag = buf.subarray(buf.length - 16);
  const data = buf.subarray(0, buf.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', apiV3Key, nonce);
  decipher.setAuthTag(authTag);
  decipher.setAAD(Buffer.from(associatedData || ''));
  return decipher.update(data, 'binary', 'utf8') + decipher.final('utf8');
}

// AES-256-GCM 加密（对称，用于对账等需要本地加密的场景）
export function aes256gcmEncrypt(apiV3Key, nonce, associatedData, plaintext) {
  const cipher = createCipheriv('aes-256-gcm', apiV3Key, nonce);
  cipher.setAAD(Buffer.from(associatedData || ''));
  const enc = cipher.update(plaintext, 'utf8', 'binary') + cipher.final('binary');
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from(enc, 'binary'), tag]).toString('base64');
}

// 微信 Native 下单（真实网络；无凭据由 domesticGateway 调用前拦截）
export async function wechatNativeOrderRequest({ mchid, serialNo, privPem, appid, notifyUrl, outTradeNo, totalFee, description }) {
  const url = '/v3/pay/transactions/native';
  const body = JSON.stringify({
    appid, mchid,
    description: description || '订阅',
    out_trade_no: outTradeNo,
    notify_url: notifyUrl,
    amount: { total: totalFee, currency: 'CNY' },
  });
  const auth = buildAuthHeader({ mchid, serialNo, privPem, method: 'POST', url, body });
  const res = await fetch(`https://api.mch.weixin.qq.com${url}`, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json', Accept: 'application/json' },
    body,
  });
  if (!res.ok) throw new Error('wechat native order failed: ' + (await res.text()));
  const j = await res.json();
  // 沙箱/部分商户 code_url 明文返回；生产环境 code_url 在 resource.ciphertext（AES-GCM 加密）
  if (j.code_url) return j.code_url;
  if (j.resource?.ciphertext) {
    const apiV3Key = process.env.WECHAT_APIV3_KEY;
    if (!apiV3Key) throw new Error('WECHAT_APIV3_KEY required to decrypt code_url');
    const plain = aes256gcmDecrypt(apiV3Key, j.resource.nonce, j.resource.associated_data, j.resource.ciphertext);
    return JSON.parse(plain).code_url;
  }
  throw new Error('wechat native order: no code_url in response');
}
