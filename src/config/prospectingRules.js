// src/config/prospectingRules.js — 拓客规则（ICP / 信号权重 / 数据源 / 上限）
// 设计输入：docs/2026-09-14-prospecting-module-design.md §3
// 铁律：唯一事实源 = config_store['prospecting-rules']（per-tenant）；本文件仅存「出厂默认」兜底
//   阈值/权重 100% 配置化；付费源（qixin/xinbang）出厂 enabled:false，需显式授权+填 key（D1）
//   合并语义：sources 以 id 为键覆盖（不增删条数，防租户越权新增付费源）
//   fit_score 服务端计算（修订 2）：适配器不得注入，统一走 computeFitScore
import { readConfig as storeRead } from './configStore.js';

export const DEFAULT_PROSPECTING_RULES = Object.freeze({
  icp: {
    industries: [],
    min_revenue_y: 1e8,
    min_headcount: 50,
    geo: ['CN'],
  },
  signals: { hiring: 0.7, funding: 0.9, tender: 0.8, social: 0.4 },
  sources: {
    qixin:   { enabled: false, weight: 0.6 },
    xinbang: { enabled: false, weight: 0.2 },
    anysite: { enabled: false, weight: 0.2 },
    tender:  { enabled: false, weight: 0.8 },   // 2026-09-15：标讯主动搜索源（design docs/2026-09-15-tender-active-search-design.md）
  },
  candidate_limit: 50,
  fit_threshold: 0.6,
  // P0-1b（2026-09-15）：信号时间衰减档（设计 §3.1）。缺省不衰减（空档 → 1.0，向后兼容）
  signal_age_tiers: [],
  // P1-2（2026-09-15）：hiring 岗位层级分层（设计 §4.2）。缺省不分层（全按 1.0，向后兼容）
  hiring_role_tiers: {},
  hiring_role_weight: {},
});

// 纯函数合并（无 IO，单测友好）：icp/signals 浅合并；sources 以 id 为键覆盖（不增删）
export function mergeProspectingRules(base, tenantCfg = {}) {
  const out = structuredClone(base);
  if (tenantCfg.icp) Object.assign(out.icp, tenantCfg.icp);
  if (tenantCfg.signals) Object.assign(out.signals, tenantCfg.signals);
  if (tenantCfg.sources && typeof tenantCfg.sources === 'object') {
    for (const id of Object.keys(out.sources)) {
      if (tenantCfg.sources[id]) Object.assign(out.sources[id], tenantCfg.sources[id]);
    }
  }
  if (typeof tenantCfg.candidate_limit === 'number') out.candidate_limit = tenantCfg.candidate_limit;
  if (typeof tenantCfg.fit_threshold === 'number') out.fit_threshold = tenantCfg.fit_threshold;
  if (Array.isArray(tenantCfg.signal_age_tiers)) out.signal_age_tiers = structuredClone(tenantCfg.signal_age_tiers);
  if (tenantCfg.hiring_role_tiers && typeof tenantCfg.hiring_role_tiers === 'object') out.hiring_role_tiers = structuredClone(tenantCfg.hiring_role_tiers);
  if (tenantCfg.hiring_role_weight && typeof tenantCfg.hiring_role_weight === 'object') out.hiring_role_weight = structuredClone(tenantCfg.hiring_role_weight);
  return out;
}

// 租户感知加载：读 config_store ⊕ 出厂默认；fail-open 读失败回退出厂
export async function mergedProspectingRules({ tenantId = 'system' } = {}, deps = {}) {
  try {
    const read = deps.readConfig || ((key, opts) => storeRead(key, opts));
    const row = await read('prospecting-rules', { tenantId });
    return mergeProspectingRules(DEFAULT_PROSPECTING_RULES, row?.value || {});
  } catch {
    return structuredClone(DEFAULT_PROSPECTING_RULES);
  }
}

// 服务端 fit_score 计算（T3 就绪；T5 handler 调用）：
//   Σ(命中信号 × 权重) / Σ权重 —— 未命中按 0 计；适配器不得注入 fit_score（修订 2）
// P0-1b（2026-09-15）：命中信号按新鲜度衰减——sigTs 映射表（config 驱动，缺省空 → 不衰减）；
//   ts 取 candidate.signals.*_ts；无 ts → 1.0（向后兼容）。
// P1-2（2026-09-15）：hiring 命中时按岗位层级系数加权（hiring_role_tiers/hiring_role_weight）。
import { freshnessMultiplier, ageDaysOf } from './signalFreshness.js';

// 信号 → 时间戳字段映射（写死为 *_ts 约定；与 P0-1 设计一致；配置侧可通过 signal_field_map 覆盖）
const SIGNAL_TS_FIELD = {
  hiring: 'hiring_ts', funding: 'funding_ts', tender: 'tender_ts', social: 'social_ts',
};

export function computeFitScore(candidate, rules) {
  const signals = candidate.signals || {};
  const w = rules.signals || {};
  const tiers = rules.signal_age_tiers || [];
  let num = 0, den = 0;
  for (const [k, weight] of Object.entries(w)) {
    if (typeof weight !== 'number') continue;
    den += weight;
    if (!signals[k]) continue;           // 未命中按 0
    let mult = 1.0;
    // 时间衰减（P0-1b）：无 tiers 或 ts → 1.0（向后兼容）
    if (tiers.length) {
      const ts = signals[`${k}_ts`] || signals[SIGNAL_TS_FIELD[k]];
      mult = freshnessMultiplier(ageDaysOf(ts), tiers);
    }
    // hiring 岗位层级（P1-2）：hiring_role 命中层级词 → 层级权重，否则 1.0
    if (k === 'hiring') {
      const role = candidate.hiring_role || '';
      const roleTiers = rules.hiring_role_tiers || {};
      const roleWeight = rules.hiring_role_weight || {};
      for (const [tier, words] of Object.entries(roleTiers)) {
        if (Array.isArray(words) && words.some((wd) => role.includes(wd))) {
          mult *= roleWeight[tier] ?? 1.0;
          break;
        }
      }
    }
    num += weight * mult;
  }
  return den > 0 ? num / den : 0;
}
