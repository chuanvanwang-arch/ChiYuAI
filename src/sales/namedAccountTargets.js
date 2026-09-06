// src/sales/namedAccountTargets.js — 目标指标配置纯函数（零 DB，浏览器 + vitest 共用）
// 设计：docs/2026-08-29-sales-crm-integration-design-v1-full-layers.md §13
// 契约：DEFAULTS 幂等；tierOf/visitsInWindow/visitTargetFor 供 account-360 与 named-accounts 看板消费；
//       mergedTargets 供 router PUT 合并（写经决策第0闸后落 config_store['named-account-targets']）

export const DEFAULTS = {
  tiers: [
    { tier: '重点', visit_freq: { times: 1, window: 'week' } },
    { tier: '目标', visit_freq: { times: 1, window: 'month' } },
    { tier: '潜力', visit_freq: { times: 1, window: 'quarter' } },
  ],
  window_days: { week: 7, month: 30, quarter: 90 },
  metrics: ['visit', 'lead', 'deal', 'contract'],
  tier_rule: 'by_payload',
};

// 合并读：DEFAULTS 铺底 + 已存配置覆写（键级合并，防漏字段）
export function mergedTargets(stored = {}) {
  const s = stored || {};
  return {
    ...DEFAULTS,
    ...s,
    tiers: Array.isArray(s.tiers) ? s.tiers : DEFAULTS.tiers,
    window_days: { ...DEFAULTS.window_days, ...(s.window_days || {}) },
    metrics: Array.isArray(s.metrics) ? s.metrics : DEFAULTS.metrics,
  };
}

// 档位判定：payload.tier 命中 tiers → 该档；未命中 → 最后档（保守默认=潜力）
export function tierOf(accountPayload = {}, targets = DEFAULTS) {
  const t = accountPayload.tier || '潜力';
  return targets.tiers.find((x) => x.tier === t) || targets.tiers[targets.tiers.length - 1] || null;
}

// 窗口天数（缺省 → 30）
export function windowDays(window, targets = DEFAULTS) {
  const days = (targets.window_days || DEFAULTS.window_days)[window];
  return typeof days === 'number' ? days : 30;
}

// 窗口内实际拜访次数（visit_notes[].at 在窗口内计数；JSONB 数组必须 Array.isArray 判定——铁律）
export function visitsInWindow(accountPayload = {}, window, targets = DEFAULTS) {
  const notes = Array.isArray(accountPayload.visit_notes) ? accountPayload.visit_notes : [];
  const days = windowDays(window, targets);
  const cutoff = Date.now() - days * 86400000;
  return notes.filter((n) => n?.at && new Date(n.at).getTime() >= cutoff).length;
}

// 单客户达标判定：{target, actual, pass, window, tier}
export function visitTargetFor(accountPayload = {}, targets = DEFAULTS) {
  const tier = tierOf(accountPayload, targets);
  if (!tier) return { target: null, actual: 0, pass: false, window: null, tier: null };
  const w = tier.visit_freq?.window || 'month';
  const actual = visitsInWindow(accountPayload, w, targets);
  return {
    target: tier.visit_freq?.times || 1,
    actual,
    pass: actual >= (tier.visit_freq?.times || 1),
    window: w,
    tier: tier.tier,
  };
}

// 应访日 = 最近拜访日 + 窗口天数；无拜访 → assignedAt + 窗口天数
// 窗口由档位配置（named-account-targets tiers[].visit_freq.window）唯一决定；天数 window_days 可配
export function visitDueAt(payload = {}, tier, targets = DEFAULTS, assignedAt = new Date()) {
  const w = (tierOf({ tier }, targets)?.visit_freq?.window) || 'month';
  const days = windowDays(w, targets);
  const notes = Array.isArray(payload.visit_notes) ? payload.visit_notes : [];
  const last = notes.map(n => n?.at ? new Date(n.at).getTime() : NaN)
    .filter(t => !Number.isNaN(t)).sort((a, b) => b - a)[0];
  const base = last != null ? new Date(last) : new Date(assignedAt);
  return new Date(base.getTime() + days * 86400000);
}

// ④ 指标口径映射（接通引擎）：把 config_store['named-account-targets'].metrics 的 code 映射为可读标签
// 此前 metrics 仅存储透传、前端写死串；现由本函数驱动前端渲染（account-360 target-card / behavior-standard-config ④）
export const METRIC_LABELS = {
  visit: '拜访记录',
  lead: '线索阶段',
  deal: '非线索商机',
  contract: '合同',
};

// 读已合并配置的指标列表 → [{code,label}]（缺省返回 4 默认维，保证页面不空）
export function metricDimensions(targets = DEFAULTS) {
  const codes = Array.isArray(targets?.metrics) && targets.metrics.length
    ? targets.metrics
    : DEFAULTS.metrics;
  return codes.map((c) => ({ code: c, label: METRIC_LABELS[c] || c }));
}