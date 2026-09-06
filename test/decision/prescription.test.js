// test/decision/prescription.test.js — 处方定量引擎（§12.3）单元测试（纯函数，无需 PG）
import { describe, it, expect } from 'vitest';
import { prescribe, findKnobSpec } from '../../src/decision/prescription.js';

const SPEC = {
  healthy_baseline: 0.30,
  direction: 'down',
  sensitivity_k: 0.5,
  sensitivity_slope: 2.0,
  max_step: 0.05,
  min_step: 0.02,
  metric: 'precedent_recall',
};

describe('prescribe — 定量处方', () => {
  it('minSimilarity 0.45→0.40，预测召回 0.12→≈0.22', () => {
    const r = prescribe({ cur: 0.45, measured: 0.12, spec: SPEC, floor: 0.30, ceiling: 0.60 });
    expect(r.to).toBe(0.40);
    expect(r.step).toBe(-0.05);
    expect(r.risk).toBe('LOW');
    expect(r.prescription.predicted_impact.to_est).toBeCloseTo(0.22, 2);
    // 处方子对象必须可读"调多少/为什么"
    expect(r.prescription.action).toBe('下调');
    expect(r.prescription.bounds.do_not_below).toBe(0.30);
  });

  it('越界夹回升 risk（触 floor 夹回 0.30 / MEDIUM）', () => {
    const r = prescribe({ cur: 0.32, measured: 0.05, spec: SPEC, floor: 0.30, ceiling: 0.60 });
    expect(r.to).toBe(0.30);
    expect(r.risk).toBe('MEDIUM');
  });

  it('已健康（gap 反向）不产处方', () => {
    const r = prescribe({ cur: 0.40, measured: 0.35, spec: SPEC, floor: 0.30, ceiling: 0.60 });
    expect(r).toBeNull();
  });

  it('step 受 max_step 封顶（防一次跳太大）', () => {
    // gap=0.40 很大，但 max_step=0.05 → 仅调 0.05
    const r = prescribe({ cur: 0.8, measured: 0.0, spec: SPEC, floor: 0.30, ceiling: 0.60 });
    expect(r.step).toBe(-0.05);
  });
});

describe('findKnobSpec — 配置化旋钮映射（§12.2）', () => {
  const map = {
    knob_map: [
      { root_cause_class: 'DATA_QUALITY_PRECEDENT', metric: 'precedent_recall', knob: 'config_store', target: 'precedent-conf.minSimilarity', direction: 'down' },
      { root_cause_class: 'DIM_MISSING', metric: 'dim_missing_rate', knob: 'config_store', target: 'seven-dim.required_dims', direction: 'shrink' },
    ],
  };
  it('按 root_cause_class 命中条目', () => {
    const s = findKnobSpec(map, { rootCauseClass: 'DATA_QUALITY_PRECEDENT', metric: 'precedent_recall' });
    expect(s.target).toBe('precedent-conf.minSimilarity');
    expect(s.knob).toBe('config_store');
  });
  it('无命中返回 null', () => {
    expect(findKnobSpec(map, { rootCauseClass: 'EDGE_MISSING' })).toBeNull();
  });
});
