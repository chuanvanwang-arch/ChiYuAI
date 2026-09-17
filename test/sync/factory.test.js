// test/sync/factory.test.js — 同步 provider 工厂（kind → 同步 provider）
// 契约：工厂产出的实例满足同步 provider 契约（verifyAuth/discoverObjects/readIncremental）；
//       凭据缺失一律 fail-closed 且零请求；游标推进到本批最大 since（幂等前提）
// 本批次只交付 generic-rest（红线 R3：不得为具体产品做深度定制），故工厂仅含通用实现 + 配置别名。
import { describe, it, expect } from 'vitest';
import { SYNC_PROVIDER_FACTORY, createGenericRestSyncProvider } from '../../src/sync/factory.js';

describe('sync provider factory（同步 provider 工厂）', () => {
  it('仅含 generic-rest + neocrm 别名（无产品专属 deep-customization）', () => {
    expect(Object.keys(SYNC_PROVIDER_FACTORY).sort()).toEqual(['generic-rest', 'neocrm']);
  });

  it('产出的 provider 满足同步契约三方法', () => {
    const p = createGenericRestSyncProvider({ id: 'x', endpoint: 'https://example.com/api', token: 'tk' });
    expect(typeof p.verifyAuth).toBe('function');
    expect(typeof p.discoverObjects).toBe('function');
    expect(typeof p.readIncremental).toBe('function');
    expect(p.kind).toBe('generic-rest');
  });

  it('无 endpoint → verifyAuth fail（fail-closed，零请求）', async () => {
    const p = createGenericRestSyncProvider({ id: 'x' });
    expect((await p.verifyAuth()).ok).toBe(false);
    expect((await p.verifyAuth()).error).toBe('endpoint_missing');
  });

  it('无凭据 → verifyAuth fail（凭据不出口）', async () => {
    const p = createGenericRestSyncProvider({ id: 'x', endpoint: 'https://e.com' });
    const r = await p.verifyAuth();
    expect(r.ok).toBe(false);
    expect(r.error).toBe('credentials_missing');
  });

  it('注入 __fetch → readIncremental 按 since_field 组装 GET 查询并返回 rows+cursor', async () => {
    const calls = [];
    const p = createGenericRestSyncProvider({
      id: 'x', endpoint: 'https://e.com/list', token: 'tk',
      objects: [{ name: 'AccountObj', since_field: 'last_modified_time', id_field: '_id' }],
      __fetch: async (url, opts) => {
        calls.push({ url, opts });
        return { ok: true, json: async () => ({ data: [{ _id: 'a1', name: '客户A', last_modified_time: '2026-09-16T01:00:00Z' }] }) };
      },
    });
    const r = await p.readIncremental({ object: 'AccountObj', cursor: '2026-09-16T00:00:00Z' });
    expect(r.ok).toBe(true);
    expect(r.rows).toHaveLength(1);
    expect(r.cursor).toBe('2026-09-16T01:00:00Z'); // 游标推进
    expect(calls[0].url).toContain('last_modified_time');
    expect(calls[0].opts.headers.Authorization).toBe('Bearer tk');
  });

  it('method=POST → readIncremental 以 JSON body 组装请求（通用接口支持 POST）', async () => {
    const calls = [];
    const p = createGenericRestSyncProvider({
      id: 'x', endpoint: 'https://e.com/query', token: 'tk', method: 'POST',
      objects: [{ name: 'AccountObj', since_field: 'last_modified_time', page_size: 50 }],
      __fetch: async (url, opts) => { calls.push({ url, opts }); return { ok: true, json: async () => ({ data: [{ _id: 'a1', last_modified_time: '2026-09-16T01:00:00Z' }] }) }; },
    });
    const r = await p.readIncremental({ object: 'AccountObj', cursor: '2026-09-16T00:00:00Z' });
    expect(r.ok).toBe(true);
    expect(r.rows).toHaveLength(1);
    expect(r.cursor).toBe('2026-09-16T01:00:00Z');
    expect(calls[0].opts.method).toBe('POST');
    expect(JSON.parse(calls[0].opts.body)).toMatchObject({ object: 'AccountObj', cursor: '2026-09-16T00:00:00Z', since_field: 'last_modified_time', pageSize: 50 });
    expect(calls[0].opts.headers.Authorization).toBe('Bearer tk');
  });

  it('method=POST + 自定义 authHeader/authPrefix → 按配置带鉴权头（无产品名）', async () => {
    const calls = [];
    const p = createGenericRestSyncProvider({
      id: 'x', endpoint: 'https://e.com', token: 'tk', method: 'POST', authHeader: 'X-API-Key', authPrefix: '',
      objects: [{ name: 'O' }],
      __fetch: async (url, opts) => { calls.push({ url, opts }); return { ok: true, json: async () => ({ data: [] }) }; },
    });
    await p.readIncremental({ object: 'O' });
    expect(calls[0].opts.headers['X-API-Key']).toBe('tk');
  });

  it('空批次 → 游标保持原值（幂等：不倒退）', async () => {
    const p = createGenericRestSyncProvider({
      id: 'x', endpoint: 'https://e.com', token: 'tk', objects: [{ name: 'O' }],
      __fetch: async () => ({ ok: true, json: async () => ({ data: [] }) }),
    });
    const r = await p.readIncremental({ object: 'O', cursor: 'c-1' });
    expect(r.rows).toHaveLength(0);
    expect(r.cursor).toBe('c-1');
  });

  it('未声明的 object → fail-closed（rows 空，不抛）', async () => {
    const p = createGenericRestSyncProvider({ id: 'x', endpoint: 'https://e.com', token: 'tk', objects: [] });
    const r = await p.readIncremental({ object: 'Unknown' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('object_not_declared');
  });

  it('HTTP 非 2xx → fail-closed（不抛，留 error）', async () => {
    const p = createGenericRestSyncProvider({
      id: 'x', endpoint: 'https://e.com', token: 'tk', objects: [{ name: 'O' }],
      __fetch: async () => ({ ok: false, status: 401, json: async () => ({}) }),
    });
    const r = await p.readIncremental({ object: 'O' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('http_401');
  });
});
