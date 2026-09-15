// src/connectors/discovery/adapters/anysite.js — anysite.io REST 客户端（access-token:JWT）
// 铁律（对齐 qixin/xinbang）：
//   1. 无凭据 / 异常 → search 返 []、enrich 返 {}（fail-open，不抛业务异常）
//   2. 字段映射复用 discoveryRules.signals 权重键
//   3. token 绝不进前端 / 日志 / memory
//   4. 公司搜索路径前期实测 404 → 依次尝试候选路径，全失败 fail-open（不下发死路径）
// 认证：access-token header = JWT（不带 'A.' 前缀——实测 anysite 期望裸 JWT，带前缀返回 Invalid token）。
// 已验证可用端点：GET /token/statistic（探活）、POST /api/linkedin/search/companies（公司搜索）、
//   POST /api/linkedin/email/user（email 富集）。
import { ProviderAdapter, fieldHit } from '../providerAdapter.js';
import { registerProvider } from '../providerRegistry.js';

const ANY_SITE_API = process.env.ANY_SITE_API || 'https://api.anysite.io/api';
// 候选公司搜索路径（优先级降序）；真机实测：无效/缺失 token 时返回 401（端点存在、鉴权未过，非 404），
// 故仍 fail-open；需有效 JWT 方能出数，待真机校准后收敛到单一有效路径（开放项）。
// 公司搜索路径（优先级降序）：
//   1) /linkedin/search/sql/companies —— 70M 公司库 SQL 检索（支持 description/country_hq/employee_count/industry 结构化筛选；
//      官方博客确认这是「按 ICP 批量搜公司」的正确端点，live search 只能按名字搜）
//   2) /linkedin/search/companies —— live 搜索（仅 keywords 名字匹配，作为兜底）
// 认证：access-token header = 裸 JWT（不带 'A.' 前缀——实测 anysite 期望裸 JWT，带前缀返回 Invalid token）
const SEARCH_PATHS = [
  '/linkedin/search/sql/companies',
  '/linkedin/search/companies',
];

function authHeaders(ctx = {}) {
  let key = ctx.credentials?.anysite || process.env.ANY_SITE_KEY;
  if (!key) return null;
  // anysite 期望裸 JWT（实测带 'A.' 前缀会返回 Invalid token）——剥离前缀归一
  if (key.startsWith('A.')) key = key.slice(2);
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
      const data = await http('/linkedin/email/user', { email: 'health@anysite.io' }, ctx); // 已验证端点兜底探活（空邮箱会被 422，用合法占位邮箱）
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
      const count = Math.min(Number(query.limit) || 20, 50);
      // ICP 映射：
      //   industries/name/keywords → description DSL 检索词（anysite SQL 端点支持 description 全文 + DSL）
      //   erp / tech_stack 信号（SAP/Salesforce 等）→ 并入 description DSL（布尔 OR，精确短语）
      //   min_headcount → employee_count_min（收入>10亿制造业通常员工数大，用规模代理）
      const kw = [
        ...(Array.isArray(query.industries) ? query.industries : []),
        ...(Array.isArray(query.erp) ? query.erp.map((x) => `"${x}"`) : []),
        ...(query.specialities && Array.isArray(query.specialities) ? query.specialities : []),
      ].filter(Boolean);
      const dsl = query.keywords || (kw.length ? kw.join('|') : '');
      const body = { count };
      if (dsl) body.description = dsl;
      if (Array.isArray(query.geo) && query.geo.length) body.country_hq = query.geo; // ISO2
      const headMin = Number(query.min_headcount) || Number(query.employee_count_min) || 0;
      if (headMin) body.employee_count_min = headMin;
      if (query.profit_margin_pct || query.min_revenue_y) {
        // 收入/利润无原生筛选字段 → 用 headcount 与 industry 代理（高收入高利润制造业多为大企业）
        if (!headMin) body.employee_count_min = 1000;
      }
      for (const path of SEARCH_PATHS) {
        const data = await http(path, body, ctx).catch(() => null);
        const items = data?.items || data?.records || (Array.isArray(data) ? data : null);
        if (Array.isArray(items) && items.length) return items.map(candidateFromCompany).filter(Boolean);
      }
      return []; // fail-open：全候选路径 404/异常 → 空
    }
  })();
}

registerProvider('anysite', anysiteAdapter);
