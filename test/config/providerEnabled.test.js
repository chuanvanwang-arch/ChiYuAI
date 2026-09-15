// test/config/providerEnabled.test.js
import { describe, it, expect } from 'vitest';
import { DEFAULT_DISCOVERY_RULES, mergedDiscoveryRules, mergeDiscoveryRules } from '../../src/config/discoveryRules.js';
import { DEFAULT_PROSPECTING_RULES } from '../../src/config/prospectingRules.js';

describe('provider enabled (D1 铁律：出厂默认付费源恒 disabled)', () => {
  it('discoveryRules 出厂默认：qixin/anysite/xinbang 均 disabled', () => {
    for (const id of ['qixin', 'anysite', 'xinbang']) {
      const p = DEFAULT_DISCOVERY_RULES.providers.find((x) => x.id === id);
      expect(p.enabled, `出厂默认 ${id} 应 disabled（D1 铁律）`).toBe(false);
    }
  });
  it('prospectingRules 出厂默认：三源均 disabled', () => {
    for (const id of ['qixin', 'anysite', 'xinbang']) {
      expect(DEFAULT_PROSPECTING_RULES.sources[id].enabled, `出厂默认 ${id} 应 disabled（D1 铁律）`).toBe(false);
    }
  });
  it('显式授权通道：config_store override 启用付费源（合并语义按 id 覆盖）', () => {
    const merged = mergeDiscoveryRules(DEFAULT_DISCOVERY_RULES, {
      providers: [
        { id: 'qixin', enabled: true },
        { id: 'anysite', enabled: true },
        { id: 'xinbang', enabled: true },
      ],
    });
    for (const id of ['qixin', 'anysite', 'xinbang']) {
      expect(merged.providers.find((p) => p.id === id).enabled, `override 后 ${id} 应 enabled`).toBe(true);
    }
  });
  it('mergedDiscoveryRules 经注入 readConfig 解析出 anysite 为 enabled 适配器', async () => {
    const r = await mergedDiscoveryRules(
      { tenantId: 'system' },
      { readConfig: async (key) => (key === 'discovery-rules'
        ? { value: { providers: [{ id: 'anysite', enabled: true }] } }
        : null) },
    );
    expect(r.providers.find((p) => p.id === 'anysite').enabled).toBe(true);
  });
});
