// src/connectors/discovery/adapters/anysite.js — anysite.io REST 客户端（access-token:JWT）
// 铁律（对齐 qixin/xinbang）：
//   1. 无凭据 / 异常 → search 返 []、enrich 返 {}（fail-open，不抛业务异常）
//   2. 字段映射复用 discoveryRules.signals 权重键
//   3. token 绝不进前端 / 日志 / memory
//   4. 公司搜索路径前期实测 404 → 依次尝试候选路径，全失败 fail-open（不下发死路径）
// 认证：access-token header = 完整 JWT（裸 UUID 会 401）。已验证可用端点：POST /api/linkedin/email/user。
import { ProviderAdapter, fieldHit } from '../providerAdapter.js';
import { registerProvider } from '../providerRegistry.js';

const ANY_SITE_API = process.env.ANY_SITE_API || 'https://api.anysite.io/api';
// 候选公司搜索路径（优先级降序）；实测 /api/db/linkedin/search/companies 与 /api/linkedin/search/companies 均 404，
// 故全量 fail-open，待真机校准后收敛到单一有效路径（开放项）。
const SEARCH_PATHS = [
  '/db/linkedin/search/companies',
  '/linkedin/search/companies',
  '/linkedin/company/search',
];

function authHeaders(ctx = {}) {
  const key = ctx.credentials?.anysite || process.env.ANY_SITE_KEY;
  if (!key) return null;
  return { 'access-token': key, 'Content-Type': 'application/json' };
}

async function postJson(path, body, ctx) {
  const headers = authHeaders(ctx);
  if (!headers) return null;
  try {
    const r = await fetch(`${ANY_SITE_API}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

const candidateFromCompany = (it) => it && it.name ? {
  name: it.name, domain: it.domain || '', industry: it.industry, revenue: it.revenue,
  funding_round: false, hiring_icp_role: false, tender_match: false,
  confidence: 0.7, provider: 'anysite', url: it.url, location: it.location,
} : null;

const companyFromHeadline = (headline) => {
  if (!headline) return null;
  const at = /@\s*([^,，]+)/.exec(headline);
  if (at) return at[1].trim();
  const sep = /^(.+?)[\s]*[-–—|｜][\s]*.+$/.exec(headline);
  if (sep && sep[1].trim().length >= 2) return sep[1].trim();
  return null;
};

export function anysiteAdapter(cfg = {}) {
  const http = cfg.__http || postJson;
  return new (class extends ProviderAdapter {
    constructor() {
      super({ id: 'anysite', kind: 'firmographics', scope: 'paid', costTier: 2,
        coverageFields: ['industry', 'registered_address', 'legal_person', 'employees'], ...cfg });
    }

    async health(ctx = {}) {
      if (cfg.__mock?.statistic) return { ok: !!cfg.__mock.statistic.ok, valid: !!cfg.__mock.statistic.valid, ts: new Date().toISOString() };
      const headers = authHeaders(ctx);
      if (!headers) return { ok: false, valid: false, detail: 'no credentials' };
      const data = await http('/linkedin/email/user', { email: '' }, ctx); // 已验证端点兜底探活
      return { ok: data !== null, valid: data !== null, ts: new Date().toISOString() };
    }

    // 富集：email 查找（已验证可用端点），回退 name 搜索
    async enrich(entity = {}, fields = [], ctx = {}) {
      if (cfg.__mock) {
        const out = {};
        for (const f of fields) if (cfg.__mock[f] != null) Object.assign(out, fieldHit(f, { value: cfg.__mock[f], confidence: 0.8, cost: this.costTier, provider: this.id }));
        return out;
      }
      const key = ctx.credentials?.anysite || process.env.ANY_SITE_KEY;
      if (!key) return {};
      if (entity.email) {
        const data = await http('/linkedin/email/user', { email: entity.email }, ctx);
        const prof = Array.isArray(data) ? data[0] : (data?.items?.[0]);
        const out = {};
        if (prof?.name && fields.includes('industry')) Object.assign(out, fieldHit('industry', { value: prof.industry || prof.headline || '', confidence: 0.7, cost: this.costTier, provider: this.id }));
        if (prof?.location && fields.includes('registered_address')) Object.assign(out, fieldHit('registered_address', { value: prof.location, confidence: 0.6, cost: this.costTier, provider: this.id }));
        return out;
      }
      return {}; // 无 email 富集约等于空（name 搜索在 search 侧覆盖）
    }

    async search(query = {}, ctx = {}) {
      if (cfg.__mock?.companies || cfg.__mock?.people) {
        const list = cfg.__mock.companies || cfg.__mock.people || [];
        return list.map((c) => ({ ...c, provider: 'anysite', confidence: 0.8 }));
      }
      const key = ctx.credentials?.anysite || process.env.ANY_SITE_KEY;
      if (!key) return [];
      const keywords = (query.industries || []).join(' ') || query.name || query.keywords || '';
      const count = Math.min(Number(query.limit) || 20, 50);
      for (const path of SEARCH_PATHS) {
        const data = await http(path, { keywords, count }, ctx).catch(() => null);
        const items = data?.items || (Array.isArray(data) ? data : null);
        if (Array.isArray(items) && items.length) return items.map(candidateFromCompany).filter(Boolean);
      }
      return []; // fail-open：全候选路径 404/异常 → 空
    }
  })();
}

registerProvider('anysite', anysiteAdapter);
