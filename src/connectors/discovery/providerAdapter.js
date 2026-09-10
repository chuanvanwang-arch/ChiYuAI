// src/connectors/discovery/providerAdapter.js
// 统一接口（设计 v8.1 §3）：enrich(entity, fields, ctx) -> { [field]: { value, confidence, cost, provider, ts } }
// 铁律：无命中必须返回 {}（不是 null）；不得抛业务异常（waterfall 侧兜底，但适配器应自愈）
export class ProviderAdapter {
  constructor(cfg = {}) {
    this.id = cfg.id;
    this.kind = cfg.kind ?? 'unknown';
    this.scope = cfg.scope ?? 'system';
    this.costTier = Number.isFinite(cfg.costTier) ? cfg.costTier : 3;
    this.enabled = cfg.enabled !== false;
    this.coverageFields = Array.isArray(cfg.coverageFields) ? [...cfg.coverageFields] : [];
    this.credentialsRef = cfg.credentialsRef ?? null;
    this.config = cfg;
  }
  async enrich() { throw new Error(`[provider:${this.id}] enrich() not implemented`); }
}

// 统一结果条目构造：保证 6 元齐全（value/confidence/cost/provider/ts），防各适配器字段漂移
export function fieldHit(field, { value, confidence = 0.5, cost = 0, provider, ts } = {}) {
  return { [field]: { value, confidence, cost, provider, ts: ts || new Date().toISOString() } };
}
