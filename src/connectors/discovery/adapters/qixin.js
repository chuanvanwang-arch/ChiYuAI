// src/connectors/discovery/adapters/qixin.js — 启信慧眼：企业画像 / 招投标 / 融资 / 招聘
// 信号字段名 funding_round/hiring_icp_role/tender_match 命中 discoveryRules.signals 既有权重键 → 自动进 intent_score
import { ProviderAdapter, fieldHit } from '../providerAdapter.js';
import { registerProvider } from '../providerRegistry.js';

const QIXIN_API = process.env.QIXIN_API || 'https://api.qixin.com/openapi';

// P1-2（2026-09-15）：search 结果单条映射（纯函数，可单测）——hiring 岗位层级下钻。
//   源返回招聘岗位字符串时附 hiring_role（首层职级词）；无岗位信息 → 不附（fail-open，评分按默认 1.0）。
//   布尔信号字段（funding_round/hiring_icp_role/tender_match）保持既有契约（discoveryRules.signals 命中键）。
export function mapSearchResult(d = {}) {
  const out = {
    name: d.name, domain: d.domain, industry: d.industry, revenue: d.revenue,
    funding_round: !!d.latest_funding_round, hiring_icp_role: !!d.hiring_icp_role,
    tender_match: !!d.latest_tender, confidence: 0.8, provider: 'qixin',
  };
  const role = typeof d.hiring_icp_role === 'string' ? d.hiring_icp_role : (d.hiring_role || '');
  if (role) out.hiring_role = role;   // fail-open：有则附，无则缺（向后兼容）
  return out;
}

export function qixinAdapter(cfg = {}) {
  return new (class extends ProviderAdapter {
    constructor() {
      super({ id: 'qixin', kind: 'firmographics', scope: 'paid', costTier: 2,
        coverageFields: ['registered_address', 'legal_person', 'biz_status',
                         'funding_round', 'hiring_icp_role', 'tender_match'], ...cfg });
    }
    async enrich(entity, fields = [], ctx = {}) {
      // __mock 仅单测注入；生产走真实 API
      if (cfg.__mock) {
        const out = {};
        for (const f of fields) {
          if (cfg.__mock[f] != null) Object.assign(out, fieldHit(f, { value: cfg.__mock[f], confidence: 0.8, cost: this.costTier, provider: this.id }));
        }
        return out;
      }
      const key = ctx.credentials?.qixin || process.env.QIXIN_KEY;
      if (!key) return {};
      const q = entity?.name || entity?.registered_address;
      if (!q) return {};
      let res;
      try {
        const r = await fetch(`${QIXIN_API}/company?name=${encodeURIComponent(q)}`, { headers: { Authorization: `Bearer ${key}` } });
        if (!r.ok) return {};
        res = await r.json();
      } catch { return {}; }
      const d = res?.data || {};
      const out = {};
      const map = { registered_address: d.registered_address, legal_person: d.legal_person, biz_status: d.biz_status,
                    funding_round: d.latest_funding_round, hiring_icp_role: d.hiring_icp_role, tender_match: d.latest_tender };
      for (const f of fields) {
        if (map[f] != null) Object.assign(out, fieldHit(f, { value: map[f], confidence: 0.8, cost: this.costTier, provider: this.id }));
      }
      return out;
    }
    // search()：拓客批量搜索（强信号数据源）——新增可选能力，不改基类。
    // 铁律：无凭据/异常 → 返回 []（fail-open）；不得注入 fit_score（修订 2，服务端 computeFitScore 计算）
    async search(query = {}, ctx = {}) {
      if (cfg.__mock) {
        const out = Array.isArray(cfg.__mock.companies) ? cfg.__mock.companies : [];
        return out.map((c) => ({ ...c, provider: 'qixin' }));
      }
      const key = ctx.credentials?.qixin || process.env.QIXIN_KEY;
      if (!key) return [];
      const q = { industries: query.industries || [], min_revenue: query.min_revenue, min_headcount: query.min_headcount, geo: query.geo || [], limit: query.limit || 20 };
      try {
        const r = await fetch(`${QIXIN_API}/company/search`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify(q) });
        if (!r.ok) return [];
        const res = await r.json();
        const list = Array.isArray(res?.data?.list) ? res.data.list : [];
        return list.map((d) => mapSearchResult(d));
      } catch { return []; }
    }
  })();
}

registerProvider('qixin', qixinAdapter);
