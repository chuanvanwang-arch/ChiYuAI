// src/llm/secret.js — api_key 静态加密（AES-256-GCM），不依赖外部 KMS
// 设计：configRouter(lfm) PUT 时 encryptSecret 落库；GET 时 maskSecret 仅回掩码；
//       llm/client.js 调用前 decryptSecret 还原明文（全程服务端，明文不入日志/客户端）。
// 主密钥：环境变量 CRM_LLM_SECRET；缺省回退 PORTAL_JWT_SECRET；再缺省开发占位（生产必须设置）。
import crypto from 'node:crypto';

const RAW = process.env.CRM_LLM_SECRET || process.env.PORTAL_JWT_SECRET || 'crm-dev-secret';
// AES-256 要求 32 字节密钥；规整为定长
const KEY = Buffer.from(RAW, 'utf8').subarray(0, 32).toString('utf8').padEnd(32, '\0');
const ALGO = 'aes-256-gcm';
const PREFIX = 'v1:';

export function encryptSecret(plain) {
  if (plain == null) return plain;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv(ALGO, Buffer.from(KEY), iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decryptSecret(cipher) {
  if (cipher == null) return cipher;
  if (typeof cipher !== 'string' || !cipher.startsWith(PREFIX)) return cipher; // 兼容未加密明文
  const buf = Buffer.from(cipher.slice(PREFIX.length), 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const c = crypto.createDecipheriv(ALGO, Buffer.from(KEY), iv);
  c.setAuthTag(tag);
  return Buffer.concat([c.update(enc), c.final()]).toString('utf8');
}

// GET 掩码：解密后仅暴露末 4 位（服务端内部，不向客户端泄漏明文）
export function maskSecret(cipher) {
  try {
    const plain = decryptSecret(cipher);
    if (!plain) return '********';
    const tail = String(plain).slice(-4);
    return `********${tail}`;
  } catch {
    return '********';
  }
}
