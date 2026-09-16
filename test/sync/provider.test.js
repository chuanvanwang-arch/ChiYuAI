import { describe, it, expect } from 'vitest';
import { createProviderRegistry } from 'file:///D:/system/CRM-ai-native/src/sync/provider.js';

describe('sync provider 注册表', () => {
  it('已注册 kind 返回 provider 实例（三方法齐备）', () => {
    const reg = createProviderRegistry({
      providers: {
        mock: {
          verifyAuth: async () => ({ ok: true }),
          discoverObjects: async () => ({ objects: [] }),
          readIncremental: async () => ({ rows: [], cursor: null }),
        },
      },
    });
    const p = reg.get('mock');
    expect(p).toBeTruthy();
    expect(typeof p.verifyAuth).toBe('function');
    expect(typeof p.discoverObjects).toBe('function');
    expect(typeof p.readIncremental).toBe('function');
  });

  it('未注册 kind 返回 null（fail-closed）', () => {
    const reg = createProviderRegistry({ providers: {} });
    expect(reg.get('fxiaoke')).toBeNull();
  });
});
