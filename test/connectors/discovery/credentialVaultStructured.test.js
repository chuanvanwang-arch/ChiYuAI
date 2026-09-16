// test/connectors/discovery/credentialVaultStructured.test.js
// A-B2（2026-09-16）：结构化凭据 + token 加密落库（不落内存全局）
// 设计：docs/2026-09-15-final-design-coexistence-and-proactive.md §6.1 A-B2
//   「允许 JSON 结构（纷享 appId/appSecret/permanentCode、销售易账号密钥）；
//     token 缓存值与过期时间**加密落库**，不落内存全局」
// 判据重点：① 单串凭据零回归；② 只认 JSON **对象**（标量/数组不解析）；
//          ③ 解析失败原样返回明文（不丢客户凭据）；④ token 往返 + expired 派生 + 禁删；
//          ⑤ 静态守卫：不得存在模块级 token 内存缓存（附负向对照，防恒真假绿）。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  parseCredentialPayload, resolveCredentials, persistSecret, persistToken, readToken,
} from '../../../src/connectors/discovery/credentialVault.js';

describe('A-B2 · parseCredentialPayload（结构化凭据解析）', () => {
  it('JSON 对象 → object；单串密钥 → 原样字符串（零回归）', () => {
    expect(parseCredentialPayload('{"appId":"a","appSecret":"s","permanentCode":"c"}'))
      .toEqual({ appId: 'a', appSecret: 's', permanentCode: 'c' });
    expect(parseCredentialPayload('sk-plain-token')).toBe('sk-plain-token');
  });

  it('JSON 标量/数组不解析（避免把「像 JSON 的字符串密钥」改成非字符串）', () => {
    expect(parseCredentialPayload('123')).toBe('123');
    expect(parseCredentialPayload('true')).toBe('true');
    expect(parseCredentialPayload('["a","b"]')).toBe('["a","b"]');
  });

  it('残缺 JSON → 原样返回明文（不静默丢弃客户凭据）', () => {
    expect(parseCredentialPayload('{appId: broken')).toBe('{appId: broken');
    expect(parseCredentialPayload('{"a":}')).toBe('{"a":}');
  });

  it('null / undefined → null（不抛）', () => {
    expect(parseCredentialPayload(null)).toBeNull();
    expect(parseCredentialPayload(undefined)).toBeNull();
  });
});

describe('A-B2 · resolveCredentials 形状', () => {
  it('密文解出 JSON 对象 → 返回对象；解出普通串 → 返回字符串', async () => {
    const store = { fxiaoke: 'ENC1', anysite: 'ENC2' };
    const plain = { ENC1: '{"appId":"a","appSecret":"s"}', ENC2: 'sk-1' };
    const out = await resolveCredentials({
      tenantId: 't1', providerIds: ['fxiaoke', 'anysite'],
      deps: { readConfig: async () => ({ value: store }), decrypt: async (e) => plain[e] },
    });
    expect(out.fxiaoke).toEqual({ appId: 'a', appSecret: 's' });
    expect(out.anysite).toBe('sk-1');
  });
});

describe('A-B2 · persistSecret 接受结构化凭据', () => {
  it('对象入参序列化为 JSON 后加密（密文内即 JSON，读侧可还原）', async () => {
    let captured = null;
    let written = null;
    await persistSecret({
      tenantId: 't1', providerId: 'fxiaoke',
      raw: { appId: 'a', appSecret: 's', permanentCode: 'c' },
      deps: {
        pgpEncrypt: (raw) => { captured = raw; return `enc-${raw}`; },
        readConfig: async () => null,
        writeConfig: async (key, value, opts) => { written = { key, value, opts }; return { ok: true }; },
      },
    });
    // 明文是 JSON 串（而非 [object Object]）
    expect(JSON.parse(captured)).toEqual({ appId: 'a', appSecret: 's', permanentCode: 'c' });
    // 落库的是密文（= 注入的 pgpEncrypt 输出），槽位仍为 providerId（与 token 槽不冲突）
    // 注：此处不断言"密文不含明文"——替身加密器只是加前缀，该断言测的是替身而非被测代码。
    expect(written.value.fxiaoke).toBe(`enc-${captured}`);
  });
});

describe('A-B2 · token 加密落库（值 + 过期时间）', () => {
  const mkDeps = () => {
    const state = {};
    return {
      state,
      deps: {
        pgpEncrypt: (raw) => `ENC(${raw})`,
        pgpDecrypt: (enc) => String(enc).slice(4, -1),
        symKey: 'k',
        readConfig: async () => (Object.keys(state).length ? { value: { ...state } } : null),
        writeConfig: async (key, value) => { Object.assign(state, value); return { ok: true }; },
      },
    };
  };

  it('persistToken → readToken 往返一致，槽位独立于凭据槽', async () => {
    const { state, deps } = mkDeps();
    state.fxiaoke = 'ENC({"appId":"a"})'; // 既有凭据槽
    await persistToken({ tenantId: 't1', providerId: 'fxiaoke', token: 'tok-1', expiresAt: Date.now() + 3600_000, deps });
    expect(Object.keys(state).sort()).toEqual(['fxiaoke', 'fxiaoke:token']); // 两槽并存
    const t = await readToken({ tenantId: 't1', providerId: 'fxiaoke', deps });
    expect(t.token).toBe('tok-1');
    expect(t.expired).toBe(false);
    // 凭据槽未被污染（JSON 仍能还原为对象）
    const creds = await resolveCredentials({ tenantId: 't1', providerIds: ['fxiaoke'], deps: { ...deps, decrypt: deps.pgpDecrypt } });    expect(creds.fxiaoke).toEqual({ appId: 'a' });
  });

  it('过期时间早于当下 → expired=true（由 expiresAt 派生，不删不改写槽位）', async () => {
    const { state, deps } = mkDeps();
    await persistToken({ tenantId: 't1', providerId: 'p', token: 'old', expiresAt: Date.now() - 1000, deps });
    const t = await readToken({ tenantId: 't1', providerId: 'p', deps });
    expect(t.expired).toBe(true);
    expect(state['p:token']).toBeTruthy(); // 禁删铁律：不因过期删槽
  });

  it('缺槽 / 密文损坏 / 非法 JSON → null（不返回半成品、不抛）', async () => {
    const { state, deps } = mkDeps();
    expect(await readToken({ tenantId: 't1', providerId: 'none', deps })).toBeNull();
    state['bad:token'] = 'NOT-ENC-FORMAT';
    expect(await readToken({ tenantId: 't1', providerId: 'bad', deps })).toBeNull();
    state['bad2:token'] = 'ENC(not-json)';
    expect(await readToken({ tenantId: 't1', providerId: 'bad2', deps })).toBeNull();
  });

  it('persistToken 缺 providerId / token → fail-closed 明确拒绝', async () => {
    const { deps } = mkDeps();
    await expect(persistToken({ tenantId: 't1', providerId: 'p', deps })).rejects.toThrow(/providerId 与 token 必填/);
    await expect(persistToken({ tenantId: 't1', token: 'x', deps })).rejects.toThrow(/providerId 与 token 必填/);
  });
});

describe('A-B2 · 静态守卫：token 不得落模块级内存全局', () => {
  // 断言前剥离注释——解释性注释会提到 tokenCache 一词，直接匹配即假红（比假绿更危险的失真方向）。
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const src = stripComments(
    readFileSync(new URL('../../../src/connectors/discovery/credentialVault.js', import.meta.url), 'utf8'),
  );

  it('credentialVault.js 代码中不出现内存缓存标识符', () => {
    expect(src).not.toMatch(/tokenCache|TOKEN_CACHE|_tokenCache/);
  });

  it('负向对照：注入缓存写法应被同一判据抓到（守卫非恒真）', () => {
    expect(stripComments('let tokenCache = null;')).toMatch(/tokenCache/);
    expect(stripComments('// 本模块不设 tokenCache')).not.toMatch(/tokenCache/); // 注释提及不算违规
  });
});

// ─── Q2-4 契约验收判据（docs/2026-09-16-full-chain-integration-design.md §4 / Q2-4）───
// 原文 success: "结构化凭据可写入并按 key 读回；**凭据内容不出现在任何日志或 trace 载荷中**；
//              缺字段时 verifyAuth 返回失败而非抛出"
describe('Q2-4 · 凭据内容零日志出口（静态守卫）', () => {
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const src = stripComments(
    readFileSync(new URL('../../../src/connectors/discovery/credentialVault.js', import.meta.url), 'utf8'),
  );

  it('凭据模块不含任何日志 / trace 输出点（无出口即无泄漏面）', () => {
    expect(src).not.toMatch(/console\.(log|info|warn|error|debug)/);
    expect(src).not.toMatch(/\bemit\s*\(/);          // 不得向事件总线投递载荷
    expect(src).not.toMatch(/logger|recordFailure/); // 不得写日志/失败账
  });

  it('负向对照：若新增 console.log 应被同一判据抓到（守卫非恒真）', () => {
    expect(stripComments("console.log('secret', raw);")).toMatch(/console\.(log|info|warn|error|debug)/);
    expect(stripComments("emit('trace', 'x', { raw });")).toMatch(/\bemit\s*\(/);
  });

  it('明文只在入参/出参之间流动：落库值恒为加密器输出（不为明文）', async () => {
    let written = null;
    await persistSecret({
      tenantId: 't1', providerId: 'p', raw: { appSecret: 'TOP-SECRET' },
      deps: {
        pgpEncrypt: () => 'CIPHERTEXT-BLOB',
        readConfig: async () => null,
        writeConfig: async (k, v) => { written = v; return { ok: true }; },
      },
    });
    expect(written.p).toBe('CIPHERTEXT-BLOB');
    expect(JSON.stringify(written)).not.toContain('TOP-SECRET'); // 落库面不含明文
  });
});
