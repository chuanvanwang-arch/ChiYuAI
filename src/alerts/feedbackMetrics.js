// src/alerts/feedbackMetrics.js — 反馈回路 per-tier 指标纯函数（无状态无 PG 依赖）
// 设计输入：docs/2026-08-25-alert-feedback-loop-design.md §D（feedbackMetrics）+ 总设计 §3.10（决策质量监控）
// 职责：computePerTierMetrics(decisions) → {metricsByTier}
//  - 自主率 = outcome='autonomous' 占比 / 升级率 = outcome='escalated' 占比
//  - 推翻率 = overturned=true 占比 / 平均决策时延 = (completed_at − created_at) 均值秒数（无完成不含）

export function computePerTierMetrics(decisions) {
  const byTier = {};
  for (const d of decisions || []) {
    const tier = d.tier || 'unknown';
    if (!byTier[tier]) {
      byTier[tier] = { total: 0, autonomous: 0, escalated: 0, overturned: 0, latencySum: 0, latencyCount: 0 };
    }
    const t = byTier[tier];
    t.total++;
    if (d.outcome === 'autonomous') t.autonomous++;
    if (d.outcome === 'escalated') t.escalated++;
    if (d.overturned) t.overturned++;
    if (typeof d.created_at === 'number' && typeof d.completed_at === 'number') {
      t.latencySum += d.completed_at - d.created_at;
      t.latencyCount++;
    }
  }

  const metricsByTier = {};
  for (const [tier, t] of Object.entries(byTier)) {
    metricsByTier[tier] = {
      autonomy_rate: t.autonomous / t.total,
      escalation_rate: t.escalated / t.total,
      overturn_rate: t.overturned / t.total,
      avg_decision_latency_s: t.latencyCount ? t.latencySum / t.latencyCount : null,
    };
  }
  return { metricsByTier };
}