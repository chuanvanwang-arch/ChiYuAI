// src/connectors/discovery/adapters/tender.js
// 内部信号源 + 主动搜索（2026-09-15 扩展：双模式 = 订阅推送 enrich + 主动 search）。
// 复用既有 tenderConnector 管道（filterTenders → matchTender），不重复造匹配逻辑。
// 主动 search（新增）：抓取公开招标公告站列表 → 本地标题关键词/区域过滤 → 候选。
// 设计：docs/2026-09-15-tender-active-search-design.md
// 铁律：
//   1. enrich() 不从网络拉取（订阅推送进 ctx.tenders）；search() 主动抓公开站（align anysite/qixin）
//   2. fail-open：无可用源 / 抓取失败 / 解析空 → 返回 []，绝不抛业务异常
//   3. 不得注入 fit_score（服务端 computeFitScore 统一计算，修订 2 契约）
//   4. GBK 转码用 Buffer.toString('latin1'). 兜底，优先 iconv-lite（若在依赖中）
import { ProviderAdapter, fieldHit } from '../providerAdapter.js';
import { registerProvider } from '../providerRegistry.js';
import { filterTenders } from '../../tenderConnector.js';

// 公开招标公告搜索源（出厂可抓源；可被 config 覆盖）
// gxjtzb.com：GBK 编码、服务端渲染、/Search.asp?k=<关键词> 精确搜索招标公告（实测 2026-09-15 有效）
const DEFAULT_SEARCH_SOURCES = [
  'https://www.gxjtzb.com/Search.asp?k=',
];

// —— 网页抓取 + GBK 转码（纯函数，可单测注入 fetch）——
async function fetchText(url, { fetchFn = fetch, ua } = {}) {
  const r = await fetchFn(url, {
    headers: { 'User-Agent': ua || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    redirect: 'follow', signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) return null;
  const buf = Buffer.from(await r.arrayBuffer());
  // gxjtzb 为 GBK/GB2312：优先 iconv-lite（惰性 import，ESM 兼容），失败则 UTF-8 兜底
  try {
    const { default: iconv } = await import('iconv-lite');
    if (iconv?.decode) return iconv.decode(buf, 'gbk');
  } catch {}
  return buf.toString('utf8'); // fallback（乱码可容忍：标题关键词仍可按 ASCII 匹配）
}

// —— HTML 链接提取（原生正则可测；只保留 /Html/ 详情页链接 + 标题）——
export function extractTenderLinks(html, base = '') {
  if (!html) return [];
  const out = [];
  const re = /<a\b[^>]*?href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = m[1].trim();
    const titleRaw = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    // gxjtzb 公告详情链接形如 /Html/?1043114.html（页面无详情页链接时跳过导航链接）
    const isDetail = href.includes('/Html/') || href.includes('.html') || href.includes('.htm');
    if (!isDetail) continue;
    // 标题噪音清洗：剥离 转载前缀 与 残缺括号对（<8 字符视为噪音，跳过）
    // 已知前缀族（2026-09-15 实测 gxjtzb 转载条）：『招标』 / 【公告】 / 《公告》 / 关于/ / 2026年度…公告」等
    const stripped = titleRaw
      .replace(/^『[^』]*』/, '')
      .replace(/^【[^】]*】/, '')
      .replace(/^《[^》]*》/, '')
      .replace(/^「[^」]*」/, '')
      .replace(/^\[[^\]]*\]/, '')
      .replace(/^关于\s*\/{0,2}/i, '')
      .replace(/^20\d{2}年度(公告)?[」】）]?/, '')
      .replace(/^20\d{2}年?\s*[-—]?/, '')   // 「2026年-」/「2026年」转载前缀（同源站重复条目）
      .replace(/^2026年度-/, '')
      .replace(/^[（(]?公告[）)]?[」】]?/, '');
    if (stripped.length < 8) continue;
    const title = stripped.replace(/^[「【《『]|[」】》』]+$/, '').trim();
    out.push({ title, url: href.startsWith('http') ? href : (base + href) });
  }
  return out;
}

// —— 候选构造（对齐 qixin mapSearchResult 风格；provider:'tender'）——
export function mapTenderCandidate(link, regionHits = []) {
  if (!link?.title) return null;
  return {
    name: link.title.slice(0, 120),     // 公告标题即"线索名"（对齐 lead 显示）
    title: link.title,
    url: link.url,
    region: regionHits.find((r) => link.title.includes(r)) || '',
    tender_match: true,                 // 命中有信号 -> 进 discoveryRules.signals.tender_match
    confidence: 0.7,                    // 公开站抓取 = 中等置信（非官方结构化）
    provider: 'tender',
  };
}

export function tenderAdapter(cfg = {}) {
  const sources = cfg.search_sources?.length ? cfg.search_sources : DEFAULT_SEARCH_SOURCES;
  const ua = cfg.ua;
  const fetchFn = cfg.__fetch || ((url, opts) => fetch(url, opts));
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
    // search()（2026-09-15 新增，align anysite/qixin）：主动抓公开标讯 → 候选。
    // query: { keywords（"ERP"|"CRM" 或数组）, industries, geo（含"北京"区域词）, limit }
    // 铁律：fail-open（无源/抓取失败/空结果 → []）；不得注入 fit_score。
    async search(query = {}, ctx = {}) {
      // ① 关键词归一：query.keywords（DSL 字符串）→ 拆 OR；query.industries 数组并入
      const kwRaw = [
        ...(Array.isArray(query.keywords) ? query.keywords : String(query.keywords || '').split('|')),
        ...(Array.isArray(query.industries) ? query.industries : []),
      ].map((k) => String(k).trim().replace(/^"|"$/g, '')).filter(Boolean);
      // ② 区域词（query.geo：['北京'|'CN-BJ'|'Beijing'] → '北京' 等中文词做标题匹配）
      const geo = Array.isArray(query.geo) ? query.geo : [];
      const regionKeywords = ['北京', 'Beijing'];
      const regionFilter = geo.some((g) => /北京|Beijing|CN-BJ|BJ/i.test(g)) ? regionKeywords : [];
      // ③ 逐关键词抓取 + 本地解析 + 区域过滤（fail-open 单源失败跳过）
      const candidates = [];
      const limit = Math.min(Number(query.limit) || 20, 50);
      for (const kw of kwRaw.slice(0, 5)) {   // 最多搜 5 个关键词（保护配额）
    for (const src of sources) {
      try {
        const searchUrl = `${src}${encodeURIComponent(kw)}`;
        const html = await fetchText(searchUrl, { fetchFn, ua });
        if (!html) continue;
        // base = 站点根（从搜索 URL 推导协议+主机，不含查询串）
        const base = (() => { try { const u = new URL(searchUrl); return `${u.protocol}//${u.host}`; } catch { return src; } })();
        const links = extractTenderLinks(html, base);
            for (const link of links) {
              const regionHits = regionFilter.filter((r) => link.title.includes(r));
              if (regionFilter.length && !regionHits.length) continue;  // 指定区域且标题不含 → 跳过
              const c = mapTenderCandidate(link, regionHits);
              if (c) candidates.push(c);
            }
          } catch { continue; }   // fail-open：单源/单关键词失败不影响整体
        }
      }
      // ④ 去重（锚点：标题尾 30 字符——`…ERP系统项目招标公告` 等主体唯一，前缀噪音不同但正文同源
      //    的转载条目会收敛为一条；首条保序优先）+ 限量 + 附 signals（tender=true 供 fit_score 加权）
      const seen = new Set();
      const out = [];
      for (const c of candidates) {
        const tail = String(c.title).replace(/\s+/g, '').slice(-30);
        if (tail.length < 12 || seen.has(tail)) continue;   // 主体过短视为噪音
        seen.add(tail);
        out.push({ ...c, signals: { tender: true } });
        if (out.length >= limit) break;
      }
      return out;
    }
  })();
}

registerProvider('tender', tenderAdapter);
