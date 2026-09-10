// src/connectors/discovery/adapters/webResearch.js
// Claygent 的真实研究在 Task 8 的 discovery-research Action；本适配器只做「编排侧注入的抽取通道」委托。
// 无通道 → {}（fail-open），绝不伪造字段。
import { ProviderAdapter, fieldHit } from '../providerAdapter.js';
import { registerProvider } from '../providerRegistry.js';

export function webResearch(cfg = {}) {
  return new (class extends ProviderAdapter {
    constructor() {
      super({ id: 'web-research', kind: 'web/serp', scope: 'system', costTier: 0,
              coverageFields: ['tech_stack', 'hiring_signal', 'website_change', 'description'], ...cfg });
    }
    async enrich(entity, fields = [], ctx = {}) {
      const research = ctx.research || this.config.research;
      if (typeof research !== 'function') return {};
      let raw;
      try { raw = await research(entity, fields, ctx); } catch { return {}; }
      const out = {};
      for (const f of fields) {
        const v = raw?.[f];
        if (v == null) continue;
        const entry = typeof v === 'object' ? v : { value: v };
        if (entry.value == null) continue;
        Object.assign(out, fieldHit(f, {
          value: entry.value,
          confidence: entry.confidence ?? 0.6,
          cost: entry.cost ?? 0,
          provider: entry.provider || this.id,
        }));
      }
      return out;
    }
  })();
}

registerProvider('web-research', webResearch);
