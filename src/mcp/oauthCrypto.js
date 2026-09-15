// src/mcp/oauthCrypto.js — OAuth 密码学原语（纯函数：无 IO、无时间依赖、无 DB）
// 设计：docs/2026-09-15-mcp-oauth-design.md §3.6 / §6
//
// 安全红线：授权码与 refresh token 明文一律不落库、不进日志；本模块只产出明文与哈希，
// 落库由 oauthStore 决定（只落 sha256Hex）。
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const CODE_PREFIX = 'crmc_';
export const REFRESH_PREFIX = 'crmr_';
export const CLIENT_PREFIX = 'oauth_';

// 落库前统一哈希（授权码 / refresh token）
export function sha256Hex(input) {
  return createHash('sha256').update(String(input), 'utf8').digest('hex');
}

// RFC 7636 §4.2：code_challenge = BASE64URL-ENCODE(SHA256(ASCII(code_verifier)))，无 padding
export function base64UrlSha256(input) {
  return createHash('sha256').update(String(input), 'utf8').digest('base64url');
}

// 不透明令牌：256 bit 熵（32 字节 hex）+ 类型前缀，日志可辨类型而不泄漏内容
export function newOpaqueToken(prefix) {
  return `${prefix}${randomBytes(32).toString('hex')}`;
}

export function newClientId() {
  return `${CLIENT_PREFIX}${randomBytes(16).toString('hex')}`;
}

// 恒定时间比较：避免通过响应时间侧信道逐字节推断 challenge
export function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''), 'utf8');
  const bb = Buffer.from(String(b ?? ''), 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// PKCE 校验：强制 S256；verifier 长度按 RFC 7636 §4.1 限制 43–128 字符
export function verifyPkce(codeVerifier, codeChallenge) {
  if (typeof codeVerifier !== 'string') return false;
  if (codeVerifier.length < 43 || codeVerifier.length > 128) return false;
  if (typeof codeChallenge !== 'string' || !codeChallenge) return false;
  return safeEqual(base64UrlSha256(codeVerifier), codeChallenge);
}
