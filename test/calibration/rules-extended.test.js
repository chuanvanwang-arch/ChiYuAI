// test/calibration/rules-extended.test.js — T28 规则引擎深化（R7-R17，纯单测）
// 注意：R5 守卫（precedent_coverage_avg < 0.3）→ 拒方，优先级高于一切出方规则。
//   故验证出方规则前必须提供 precedent_coverage_avg >= 0.3（表示先例覆盖充足，不触发守卫）。
import { describe, it, expect } from 'vitest';
import { attribute, RULES } from '../../src/calibration/rules.js';

const OK = { sample_size: 50, precedent_coverage_avg: 1 }; // 先例覆盖充足，守卫不拦截

describe('T28 calibration rules R7-R17', () => {
  it('R7: outcome_mismatch_rate>0.2 → outcome_threshold 处方', () => {
    const r = attribute({ ...OK, outcome_mismatch_rate: 0.3 });
    expect(r.patches.some((p) => p.id === 'R7' && p.knob === 'outcome_threshold')).toBe(true);
  });

  it('R8: 高置信但高失败率 → confidence 处方（下调）', () => {
    const r = attribute({ ...OK, avg_confidence: 0.9, outcome_mismatch_rate: 0.3 });
    expect(r.patches.some((p) => p.id === 'R8' && p.knob === 'confidence')).toBe(true);
  });

  it('R9/R15: edge_missing_rate>0.3 → edge_binding 处方', () => {
    const r = attribute({ ...OK, edge_missing_rate: 0.4 });
    expect(r.patches.some((p) => p.knob === 'edge_binding')).toBe(true);
  });

  it('R10/R14: context_insufficient_rate → required_dims 处方', () => {
    const r = attribute({ ...OK, context_insufficient_rate: 0.4 });
    expect(r.patches.some((p) => p.id === 'R10')).toBe(true);
  });

  it('R11-R17 七类根因规则可按指标命中', () => {
    const m = { ...OK, field_mismatch_rate: 0.3, info_incomplete_rate: 0.3, input_stale_rate: 0.3, dim_missing_rate: 0.3, need_dim_order_rate: 0.3, precedent_pollution_rate: 0.3 };
    const r = attribute(m);
    const ids = r.patches.map((p) => p.id);
    for (const id of ['R11', 'R12', 'R13', 'R14', 'R16', 'R17']) {
      expect(ids).toContain(id);
    }
  });

  it('R5/R6 守卫优先：小样本或缺先例覆盖 → 零处方（不出任何出方规则）', () => {
    const r = attribute({ sample_size: 5, precedent_coverage_avg: 0, outcome_mismatch_rate: 0.9, field_mismatch_rate: 0.9 });
    expect(r.guards.length).toBeGreaterThan(0);
    expect(r.patches).toEqual([]);
  });

  it('新 knob 均在 RULES 定义且合法', () => {
    for (const id of ['R7', 'R8', 'R9', 'R10', 'R11', 'R12', 'R13', 'R14', 'R15', 'R16', 'R17']) {
      expect(RULES[id]).toBeTruthy();
    }
  });
});
