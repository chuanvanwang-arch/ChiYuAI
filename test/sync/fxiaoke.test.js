import { describe, it, expect } from 'vitest';
import { createFxiaokeProvider } from 'file:///D:/system/CRM-ai-native/src/sync/fxiaoke.js';

describe('fxiaoke provider（纷享适配器）', () => {
  it('verifyAuth 用凭据换取 CorpAccessToken 并缓存（二次调用不打网络）', async () => {
    let calls = 0;
    const p = createFxiaokeProvider({
      creds: { appId: 'a', appSecret: 's', permanentCode: 'c' },
      baseUrl: 'https://open.fxiaoke.com',
      httpPost: async () => { calls++; return { access_token: 'tok-1', expires_in: 7200 }; },
    });
    const r1 = await p.verifyAuth();
    expect(r1.ok).toBe(true);
    expect(r1.token).toBe('tok-1');
    expect(calls).toBe(1);
    const r2 = await p.verifyAuth();
    expect(r2.token).toBe('tok-1'); // 缓存命中
    expect(calls).toBe(1); // 二次不打网络
  });

  it('discoverObjects 解析 /cgi/crm/object/list 返回对象清单', async () => {
    const p = createFxiaokeProvider({
      creds: { appId: 'a', appSecret: 's', permanentCode: 'c' },
      httpPost: async () => ({ access_token: 'tok-1', expires_in: 7200 }), // discover 依赖 token，需同时注入
      httpGet: async () => ({ data: [{ apiName: 'AccountObj', label: '客户' }, { apiName: 'ContactObj', label: '联系人' }] }),
    });
    const r = await p.discoverObjects();
    expect(r.ok).toBe(true);
    expect(r.objects.map(o => o.name)).toContain('AccountObj');
    expect(r.objects.map(o => o.name)).toContain('ContactObj');
  });
});
