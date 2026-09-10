// src/connectors/discovery/adapters/tender.js
// 内部信号源：**复用**既有 tenderConnector 管道（filterTenders → matchTender），不重复造匹配逻辑。
// 铁律：不在此发起网络请求（外部标讯由订阅推送进总线，编排侧经 ctx.tenders 注入命中流）。
import { ProviderAdapter, fieldHit } from '../providerAdapter.js';
import { registerProvider } from '../providerRegistry.js';
import { filterTenders } from '../../tenderConnector.js';

export function tenderAdapter(cfg = {}) {
  return new (class extends ProviderAdapter {
    constructor() {
      super({ id: 'tender', kind: 'internal-signal', scope: 'system', costTier: 0,
              coverageFields: ['tender_match', 'tender_signals'], ...cfg });
    }
    async enrich(entity, fields = [], ctx = {}) {
      const sub = ctx.tenderSubscription || this.config.subscription || { keywords: [], region: '' };
      const hits = filterTenders(sub, ctx.tenders || []);   // 委托既有管道（关键词 + 区域）
      if (!hits.length) return {};
      const out = {};
      if (fields.includes('tender_match')) {
        Object.assign(out, fieldHit('tender_match', { value: hits[0].title, confidence: 0.8, cost: 0, provider: this.id }));
      }
      if (fields.includes('tender_signals')) {
        Object.assign(out, fieldHit('tender_signals', {
          value: hits.map((h) => ({ tender_id: h.id, keyword: h.matched_keyword, amount: h.amount ?? null })),
          confidence: 0.8, cost: 0, provider: this.id,
        }));
      }
      return out;
    }
  })();
}

registerProvider('tender', tenderAdapter);
