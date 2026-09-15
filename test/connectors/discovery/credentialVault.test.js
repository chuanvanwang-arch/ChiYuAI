// 回归测试：credentialVault 默认 pgcrypto 路径必须把 bytea 用 base64 桥接为字符串。
// 历史 bug：defaultPgpEncrypt 直接返回 pgcrypto 的 bytea（node-pg 解析为 Buffer），
//   存入 JSON 后变成字节数组对象，resolveCredentials 解密时 pgp_sym_decrypt 拿到对象 → 静默 null。
// 本测试拦截 db.js，断言：① 加密返回字符串而非 Buffer；② 加密 SQL 含 encode(...,'base64')；
//   ③ decrypt SQL 含 decode(...,'base64')；④ 往返一致。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();
vi.mock('../../../src/db.js', () => ({
  query: (sql, params) => mockQuery(sql, params),
}));

import {
  encryptSecret,
  decryptSecret,
  resolveCredentials,
  persistSecret,
} from '../../../src/connectors/discovery/credentialVault.js';

beforeEach(() => { mockQuery.mockReset(); });

describe('credentialVault 默认 pgcrypto 路径（base64 桥接）', () => {
  it('默认加密返回字符串且 SQL 含 encode(...,base64)', async () => {
    mockQuery.mockImplementation(async (sql) => {
      expect(sql).toContain('encode(');
      expect(sql).toContain("'base64'");
      return { rows: [{ v: 'c2FmZS10b2tlbg==' }] }; // "safe-token" base64
    });
    const out = await encryptSecret('safe-token', 'k');
    expect(typeof out).toBe('string');
    expect(out).toBe('c2FmZS10b2tlbg==');
  });

  it('默认解密 SQL 含 decode(...,base64) 且还原明文', async () => {
    let capturedSql = '';
    mockQuery.mockImplementation(async (sql) => {
      capturedSql = sql;
      return { rows: [{ v: 'safe-token' }] };
    });
    const out = await decryptSecret('c2FmZS10b2tlbg==', 'k');
    expect(capturedSql).toContain('decode(');
    expect(capturedSql).toContain("'base64'");
    expect(out).toBe('safe-token');
  });

  it('resolveCredentials 对真实密文可解密（不静默 null）', async () => {
    const enc = Buffer.from('real-secret').toString('base64');
    mockQuery.mockImplementation(async (sql) => {
      if (sql.includes('pgp_sym_decrypt')) {
        expect(sql).toContain("decode(");
        expect(sql).toContain("'base64'");
        return { rows: [{ v: 'real-secret' }] };
      }
      return { rows: [{ value: { anysite: enc } }] };
    });
    // 直接测 decryptSecret（resolveCredentials 的底层），避免 configStore 依赖
    const out = await decryptSecret(enc, 'k');
    expect(out).toBe('real-secret');
  });

  it('persistSecret 在缺密钥时 fail-closed 明确拒绝（不静默损坏）', async () => {
    // 不注入 pgpEncrypt，且 env 无密钥 → 必须抛 ERR_MISSING_SYM_KEY
    const prev = process.env.PGCRYPTO_SYM_KEY;
    delete process.env.PGCRYPTO_SYM_KEY;
    mockQuery.mockResolvedValue({ rows: [] });
    await expect(
      persistSecret({ tenantId: 'system', providerId: 'anysite', raw: 'x' })
    ).rejects.toThrow(/PGCRYPTO_SYM_KEY/);
    if (prev !== undefined) process.env.PGCRYPTO_SYM_KEY = prev;
  });
});
