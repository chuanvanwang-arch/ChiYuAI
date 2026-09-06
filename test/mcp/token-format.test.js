// test/mcp/token-format.test.js — token 明文格式单一事实源（设计 docs/2026-09-01-mcp-token-lookup-design.md §4.2）
import { describe, it, expect } from 'vitest';
import { TOKEN_PREFIX, TOKEN_RE, newStructuredToken, parseTokenId } from '../../src/mcp/tokenFormat.js';

describe('tokenFormat', () => {
  it('newStructuredToken 产出 crm_<id32>_<secret48>', () => {
    const { id, tokenPlain } = newStructuredToken();
    expect(TOKEN_PREFIX).toBe('crm');
    expect(tokenPlain).toMatch(TOKEN_RE);
    expect(tokenPlain).toMatch(/^crm_[0-9a-f]{32}_[0-9a-f]{48}$/);
    expect(tokenPlain.length).toBe(85); // 3 + 1 + 32 + 1 + 48
    // id 段去横线后必须等于 token 中的 id32（颁发与解析可闭环）
    expect(tokenPlain.slice(4, 36)).toBe(id.replace(/-/g, ''));
  });

  it('parseTokenId 还原带横线 UUID，与生成侧互逆', () => {
    const { id, tokenPlain } = newStructuredToken();
    expect(parseTokenId(tokenPlain)).toBe(id);
  });

  it('格式不符一律返回 null（旧格式 hex token / 空 / 篡改长度）', () => {
    expect(parseTokenId('a'.repeat(48))).toBeNull();          // 旧格式：裸 48 hex
    expect(parseTokenId('')).toBeNull();
    expect(parseTokenId(null)).toBeNull();
    expect(parseTokenId('crm_zzzz_' + 'a'.repeat(48))).toBeNull(); // id 段非 hex
    expect(parseTokenId('crm_' + 'a'.repeat(32))).toBeNull();      // 缺 secret 段
  });

  it('两次生成的 token 不重复', () => {
    const a = newStructuredToken();
    const b = newStructuredToken();
    expect(a.tokenPlain).not.toBe(b.tokenPlain);
    expect(a.id).not.toBe(b.id);
  });
});
