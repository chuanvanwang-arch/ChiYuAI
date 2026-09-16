// test/connectors/discovery/credentialShapeConsumption.test.js
// A-B2 消费面（2026-09-16）：结构化凭据必须**真的到达** provider，否则 A-B2 就是"就绪但零消费方"。
// 设计 §6.1 A-B2 + §9.3：
//   ① 纷享（fxiaoke）吃 appId/appSecret/permanentCode 结构化凭据——挂载层注入键为 `credentials`，
//      而 createFxiaokeProvider 历史签名是 `creds` → 两者不通则结构化凭据全部落空（静默）。
//   ② 通用 REST（enrich 侧）只吃**单串 token**——传入结构化对象时不得发出 `Bearer [object Object]`。
import { describe, it, expect } from 'vitest';
import { createFxiaokeProvider } from '../../../src/sync/fxiaoke.js';
import { genericRestAdapter } from '../../../src/connectors/discovery/adapters/genericRest.js';

describe('A-B2 · 结构化凭据到达 fxiaoke provider', () => {
  const structured = { appId: 'app-1', appSecret: 'sec-1', permanentCode: 'code-1' };

  it('credentials（挂载层注入键）→ 换取 CorpAccessToken（按 appId 等三要素发请求）', async () => {
    let body = null;
    const p = createFxiaokeProvider({
      credentials: structured, // 挂载层实际注入的键名
      httpPost: async (url, payload) => { body = payload; return { access_token: 'tok-ok', expires_in: 7200 }; },
    });
    const r = await p.verifyAuth();
    expect(r.ok).toBe(true);
    expect(r.token).toBe('tok-ok');
    expect(body).toMatchObject({ appId: 'app-1', appSecret: 'sec-1', permanentCode: 'code-1' });
  });

  it('creds（历史签名）仍生效——零回归', async () => {
    let body = null;
    const p = createFxiaokeProvider({
      creds: structured,
      httpPost: async (url, payload) => { body = payload; return { access_token: 'tok-legacy', expires_in: 7200 }; },
    });
    expect((await p.verifyAuth()).token).toBe('tok-legacy');
    expect(body.appId).toBe('app-1');
  });

  it('creds 优先于 credentials（同时给出时不产生两套事实源）', async () => {
    let body = null;
    const p = createFxiaokeProvider({
      creds: { appId: 'from-creds' },
      credentials: { appId: 'from-credentials' },
      httpPost: async (url, payload) => { body = payload; return { access_token: 't', expires_in: 7200 }; },
    });
    await p.verifyAuth();
    expect(body.appId).toBe('from-creds');
  });

  it('未注入任何凭据 → 仍以 undefined appId 发请求（由真实服务端拒绝），不伪造成功', async () => {
    let body = null;
    const p = createFxiaokeProvider({
      httpPost: async (url, payload) => { body = payload; return { access_token: 't', expires_in: 7200 }; },
    });
    await p.verifyAuth();
    expect(body.appId).toBeUndefined();
  });
});

describe('A-B2 · 单串 token 消费方对结构化凭据 fail-closed（不发 [object Object]）', () => {
  const mk = (creds, sink) => genericRestAdapter({
    id: 'p1', endpoint: 'https://x/api', field_map: { name: 'company' }, credentials: creds,
    __fetch: async (url, opts) => { sink.push(opts); return { ok: true, json: async () => ({ company: 'ACME' }) }; },
  });

  it('字符串凭据 → 带 Bearer 头', async () => {
    const calls = [];
    const a = mk('sk-1', calls);
    const out = await a.enrich({ name: 'A' }, ['name'], {});
    expect(calls[0].headers.Authorization).toBe('Bearer sk-1');
    expect(out.name.value).toBe('ACME');
  });

  it('结构化对象凭据 → **不带** Authorization（而非 Bearer [object Object]）', async () => {
    const calls = [];
    const a = mk({ appId: 'a', appSecret: 's' }, calls);
    await a.enrich({ name: 'A' }, ['name'], {});
    expect(calls[0].headers.Authorization).toBeUndefined();
    expect(JSON.stringify(calls[0].headers)).not.toContain('[object Object]');
  });
});

// ─── Q2-4 契约验收判据：缺字段时 verifyAuth **返回失败而非抛出** ───
// 来源：docs/2026-09-16-full-chain-integration-design.md §4 Q2-4 success 第 3 条
describe('Q2-4 · 缺字段的凭据 → verifyAuth 返回失败而非抛出', () => {
  it('fxiaoke 结构化凭据缺 appSecret → 服务端返回无 token → ok:false（不抛）', async () => {
    const p = createFxiaokeProvider({
      credentials: { appId: 'a', permanentCode: 'c' }, // 缺 appSecret
      httpPost: async () => ({ errCode: 1001, errMsg: 'invalid parameter' }),
    });
    const r = await p.verifyAuth();
    expect(r.ok).toBe(false);
    expect(typeof r.error).toBe('string');
  });

  it('fxiaoke 凭据缺失且网络层抛错 → 捕获为 ok:false（不向上抛）', async () => {
    const p = createFxiaokeProvider({
      credentials: {},
      httpPost: async () => { throw new Error('ECONNREFUSED'); },
    });
    await expect(p.verifyAuth()).resolves.toMatchObject({ ok: false });
  });

  it('generic-rest 同步 provider 缺 endpoint → ok:false（零请求，不抛）', async () => {
    const { createGenericRestSyncProvider } = await import('../../../src/sync/factory.js');
    await expect(createGenericRestSyncProvider({}).verifyAuth()).resolves.toMatchObject({ ok: false, error: 'endpoint_missing' });
  });

  it('generic-rest 同步 provider 有 endpoint 但无凭据 → credentials_missing（零请求，不抛）', async () => {
    const { createGenericRestSyncProvider } = await import('../../../src/sync/factory.js');
    const p = createGenericRestSyncProvider({ endpoint: 'https://x/api' });
    await expect(p.verifyAuth()).resolves.toMatchObject({ ok: false, error: 'credentials_missing' });
  });
});
