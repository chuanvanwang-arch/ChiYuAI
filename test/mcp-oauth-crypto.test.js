// test/mcp-oauth-crypto.test.js — OAuth 密码学原语（RFC 7636 PKCE）
// 设计：docs/2026-09-15-mcp-oauth-design.md §3.6 / §6
import { describe, it, expect } from 'vitest';
import {
  sha256Hex, base64UrlSha256, newOpaqueToken, newClientId, verifyPkce, safeEqual,
  CODE_PREFIX, REFRESH_PREFIX, CLIENT_PREFIX,
} from '../src/mcp/oauthCrypto.js';

describe('oauthCrypto', () => {
  it('sha256Hex 稳定且为 64 位小写 hex', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('abc')).toHaveLength(64);
  });

  it('base64UrlSha256 匹配 RFC 7636 附录 B 官方向量', () => {
    const v = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    expect(base64UrlSha256(v)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('newOpaqueToken 带前缀且长度正确（32 字节 = 64 hex），每次不同', () => {
    const c = newOpaqueToken(CODE_PREFIX);
    expect(c.startsWith('crmc_')).toBe(true);
    expect(c).toHaveLength(CODE_PREFIX.length + 64);
    expect(newOpaqueToken(REFRESH_PREFIX).startsWith('crmr_')).toBe(true);
    expect(newOpaqueToken(CODE_PREFIX)).not.toBe(c);
  });

  it('newClientId 形如 oauth_<32hex>', () => {
    expect(newClientId()).toMatch(new RegExp(`^${CLIENT_PREFIX}[a-f0-9]{32}$`));
  });

  it('verifyPkce 正确 verifier 通过、错误与过短 verifier 拒绝', () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const challenge = base64UrlSha256(verifier);
    expect(verifyPkce(verifier, challenge)).toBe(true);
    expect(verifyPkce(verifier + 'x', challenge)).toBe(false);
    expect(verifyPkce(verifier.slice(0, 42), challenge)).toBe(false);   // 短于 43 直接拒
  });

  it('verifyPkce 拒绝非字符串与超长 verifier（RFC 7636 长度 43–128）', () => {
    const long = 'a'.repeat(129);
    expect(verifyPkce(null, base64UrlSha256('x'))).toBe(false);
    expect(verifyPkce(long, base64UrlSha256(long))).toBe(false);
  });

  it('safeEqual 长度不同返回 false 且不抛', () => {
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual(null, undefined)).toBe(true);   // 均归一为 ''
  });
});
