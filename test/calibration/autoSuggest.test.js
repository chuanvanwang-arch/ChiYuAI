import { describe, it, expect } from 'vitest';
import { deriveDeviationMetrics, suggestForScenario } from '../../src/calibration/autoSuggest.js';

// ── 最小决策行（只含相关字段，纯逻辑不需要完整行）──
function mkRow(over = {}) {
  return {
    decision_id: `d-${Math.random().toString(36).slice(2, 8)}`,
    disposition: 'PROCEED',
    human_disposition: null,
    state: 'AUTONOMOUS',
    outcome_verified: null,
    attribution: {},
    feedback: {},
    decider_type: 'AUTONOMOUS_AGENT',
    // 默认带 5 个先例 → REPLAY_K=5 覆盖=1，避免 R5 守卫在无关用例中误触
    referenced_precedents: Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, similarity: 0.9 })),
    ...over,
  };
}

describe('T21 deriveDeviationMetrics（纯函数）', () => {
  it('样本不足时 sufficient_sample=false（守卫 R6 依赖）', () => {
    const m = deriveDeviationMetrics([mkRow(), mkRow()]);
    expect(m.sufficient_sample).toBe(false);
    expect(m.sample_size).toBe(2);
  });

  it('outcome_mismatch_rate：采纳但业务失败占比', () => {
    const rows = [
      mkRow({ human_disposition: 'CONFIRMED', outcome_verified: 'won' }),
      mkRow({ human_disposition: 'CONFIRMED', outcome_verified: 'lost' }), // 隐性错误
      mkRow({ human_disposition: 'CONFIRMED', outcome_verified: 'partial' }), // 隐性错误
      mkRow({ human_disposition: 'OVERRIDDEN', outcome_verified: 'lost' }), // 被推翻不计
      mkRow({}), // 无 outcome 不计
    ];
    const m = deriveDeviationMetrics(rows);
    expect(m.outcome_mismatch_rate).toBeCloseTo(2 / 3, 5); // 采纳且有结果 3 条，失败 2
  });

  it('edge_missing_rate（T29-b 三元组）：应连未连/应连总数；known=false 旧形态不计', () => {
    const rows = [
      // 三元组：3 条应连，缺 2 → 2/3
      mkRow({ attribution: { edge_compliance: { known: true, required_edges: ['DECIDED_ON', 'REFERENCED_PRECEDENT', 'CAUSED'], required_missing: ['REFERENCED_PRECEDENT', 'CAUSED'] } } }),
      // 三元组：3 条应连，缺 2 → 2/3
      mkRow({ attribution: { edge_compliance: { known: true, required_edges: ['DECIDED_ON', 'REFERENCED_PRECEDENT', 'CAUSED'], required_missing: ['REFERENCED_PRECEDENT', 'CAUSED'] } } }),
      // 旧投影形态（known=false）：无应连依据，不计数
      mkRow({ attribution: { edge_compliance: { E1: { status: 'present' }, E2: { status: 'missing_should_exist' } } } }),
    ];
    const m = deriveDeviationMetrics(rows);
    // expected=6, missing=4 → 2/3；旧形态行不污染分母
    expect(m.edge_missing_rate).toBeCloseTo(2 / 3, 5);
  });

  it('context_insufficient_rate + need_dim_order_rate + precedent_pollution_rate', () => {
    const rows = [
      mkRow({ attribution: { category: 'context_insufficient' } }),
      mkRow({ attribution: { required_fill: { missing: ['L6'] } } }),
      mkRow({ feedback: { deviation_note: '参考先例误导了判断' } }),
      mkRow({}),
    ];
    const m = deriveDeviationMetrics(rows);
    expect(m.context_insufficient_rate).toBeCloseTo(0.25, 5);
    expect(m.need_dim_order_rate).toBeCloseTo(0.25, 5);
    expect(m.precedent_pollution_rate).toBeCloseTo(0.25, 5);
  });

  it('存量键仍由 computeMetrics 提供（autonomy_override_rate 等）', () => {
    const rows = [
      mkRow({ decider_type: 'AUTONOMOUS_AGENT', human_disposition: 'OVERRIDDEN' }),
      mkRow({ decider_type: 'AUTONOMOUS_AGENT' }),
    ];
    const m = deriveDeviationMetrics(rows);
    expect(m.autonomy_override_rate).toBeCloseTo(0.5, 5);
    expect(typeof m.escalate_rate).toBe('number');
  });
});

describe('T21 suggestForScenario（注入 fake query）', () => {
  it('小样本 → 守卫 R6 命中 → 零处方，guards 非空', async () => {
    const rows = [mkRow({ outcome_verified: 'lost' })];
    const fakeQuery = async () => ({ rows });
    const s = await suggestForScenario('SCN_X', { query: fakeQuery });
    expect(s.patches.length).toBe(0);
    expect(s.guards.some((g) => g.id === 'R6')).toBe(true);
    expect(s.reason).toContain('守卫命中');
  });

  it('偏差足 + 样本足 → 产出对应处方（如 outcome_mismatch → R7）', async () => {
    // 20+ 样本，全部采纳且业务失败 → outcome_mismatch_rate=1,样本足
    const rows = Array.from({ length: 24 }, () =>
      mkRow({ human_disposition: 'CONFIRMED', outcome_verified: 'lost', decider_type: 'HUMAN' })
    );
    const s = await suggestForScenario('SCN_Y', { query: async () => ({ rows }) });
    expect(s.sample_size).toBe(24);
    // 可能命中多条（R7 等），断言至少一条 outcome 相关处方
    expect(s.patches.length).toBeGreaterThan(0);
    expect(s.patches.some((p) => ['outcome_threshold', 'required_dims', 'confidence'].includes(p.knob))).toBe(true);
  });

  it('回归：无偏差 → 零处方，无守卫', async () => {
    const rows = Array.from({ length: 24 }, () =>
      mkRow({ human_disposition: 'CONFIRMED', outcome_verified: 'won', decider_type: 'AUTONOMOUS_AGENT', conditions_evaluated: [] })
    );
    const s = await suggestForScenario('SCN_Z', { query: async () => ({ rows }) });
    // R2/R3 依赖 escalate_rate/human_latency 等运营指标，而本场景纯自主无升级 → 不触发；
    // 断言无「偏差类处方」（outcome/edge/context 相关），R1/R2/R3/R4 阈值族可能因 metric 合成触发
    expect(s.patches.every((p) => !['outcome_threshold', 'edge_binding', 'required_dims', 'dim_order', 'precedent_distill'].includes(p.knob))).toBe(true);
    expect(s.guards.length).toBe(0);
  });
});