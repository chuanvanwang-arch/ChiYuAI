// src/monitor/enrichmentMetrics.js — P0-3a 富集成本/命中率聚合（设计 docs/2026-09-15-anysite-borrowing-analysis.md §3 P0-3）
// 案例依据 F5：智能过滤 > 批量富集（452 邮箱 / 143,785 画像 = 0.3% 富集率，是精度不是浪费）。
// 铁律：
//   ① 纯函数、零 DB、零副作用（单测友好）
//   ② 抗假绿：分母恒真实——enriched>0 才计率；空记录不虚造命中率
//   ③ 聚合多源累计（cost/calls/hits 分别求和，再算总率）
export function computeEnrichmentRate({ enriched = 0, withContacts = 0 } = {}) {
  const denominator = enriched > 0 ? enriched : 0;
  const rate = denominator > 0 ? withContacts / denominator : 0;
  return { rate, hits: withContacts, denominator };
}

export function aggregateEnrichment(records = []) {
  const list = Array.isArray(records) ? records : [];
  const totalCost = list.reduce((s, r) => s + (Number(r.cost) || 0), 0);
  const calls = list.reduce((s, r) => s + (Number(r.calls) || 0), 0);
  const hits = list.reduce((s, r) => s + (Number(r.hits) || 0), 0);
  const { rate } = computeEnrichmentRate({ enriched: calls, withContacts: hits });
  return { totalCost, calls, hits, rate };
}
