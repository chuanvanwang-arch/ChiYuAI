// test/propagation/measure-metrics.test.js — measureClusterMetrics 五槽位（§12.1）
import { describe, it, expect } from 'vitest';
import { measureClusterMetrics } from '../../src/decision/retro.js';

describe('measureClusterMetrics', () => {
  it('产出五槽位且归一化 0..1', () => {
    const c = {
      count: 100,
      category_distribution: { precedent_used: 12, precedent_missing: 88 },
      feedback_flags: { unusable: 5, majorDeviation: 9 },
      sample_missing_dims: ['L3'],
    };
    const m = measureClusterMetrics(c, { minSimilarity: 0.45 });
    expect(m.precedent_recall).toBeCloseTo(0.12, 2);
    expect(m.major_deviation_rate).toBeCloseTo(0.09, 2);
    expect(m.unusable_rate).toBeCloseTo(0.05, 2);
    expect(m.dim_missing_rate).toBeCloseTo(0.01, 2); // 1 维缺失 / 100
    expect(m.upgrade_rate).toBe(0); // 无 upgrade_count
    for (const v of Object.values(m)) expect(v).toBeGreaterThanOrEqual(0) && expect(v).toBeLessThanOrEqual(1);
  });

  it('空聚类不抛错，全 0', () => {
    const m = measureClusterMetrics({}, {});
    expect(m.precedent_recall).toBe(0);
    expect(m.unusable_rate).toBe(0);
  });

  it('兼容 attribution 风格键名（precedentUsed/precedentMissing）', () => {
    const m = measureClusterMetrics({ count: 10, category_distribution: { precedentUsed: 4, precedentMissing: 6 } }, {});
    expect(m.precedent_recall).toBeCloseTo(0.4, 2);
  });
});
