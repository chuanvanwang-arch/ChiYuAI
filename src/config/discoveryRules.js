// src/config/discoveryRules.js
// 线索发现规则：ICP / 数据源三档 / 信号权重 / 查重条件 / 编排 playbooks
// 铁律：
//   1. 唯一事实源 = config_store['discovery-rules']（per-tenant）；本文件仅存「出厂默认」兜底
//   2. 阈值/权重/顺序 100% 配置化，禁硬编码（对齐 src/decision/retroTrigger.js:19-44 范式）
//   3. 付费源（scope='paid'）出厂 enabled:false，需显式授权 + 填 key（D1）
//   4. 租户隔离：(tenant_id, key) 收敛；system 仅作模板源（configStore.js:16-49 autoSeed 懒克隆）
import { readConfig as storeRead } from './configStore.js';

export const DEFAULT_DISCOVERY_RULES = Object.freeze({
  icp: {
    industries: ['industrial_coatings', 'chemical', 'additives'],
    min_headcount: 50,
    geo: ['CN'],
    min_confidence: 0.6,
  },
  // 三档数据源：system（出厂启用）/ system-candidate（按行业启用）/ paid（严禁默认启用）
  providers: [
    { id: 'email-verify', kind: 'email/phone',       scope: 'system',           costTier: 1, enabled: true },
    { id: 'web-research', kind: 'web/serp',          scope: 'system',           costTier: 0, enabled: true },
    { id: 'tender',       kind: 'internal-signal',   scope: 'system',           costTier: 0, enabled: true },
    { id: 'gaode',        kind: 'geo_firmographics', scope: 'system',           costTier: 1, enabled: true },
    { id: 'attio',        kind: 'firmographics',     scope: 'system-candidate', costTier: 2, enabled: false },
    { id: 'zhizao',       kind: 'biz-verify',        scope: 'system-candidate', costTier: 1, enabled: false },
    { id: 'clearbit',     kind: 'firmographics',     scope: 'paid',             costTier: 3, enabled: false },
    { id: 'linkedin',     kind: 'social',            scope: 'paid',             costTier: 3, enabled: false },
    { id: 'qixin',        kind: 'firmographics',     scope: 'paid',             costTier: 2, enabled: false },
    { id: 'anysite',      kind: 'firmographics',     scope: 'paid',             costTier: 2, enabled: false },
    { id: 'xinbang',      kind: 'social',            scope: 'paid',             costTier: 2, enabled: false },
  ],
  signals: {
    funding_round:     { weight: 0.9 },
    hiring_icp_role:   { weight: 0.7 },
    tender_match:      { weight: 0.8 },
    leadership_change: { weight: 0.5 },
    tech_adopt:        { weight: 0.6 },
    website_redesign:  { weight: 0.3 },
    social_content:    { weight: 0.4 },
  },
  // P0-1c（2026-09-15）：信号时间字段映射 + 衰减档（设计 docs/2026-09-15-anysite-borrowing-analysis.md §3）。
  // 发现侧信号在 discoverySchema/buildDiscoveryPayload 里以 provider 类型命名（funding_round/hiring_icp_role/tender_match/social_content），
  // 时间戳沿 discoveryOrchestrator.js:90 signals.map 透传——此处给出「信号类型 → ts 字段」映射与衰减档（缺省不衰减，向后兼容）
  signal_time_fields: {
    funding_round:   'funding_ts',
    hiring_icp_role: 'hiring_ts',
    tender_match:    'tender_ts',
    social_content:  'social_ts',
  },
  signal_age_tiers: [
    { max_days: 7,  multiplier: 1.0 },
    { max_days: 30, multiplier: 0.6 },
    { max_days: 90, multiplier: 0.3 },
    { max_days: null, multiplier: 0.1 },
  ],
  // 查重条件（配置驱动列组；对齐 Twenty flatObjectMetadata.duplicateCriteria，禁硬编码匹配键）
  duplicate_criteria: {
    CRM_ACCOUNT: [['external_id'], ['domain'], ['linkedin_url'], ['name']],
    CRM_CONTACT: [['external_id'], ['email']],
  },
  // 可组合编排 playbooks（C1）：出厂不预置 —— Task 14 定义段 schema，Task 21 按行业播种
  playbooks: [],
});

// 纯函数合并：出厂默认 ⊕ 租户覆盖（无 IO，单测友好）
//   语义：icp/signals/duplicate_criteria 浅合并；providers 以 id 为键覆盖（不增删条数，防租户越权新增付费源）
export function mergeDiscoveryRules(base, tenantCfg = {}) {
  const out = structuredClone(base);
  if (tenantCfg.icp) Object.assign(out.icp, tenantCfg.icp);
  if (tenantCfg.signals) Object.assign(out.signals, tenantCfg.signals);
  if (tenantCfg.duplicate_criteria) Object.assign(out.duplicate_criteria, tenantCfg.duplicate_criteria);
  if (Array.isArray(tenantCfg.providers)) {
    const byId = Object.fromEntries(out.providers.map((p) => [p.id, p]));
    for (const p of tenantCfg.providers) {
      if (byId[p.id]) Object.assign(byId[p.id], p); // 仅覆盖既有 id
    }
  }
  if (Array.isArray(tenantCfg.playbooks)) out.playbooks = structuredClone(tenantCfg.playbooks);
  return out;
}

// 租户感知加载：读 config_store（自带 system 模板 autoSeed 懒克隆）⊕ 出厂默认
//   deps.readConfig 可注入 → 单测无需 PG；fail-open：读失败回退出厂默认，不阻断调用方
export async function mergedDiscoveryRules({ tenantId = 'system' } = {}, deps = {}) {
  try {
    const read = deps.readConfig || ((key, opts) => storeRead(key, opts));
    const row = await read('discovery-rules', { tenantId });
    return mergeDiscoveryRules(DEFAULT_DISCOVERY_RULES, row?.value || {});
  } catch {
    return structuredClone(DEFAULT_DISCOVERY_RULES);
  }
}
