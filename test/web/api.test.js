// test/web/api.test.js — api.js 统一封装（Authorization/401 跳登录/错误抛掷）
import { describe, it, expect, afterEach } from 'vitest';

// 动态 import 前注入 localStorage/location/fetch mock
async function loadApi({ token, route }) {
  const store = {};
  globalThis.localStorage = {
    getItem: (k) => (k === 'crm_token' ? token : null),
    clear: () => {},
  };
  globalThis.location = { href: route || 'http://x/' };
  globalThis.fetch = route === 'fail'
    ? async () => ({ ok: false, status: 401 })
    : async (url, init) => {
        globalThis.__lastInit = init;
        return { ok: true, status: 200, json: async () => ({ data: url, auth: init?.headers?.Authorization }) };
      };
  const mod = await import('../../src/web/api.js');
  return mod;
}

afterEach(() => {
  delete globalThis.localStorage;
  delete globalThis.location;
  delete globalThis.fetch;
});

describe('api.js', () => {
  it('GET 自动带 Authorization', async () => {
    const api = await loadApi({ token: 'tok1' });
    const j = await api.get('/api/particles');
    expect(j.auth).toBe('Bearer tok1');
  });

  it('401 清 token 跳登录', async () => {
    const api = await loadApi({ token: 'tok2', route: 'fail' });
    await expect(api.get('/api/x')).rejects.toThrow();
    expect(globalThis.location.href).toBe('/home.html');
  });

  it('非 2xx 抛错携带 error 文案', async () => {
    globalThis.localStorage = { getItem: () => 't', clear: () => {} };
    globalThis.location = { href: 'http://x/' };
    globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: 'bad payload' }) });
    const api = await import('../../src/web/api.js');
    await expect(api.post('/api/particles', {})).rejects.toThrow('bad payload');
    delete globalThis.localStorage; delete globalThis.location; delete globalThis.fetch;
  });
});