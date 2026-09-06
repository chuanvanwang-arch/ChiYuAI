// src/calibration/metrics.js — 决策质量度量（纯函数，无 PG 依赖）
// 设计依据：docs/2026-08-28-decision-quality-calibration-design.md §4
// 口径：决策来源以 decider_type 判定（AUTONOMOUS_AGENT=自主 / HUMAN=升级），
//   不用 state —— P0 后覆写会使 state 变为 REVERSED，用 state 筛会把被覆写样本排除、指标恒为 0。
import { REPLAY_K, MIN_SAMPLE, FATIGUE_HOURS } from './constants.js';

const isOverridden = (x) => Boolean(x.human_disposition) && x.human_disposition !== x.disposition;

// R4 敏感性代理：分项得分强/弱组的覆写率差（相关性系数需回归，小样本不成立——设计 §1 范围外 A/B 同理）
// 输入约定：调用方可在决策行上附加 confidence（JOIN decision_event.payload 得，设计 F7 的读取路径）
function sensitivityGap(autonomous, pickScore) {
  const withScore = autonomous.map((x) => ({ ...x, _s: pickScore(x) }));
  const strong = withScore.filter((x) => x._s >= 0.7);
  const weak = withScore.filter((x) => x._s < 0.7);
  if (!strong.length || !weak.length) return 0;
  const rate = (arr) => arr.filter(isOverridden).length / arr.length;
  return rate(strong) - rate(weak);
}

export function computeMetrics(decisions, { now = Date.now(), fatigueHours = FATIGUE_HOURS, minSample = MIN_SAMPLE } = {}) {
  const list = Array.isArray(decisions) ? decisions : [];
  const n = list.length;

  const autonomous = list.filter((x) => x.decider_type === 'AUTONOMOUS_AGENT');
  const escalated = list.filter((x) => x.decider_type === 'HUMAN');
  const reviewed = list.filter((x) => x.human_disposition);

  const autonomyOverrideRate = autonomous.length
    ? autonomous.filter(isOverridden).length / autonomous.length : 0;
  const escalatedOverrideRate = escalated.length
    ? escalated.filter(isOverridden).length / escalated.length : 0;

  const fatigueMs = fatigueHours * 3600 * 1000;
  const fatigue = escalated.filter(
    (x) => !x.human_disposition && (now - new Date(x.created_at).getTime()) >= fatigueMs).length;

  const latencies = reviewed
    .filter((x) => x.human_decided_at && x.created_at)
    .map((x) => new Date(x.human_decided_at).getTime() - new Date(x.created_at).getTime())
    .sort((a, b) => a - b);
  const p50 = latencies.length ? latencies[Math.floor(latencies.length / 2)] : null;

  const coverageOf = (x) =>
    Math.min((Array.isArray(x.referenced_precedents) ? x.referenced_precedents.length : 0) / REPLAY_K, 1);

  // R1 依赖：自主样本平均置信度距阈值的绝对值（阈值硬编码有技术债，P1 配置外置后由调用方传入；
  //   2026-09-02 随缺省阈值调低 0.8 → 0.7 同步口径）
  const confs = autonomous.filter((x) => typeof x.confidence === 'number').map((x) => x.confidence);
  const avgConf = confs.length ? confs.reduce((s, c) => s + c, 0) / confs.length : null;
  const avgConfidenceGapToThreshold = avgConf == null ? 0 : Math.abs(0.7 - avgConf);

  // R4 依赖：methodScore / coverage / similarity 强组的覆写率差（强组覆写显著高于弱组 → 该分项是覆写主因）
  const methodScoreOf = (x) => {
    const cs = Array.isArray(x.conditions_evaluated) ? x.conditions_evaluated : [];
    if (!cs.length) return 1.0;
    const total = cs.reduce((s, c) => s + (c.weight || 1), 0);
    return total ? cs.reduce((s, c) => s + (c.weight || 1) * (c.met ? 1 : 0), 0) / total : 1.0;
  };
  const coverageScoreOf = coverageOf;

  return {
    sample_size: n,
    autonomous_count: autonomous.length,
    escalated_count: escalated.length,
    reviewed_count: reviewed.length,
    autonomy_rate: n ? autonomous.length / n : 0,
    escalate_rate: n ? escalated.length / n : 0,
    autonomy_override_rate: autonomyOverrideRate,
    escalated_override_rate: escalatedOverrideRate,
    escalation_fatigue_rate: escalated.length ? fatigue / escalated.length : 0,
    human_latency_p50_ms: p50,
    reversal_rate: n ? list.filter((x) => x.outcome === 'REVERSED').length / n : 0,
    precedent_coverage_avg: n ? list.reduce((s, x) => s + coverageOf(x), 0) / n : 0,
    avg_confidence_gap_to_threshold: avgConfidenceGapToThreshold,
    weight_sensitivity_method: autonomous.length ? sensitivityGap(autonomous, methodScoreOf) : 0,
    weight_sensitivity_coverage: autonomous.length ? sensitivityGap(autonomous, coverageScoreOf) : 0,
    weight_sensitivity_similarity: autonomous.length
      ? sensitivityGap(autonomous, (x) => {
          const p = Array.isArray(x.referenced_precedents) ? x.referenced_precedents : [];
          return p.length ? p.reduce((s, q) => s + (Number(q.similarity) || 0), 0) / p.length : 0;
        })
      : 0,
    sufficient_sample: n >= minSample,
  };
}