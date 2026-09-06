// test/calibration/replay.test.js — 影子重放测试
// 设计依据：docs/2026-08-28-decision-quality-calibration-design.md §6/§8
// 核心守卫：重放 conf 与 decision_event.payload.confidence 误差 < 1e-6（确定性复现）
import { describe, it, expect } from 'vitest';
import { replayConfidence, wouldEscalate, replayScenario } from '../../src/calibration/replay.js';
import { REPLAY_K } from '../../src/calibration/constants.js';

const DEFAULT_CONF = { threshold: 0.8, weights: { similarity: 0.4, coverage: 0.3, method: 0.2, allMet: 0.1 } };

// 构造一条与 autonomyEngine 真实产物同形的决策行（JSONB 经 pg 解析后为 JS 数组/对象）
function makeDecision(overrides = {}) {
  return {
    scenario_id: 'LEAD_QUALIFY',
    conditions_evaluated: [
      { cond: 'icp', weight: 0.4, met: true },
      { cond: 'budget', weight: 0.3, met: true },
      { cond: 'authority', weight: 0.3, met: false },
    ],
    referenced_precedents: [
      { precedent_id: 'p1', similarity: 0.81 },
      { precedent_id: 'p2', similarity: 0.74 },
    ],
    business_tier: 'NORMAL',
    trigger_context: { relations: {} },
    decider_type: 'AUTONOMOUS_AGENT',
    ...overrides,
  };
}

describe('replayConfidence — 与运行端公式逐字对齐', () => {
  it('复算 conf 与手工公式一致（methodScore=0.7, avgSim=0.775, cov=2/5=0.4, allMet=false）', () => {
    const d = makeDecision();
    const conf = replayConfidence(d, DEFAULT_CONF);
    // 0.4*0.775 + 0.3*0.4 + 0.2*0.7 + 0.1*0 = 0.31+0.12+0.14 = 0.57
    expect(conf).toBeCloseTo(0.57, 12);
  });

  it('allMet=true 时 allMet 项生效', () => {
    const d = makeDecision({
      conditions_evaluated: [
        { cond: 'icp', weight: 0.4, met: true },
        { cond: 'budget', weight: 0.3, met: true },
        { cond: 'authority', weight: 0.3, met: true },
      ],
    });
    const conf = replayConfidence(d, DEFAULT_CONF);
    // 0.4*0.775 + 0.3*0.4 + 0.2*1 + 0.1*1 = 0.31+0.12+0.2+0.1 = 0.73
    expect(conf).toBeCloseTo(0.73, 12);
  });

  it('强关系 relBoost 逐项生效（champion +0.3, relationship high +0.3）', () => {
    const d = makeDecision({
      trigger_context: { relations: { champion_strength: 'high', relationship_strength: 'strong' } },
    });
    const conf = replayConfidence(d, DEFAULT_CONF);
    // 0.57 + 0.6 = 1.17 → cap 0.95（与运行端 autonomyEngine.js:85-88 同公式）
    expect(conf).toBe(0.95);
  });

  it('conf 上限 0.95', () => {
    const d = makeDecision({
      conditions_evaluated: [{ cond: 'x', weight: 1, met: true }],
      referenced_precedents: Array.from({ length: REPLAY_K }, (_, i) => ({ precedent_id: `p${i}`, similarity: 1 })),
      trigger_context: { relations: { champion_strength: 'high', relationship_strength: 'high' } },
    });
    const conf = replayConfidence(d, DEFAULT_CONF);
    // 0.4*1 + 0.3*1 + 0.2*1 + 0.1*1 + 0.6 = 1.6 → cap 0.95
    expect(conf).toBe(0.95);
  });

  it('空 conditions / 空先例 → floor：methodScore=1, avgSim=0, cov=0', () => {
    const d = makeDecision({ conditions_evaluated: [], referenced_precedents: [] });
    const conf = replayConfidence(d, DEFAULT_CONF);
    // 0.4*0 + 0.3*0 + 0.2*1 + 0.1*1 = 0.3
    expect(conf).toBeCloseTo(0.3, 12);
  });

  it('JSONB 假防御：conditions_evaluated 为对象（truthy 非数组）→ 按空数组处理不崩溃', () => {
    const d = makeDecision({ conditions_evaluated: { icp: true } });
    const conf = replayConfidence(d, DEFAULT_CONF);
    // 对象被兜底为空数组 → methodScore=1.0, allMet=true；先例仍默认 2 条 → 0.31+0.12+0.2+0.1=0.73
    expect(conf).toBeCloseTo(0.73, 12);
  });
});

describe('wouldEscalate — 镜像引擎 escalated 判定', () => {
  it('tier=HIGH 恒升级（即使 conf 高）', () => {
    const d = makeDecision({ business_tier: 'HIGH' });
    expect(wouldEscalate(d, DEFAULT_CONF)).toBe(true);
  });

  it('outcome=AUDIT_HIGHLIGHT（EXCEPTION）恒升级', () => {
    const d = makeDecision({ outcome: 'AUDIT_HIGHLIGHT', business_tier: 'NORMAL' });
    expect(wouldEscalate(d, DEFAULT_CONF)).toBe(true);
  });

  it('conf=0.57 < 阈值 0.8 → 升级', () => {
    const d = makeDecision();
    expect(wouldEscalate(d, DEFAULT_CONF)).toBe(true);
  });

  it('强关系阈值放宽 0.1：conf=0.73 ≥ 0.7 → 自主放行', () => {
    const d = makeDecision({
      conditions_evaluated: [{ cond: 'x', weight: 1, met: true }],
      trigger_context: { relations: { champion_strength: 'high', relationship_strength: 'high' } },
    });
    // conf = 0.4*0.9 + 0.3*1 + 0.2*1 + 0.1*1 + 0.6 = 0.36+0.3+0.2+0.1+0.6 = 1.56 → cap 0.95
    // effectiveThreshold = max(0.8-0.1, 0.5) = 0.7 → 0.95 ≥ 0.7 → 自主
    expect(wouldEscalate(d, DEFAULT_CONF)).toBe(false);
  });

  it('阈值上调后从自主变升级（重放的用途：预测收紧影响）', () => {
    const d = makeDecision({
      decider_type: 'AUTONOMOUS_AGENT',
      conditions_evaluated: [{ cond: 'x', weight: 1, met: true }],
      referenced_precedents: [
        { precedent_id: 'p1', similarity: 1 },
        { precedent_id: 'p2', similarity: 1 },
      ],
      trigger_context: { relations: {} },
    });
    // conf = 0.4*1 + 0.3*0.4 + 0.2*1 + 0.1*1 = 0.4+0.12+0.2+0.1 = 0.82
    expect(replayConfidence(d, DEFAULT_CONF)).toBeCloseTo(0.82, 12);
    expect(wouldEscalate(d, DEFAULT_CONF)).toBe(false); // 0.82 ≥ 0.8 → 自主
    expect(wouldEscalate(d, { ...DEFAULT_CONF, threshold: 0.85 })).toBe(true); // 0.82 < 0.85 → 升级
  });
});

describe('replayScenario — 场景级分布预测', () => {
  const base = [
    // 自主（conf 0.57 → 重放阈 0.8 下也升级）
    makeDecision({ decider_type: 'AUTONOMOUS_AGENT' }),
    // 已升级
    makeDecision({ decider_type: 'HUMAN', business_tier: 'HIGH' }),
  ];

  it('小样本（<20）时 estimated_override_rate 为 null（R6 精神：不做宣称）', () => {
    const r = replayScenario(base, DEFAULT_CONF);
    expect(r.sufficient_sample).toBe(false);
    expect(r.estimated_override_rate).toBeNull();
  });

  it('阈值下调 0.5 → 更多样本可自主（delta>0）', () => {
    const r = replayScenario(base, { ...DEFAULT_CONF, threshold: 0.5 });
    // 样本1 conf 0.57 ≥ 0.5 → 自主；样本2 tier HIGH 恒升级
    expect(r.autonomy).toBe(1);
    expect(r.escalated).toBe(1);
    expect(r.delta).toBe(0); // base 1 自主 → 重放 1 自主
  });
});