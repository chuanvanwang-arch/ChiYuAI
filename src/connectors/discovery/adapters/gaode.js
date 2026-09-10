// src/connectors/discovery/adapters/gaode.js
// 地理/工商定位（系统默认档）。铁律：无 key 绝不发起请求；网络/JSON/业务失败一律 fail-open 返 {}。
import { ProviderAdapter, fieldHit } from '../providerAdapter.js';
import { registerProvider } from '../providerRegistry.js';

const AMAP_GEOCODE = 'https://restapi.amap.com/v3/geocode/geo';

export function gaodeAdapter(cfg = {}) {
  return new (class extends ProviderAdapter {
    constructor() {
      super({ id: 'gaode', kind: 'geo_firmographics', scope: 'system', costTier: 1,
              coverageFields: ['registered_address', 'geo_coord', 'industry_zone'], ...cfg });
    }
    async enrich(entity, fields = [], ctx = {}) {
      const key = ctx.gaodeKey || process.env.GAODE_KEY;
      if (!key) return {};                                   // 无凭据 → 零请求
      const wants = ['geo_coord', 'registered_address'].filter((f) => fields.includes(f));
      if (!wants.length) return {};
      const q = entity?.registered_address || entity?.name;
      if (!q) return {};
      let res;
      try {
        const r = await fetch(`${AMAP_GEOCODE}?key=${key}&address=${encodeURIComponent(q)}`);
        if (!r.ok) return {};
        res = await r.json();
      } catch { return {}; }
      if (res?.status !== '1' || !res.geocodes?.length) return {};
      const gc = res.geocodes[0];
      const out = {};
      // 同一次 API 调用产出的字段：首个计费，其余 cost=0（不重复计费）
      if (wants.includes('geo_coord')) {
        Object.assign(out, fieldHit('geo_coord', { value: gc.location, confidence: 0.9, cost: this.costTier, provider: this.id }));
      }
      if (wants.includes('registered_address')) {
        Object.assign(out, fieldHit('registered_address', { value: gc.formatted_address, confidence: 0.9, cost: 0, provider: this.id }));
      }
      return out;
    }
  })();
}

registerProvider('gaode', gaodeAdapter);
