// test/calibration/metrics.test.js — 校准指标纯函数
// 设计依据：docs/2026-08-28-decision-quality-calibration-design.md §4
import { describe, it, expect } from 'vitest';
import { computeMetrics } from '../../src/calibration/metrics.js';

const d = (o = {}) => ({
  decision_id: 'd1', scenario_id: 'QUOTE_PRICING', disposition: 'APPROVE',
  decider_type: 'AUTONOMOUS_AGENT', state: 'AUTONOMOUS', business_tier: 'LEAD',
  human_disposition: null, human_decided_at: null, outcome: null,
  created_at: '2026-08-01T00:00:00.000Z',
  referenced_precedents: [{ precedent_id: 'p1', similarity: 0.9 }],
  conditions_evaluated: [{ cond: 'a', weight: 1, met: true }],
  trigger_context: {},
  ...o,
});

describe('computeMetrics', () => {
  it('空样本 → 全零且 sufficient_sample=false', () => {
    const m = computeMetrics([]);
    expect(m.sample_size).toBe(0);
    expect(m.autonomy_override_rate).toBe(0);
    expect(m.sufficient_sample).toBe(false);
  });

  it('自主决策被覆写 → autonomy_override_rate 正确（state 已变 REVERSED 仍计入）', () => {
    const rows = [
      d({ decision_id: 'a1', state: 'REVERSED', human_disposition: 'REJECT', outcome: 'REVERSED' }),
      d({ decision_id: 'a2', state: 'CONFIRMED', human_disposition: 'APPROVE' }),
      d({ decision_id: 'a3', state: 'AUTONOMOUS', human_disposition: null }),
    ];
    const m = computeMetrics(rows);
    expect(m.autonomy_override_rate).toBeCloseTo(1 / 3, 6);
    expect(m.autonomous_count).toBe(3);
  });

  it('升级决策超时未处置 → escalation_fatigue_rate 正确', () => {
    const now = new Date('2026-08-02T00:00:00.000Z').getTime(); // 距今 24h
    const rows = [
      d({ decision_id: 'h1', decider_type: 'HUMAN', state: 'HUMAN', human_disposition: null }),
      d({ decision_id: 'h2', decider_type: 'HUMAN', state: 'CONFIRMED', human_disposition: 'APPROVE' }),
    ];
    const m = computeMetrics(rows, { now });
    expect(m.escalation_fatigue_rate).toBeCloseTo(0.5, 6);
  });

  it('人工延迟 p50 与先例覆盖率', () => {
    const rows = [
      d({ decision_id: 'x1', human_disposition: 'APPROVE', human_decided_at: '2026-08-01T01:00:00.000Z' }),
      d({ decision_id: 'x2', human_disposition: 'APPROVE', human_decided_at: '2026-08-01T03:00:00.000Z' }),
    ];
    const m = computeMetrics(rows);
    expect(m.human_latency_p50_ms).toBe(3 * 3600 * 1000);
    expect(m.precedent_coverage_avg).toBeCloseTo(1 / 5, 6); // REPLAY_K=5
  });

  it('avg_confidence_gap_to_threshold：自主样本带 confidence 时计算距阈值 0.7 的均值', () => {
    const rows = [
      d({ decision_id: 'c1', confidence: 0.78 }),
      d({ decision_id: 'c2', confidence: 0.74 }),
      d({ decision_id: 'c3', confidence: null }), // 无 event 的样本不参与
    ];
    const m = computeMetrics(rows);
    // avgConf=(0.78+0.74)/2=0.76 → |0.7-0.76|=0.06
    expect(m.avg_confidence_gap_to_threshold).toBeCloseTo(0.06, 6);
  });
});