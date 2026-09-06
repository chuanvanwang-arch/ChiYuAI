// test/calibration/rules.test.js — 归因规则测试
// 设计依据：docs/2026-08-28-decision-quality-calibration-design.md §5
// 核心契约：R5/R6 拒绝出方规则优先级高于 R1-R4；小样本/先例不足不出任何处方
import { describe, it, expect } from 'vitest';
import { attribute, RULES } from '../../src/calibration/rules.js';

// 构造一个"本应触发 R1 但样本不足"的指标集，验证守卫优先
const base = {
  sample_size: 20,
  autonomy_override_rate: 0.3,
  avg_confidence_gap_to_threshold: 0.03,
  escalate_rate: 0.3,
  escalated_override_rate: 0.1,
  escalation_fatigue_rate: 0.1,
  precedent_coverage_avg: 0.5,
  weight_sensitivity_method: 0.2,
  weight_sensitivity_coverage: 0.2,
  weight_sensitivity_similarity: 0.2,
};

describe('attribute — 出方规则', () => {
  it('R1：自主覆写率>25% 且置信度贴阈值 → threshold +0.05 / LOW', () => {
    const r = attribute(base);
    expect(r.guards).toHaveLength(0);
    expect(r.patches).toHaveLength(1);
    expect(r.patches[0].id).toBe('R1');
    expect(r.patches[0].knob).toBe('threshold');
    expect(r.patches[0].delta).toEqual({ threshold: +0.05 });
    expect(r.patches[0].risk).toBe('LOW');
  });

  it('R2：升级率>60% 且升级件覆写率<5% → threshold -0.05 / MEDIUM', () => {
    const r = attribute({ ...base, autonomy_override_rate: 0.1, escalate_rate: 0.7, escalated_override_rate: 0.02 });
    expect(r.patches.map((p) => p.id)).toContain('R2');
    const p = r.patches.find((x) => x.id === 'R2');
    expect(p.delta).toEqual({ threshold: -0.05 });
    expect(p.risk).toBe('MEDIUM');
  });

  it('R3：升级疲劳率>30% → threshold -0.05（或精简升级条件）', () => {
    const r = attribute({ ...base, escalation_fatigue_rate: 0.4 });
    expect(r.patches.map((p) => p.id)).toContain('R3');
    expect(r.patches.find((x) => x.id === 'R3').delta).toEqual({ threshold: -0.05 });
  });

  it('R4：methodScore 敏感性显著高于其他分项 → weights.method +0.05', () => {
    const r = attribute({ ...base, weight_sensitivity_method: 0.35 });
    expect(r.patches.map((p) => p.id)).toContain('R4');
    const p = r.patches.find((x) => x.id === 'R4');
    expect(p.delta).toEqual({ weights: { method: +0.05 } });
    expect(p.knob).toBe('weight');
  });

  it('多规则可同时命中（R1+R4）', () => {
    const r = attribute({ ...base, weight_sensitivity_method: 0.4, weight_sensitivity_coverage: 0.1, weight_sensitivity_similarity: 0.1 });
    expect(r.patches.map((p) => p.id).sort()).toEqual(['R1', 'R4']);
  });
});

describe('attribute — 守卫规则拒方（优先级最高）', () => {
  it('R6：样本<20 → 不出任何处方（即使 R1 条件成立）', () => {
    const r = attribute({ ...base, sample_size: 15 });
    expect(r.patches).toHaveLength(0);
    expect(r.guards.map((g) => g.id)).toEqual(['R6']);
  });

  it('R5：先例覆盖<0.3 → 不出任何处方', () => {
    const r = attribute({ ...base, precedent_coverage_avg: 0.2 });
    expect(r.patches).toHaveLength(0);
    expect(r.guards.map((g) => g.id)).toEqual(['R5']);
  });

  it('R5 与 R6 同时命中时都记录（R5 在前）', () => {
    const r = attribute({ ...base, sample_size: 10, precedent_coverage_avg: 0.1 });
    expect(r.guards.map((g) => g.id)).toEqual(['R5', 'R6']);
    expect(r.patches).toHaveLength(0);
  });

  it('guard 命中时 reason 明确说明不出处方原因', () => {
    const r = attribute({ ...base, sample_size: 3 });
    expect(r.reason).toContain('守卫命中（R6）');
    expect(r.reason).toContain('不出处方');
  });
});

describe('attribute — 无命中', () => {
  it('指标健康 → 无处方无守卫', () => {
    const r = attribute({ ...base, autonomy_override_rate: 0.1, escalate_rate: 0.3 });
    expect(r.patches).toHaveLength(0);
    expect(r.guards).toHaveLength(0);
    expect(r.reason).toContain('无需调整');
  });
});

describe('RULES 表契约', () => {
  it('守卫规则无 knob（不可产生处方）', () => {
    expect(RULES.R5.knob).toBeNull();
    expect(RULES.R6.knob).toBeNull();
  });
  it('R1-R4 均有 knob 且 delta 非空', () => {
    for (const id of ['R1', 'R2', 'R3', 'R4']) {
      expect(RULES[id].knob).toBeTruthy();
      expect(RULES[id].delta).toBeTruthy();
    }
  });
});