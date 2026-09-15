// test/enrichment-metrics.test.js — P0-3a 富集成本/命中率聚合纯函数
// 设计 docs/2026-09-15-anysite-borrowing-analysis.md §3 P0-3（案例依据 F5：智能过滤>批量富集 0.3% 富集率）
// 纯函数、零 DB；抗假绿：分母恒真实（enriched>0 才计率）
import { describe, it, expect } from 'vitest';
import { computeEnrichmentRate, aggregateEnrichment } from '../src/monitor/enrichmentMetrics.js';

describe('computeEnrichmentRate', () => {
  it('0 富集 → rate 0 且分母 0（抗假绿：不虚造命中率）', () => {
    const r = computeEnrichmentRate({ enriched: 0, withContacts: 0 });
    expect(r.rate).toBe(0);
    expect(r.denominator).toBe(0);
  });
  it('452/143785 → 0.3%', () => {
    const r = computeEnrichmentRate({ enriched: 143785, withContacts: 452 });
    expect(r.rate).toBeCloseTo(0.00314, 4);
  });
  it('enriched>0 但 withContacts=0 → rate 0', () => {
    const r = computeEnrichmentRate({ enriched: 100, withContacts: 0 });
    expect(r.rate).toBe(0);
    expect(r.denominator).toBe(100);
  });
});

describe('aggregateEnrichment', () => {
  it('聚合多源成本/次数/命中', () => {
    const agg = aggregateEnrichment([
      { provider: 'anysite', cost: 10, calls: 5, hits: 3 },
      { provider: 'qixin', cost: 4, calls: 2, hits: 1 },
    ]);
    expect(agg.totalCost).toBe(14);
    expect(agg.calls).toBe(7);
    expect(agg.hits).toBe(4);
  });
  it('空记录 → 全 0（不抛错）', () => {
    const agg = aggregateEnrichment([]);
    expect(agg.totalCost).toBe(0);
    expect(agg.calls).toBe(0);
    expect(agg.hits).toBe(0);
    expect(agg.rate).toBe(0);
  });
});
