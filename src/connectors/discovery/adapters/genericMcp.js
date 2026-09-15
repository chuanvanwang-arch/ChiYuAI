// src/connectors/discovery/adapters/genericMcp.js — 通用 MCP 租户适配器（拉取租户 MCP Server 暴露的 resource/tool）
import { ProviderAdapter, fieldHit } from '../providerAdapter.js';

export function genericMcpAdapter(cfg = {}) {
  return new (class extends ProviderAdapter {
    constructor() {
      super({ id: cfg.id, kind: 'generic-mcp', scope: 'tenant', costTier: 0,
        coverageFields: Object.keys(cfg.field_map || {}), ...cfg });
    }
    async enrich(entity, fields = [], ctx = {}) {
      const { endpoint, field_map: fm, credentials, mcpTransport = 'http' } = this.config;
      if (!endpoint || !fm) return {};
      const auth = (ctx.credentials && ctx.credentials[this.id]) || credentials || null;
      const fetchMcp = ctx.__mcpFetch || this.config.__mcpFetch || ((url, opts) => fetch(url, opts));
      let data;
      try {
        const r = await fetchMcp(`${endpoint}/resources`, { headers: auth ? { Authorization: `Bearer ${auth}` } : {} });
        if (!r.ok) return {};
        data = await r.json();
      } catch { return {}; }
      const out = {};
      for (const f of fields) {
        const src = fm[f];
        if (src != null && data[src] != null) Object.assign(out, fieldHit(f, { value: data[src], confidence: 0.7, cost: 0, provider: this.id }));
      }
      return out;
    }
  })();
}
