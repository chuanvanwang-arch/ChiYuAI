// src/connectors/discovery/adapters/genericRest.js — 通用 REST 租户适配器（零租户代码，差异全在 config field_map）
import { ProviderAdapter, fieldHit } from '../providerAdapter.js';

export function genericRestAdapter(cfg = {}) {
  return new (class extends ProviderAdapter {
    constructor() {
      super({ id: cfg.id, kind: 'generic-rest', scope: 'tenant', costTier: 0,
        coverageFields: Object.keys(cfg.field_map || {}), ...cfg });
    }
    async enrich(entity, fields = [], ctx = {}) {
      const { endpoint, field_map: fm, signal_map: sm, credentials } = this.config;
      if (!endpoint || !fm) return {};
      const auth = (ctx.credentials && ctx.credentials[this.id]) || credentials || null;
      const doFetch = ctx.__fetch || this.config.__fetch || ((url, opts) => fetch(url, opts));
      let data;
      try {
        const headers = auth ? { Authorization: `Bearer ${auth}` } : {};
        const r = await doFetch(`${endpoint}?q=${encodeURIComponent(entity?.name || '')}`, { headers });
        if (!r.ok) return {};
        data = await r.json();
      } catch { return {}; }
      const out = {};
      for (const f of fields) {
        const src = fm[f];
        if (src != null && data[src] != null) {
          Object.assign(out, fieldHit(f, { value: data[src], confidence: 0.7, cost: 0, provider: this.id }));
        }
      }
      if (sm) for (const [sig, src] of Object.entries(sm)) {
        if (data[src] != null) Object.assign(out, fieldHit(sig, { value: data[src], confidence: 0.6, cost: 0, provider: this.id }));
      }
      return out;
    }
  })();
}
