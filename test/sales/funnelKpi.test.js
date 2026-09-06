// test/sales/funnelKpi.test.js — T7 漏斗转化率 KPI 计算（设计 §4，监控/辅导层，非门禁）
// 纯函数单测（无 DB）：funnelConversionRates / funnelKpiWarnings / DEFAULT_FUNNEL_KPI / 健康线可配
import { describe, it, expect } from 'vitest';
import {
  FUNNEL_EDGES, DEFAULT_FUNNEL_KPI, funnelConversionRates, funnelKpiWarnings,
} from '../../src/sales/funnelKpi.js';

describe('【T7-漏斗KPI】DEFAULT_FUNNEL_KPI + 边定义', () => {
  it('四边定义与默认健康线符合设计 §4', () => {
    expect(FUNNEL_EDGES).toEqual([
      { from: 'S1', to: 'S2' },
      { from: 'S2', to: 'S3' },
      { from: 'S3', to: 'S4' },
      { from: 'S4', to: 'S5' },
    ]);
    expect(DEFAULT_FUNNEL_KPI).toEqual({ s1_s2: 0.6, s2_s3: 0.5, s3_s4: 0.4, s4_s5: 0.7 });
  });
});

describe('【T7-漏斗KPI】funnelConversionRates 计算', () => {
  // 10 个商机均到达 S1；其中 6 个到达 S2；3 个到达 S3；2 个到达 S4；1 个到达 S5
  const deals = Array.from({ length: 10 }, (_, i) => ({
    id: `d${i}`,
    stagesReached: ['S1'].concat(
      i < 6 ? ['S2'] : [],
      i < 3 ? ['S3'] : [],
      i < 2 ? ['S4'] : [],
      i < 1 ? ['S5'] : [],
    ),
  }));

  it('逐边转化率 = 到达 to / 到达 from', () => {
    const r = funnelConversionRates(deals);
    expect(r['S1->S2'].rate).toBeCloseTo(6 / 10); // 0.6
    expect(r['S2->S3'].rate).toBeCloseTo(3 / 6);  // 0.5
    expect(r['S3->S4'].rate).toBeCloseTo(2 / 3);  // ~0.667
    expect(r['S4->S5'].rate).toBeCloseTo(1 / 2);  // 0.5
  });

  it('健康线取自默认 + 低于健康线标记 warning', () => {
    const r = funnelConversionRates(deals);
    // S1→S2 = 0.6，健康线 0.6 → 不 warning（低于才预警，等于不预警）
    expect(r['S1->S2'].healthLine).toBe(0.6);
    expect(r['S1->S2'].warning).toBe(false);
    // S2→S3 = 0.5，健康线 0.5 → 不 warning
    expect(r['S2->S3'].warning).toBe(false);
    // S4→S5 = 0.5，健康线 0.7 → warning
    expect(r['S4->S5'].healthLine).toBe(0.7);
    expect(r['S4->S5'].warning).toBe(true);
  });

  it('健康线可被 opts.healthLines 覆盖（客户可配）', () => {
    const r = funnelConversionRates(deals, { healthLines: { s1_s2: 0.7 } });
    expect(r['S1->S2'].healthLine).toBe(0.7);
    expect(r['S1->S2'].warning).toBe(true); // 0.6 < 0.7
  });

  it('计数字段正确（reachedFrom / reachedTo）', () => {
    const r = funnelConversionRates(deals);
    expect(r['S1->S2'].reachedFrom).toBe(10);
    expect(r['S1->S2'].reachedTo).toBe(6);
    expect(r['S3->S4'].reachedFrom).toBe(3);
    expect(r['S3->S4'].reachedTo).toBe(2);
  });

  it('空输入不抛错，返回全零率', () => {
    const r = funnelConversionRates([]);
    for (const e of FUNNEL_EDGES) {
      expect(r[`${e.from}->${e.to}`].rate).toBe(0);
      expect(r[`${e.from}->${e.to}`].warning).toBe(true); // 0 < 健康线
    }
  });

  it('兼容 maxStage / stage 单值输入', () => {
    const r = funnelConversionRates([{ id: 'x', maxStage: 'S3' }]);
    // 到达 S1,S2,S3 各 1；S4,S5 为 0
    expect(r['S1->S2'].rate).toBe(1);
    expect(r['S2->S3'].rate).toBe(1);
    expect(r['S3->S4'].reachedTo).toBe(0);
  });
});

describe('【T7-漏斗KPI】funnelKpiWarnings 汇总', () => {
  it('仅返回 warning=true 的边', () => {
    // 3 个商机均停留在 S1（未推进）：上游四边 to 永不被到达 → 率=0 < 健康线 → 全预警
    const deals = [
      { id: 'a', stagesReached: ['S1'] },
      { id: 'b', stagesReached: ['S1'] },
      { id: 'c', stagesReached: ['S1'] },
    ];
    const warnings = funnelKpiWarnings(funnelConversionRates(deals));
    const keys = warnings.map((w) => `${w.from}->${w.to}`).sort();
    expect(keys).toEqual(['S1->S2', 'S2->S3', 'S3->S4', 'S4->S5']);
    expect(warnings.every((w) => w.warning)).toBe(true);
  });

  it('健康线达标时无预警（正向用例）', () => {
    // 每条边的 to 都 100% 到达（率=1 ≥ 健康线）→ 无预警
    const deals = Array.from({ length: 5 }, (_, i) => ({ id: `d${i}`, stagesReached: ['S1', 'S2', 'S3', 'S4', 'S5'] }));
    expect(funnelKpiWarnings(funnelConversionRates(deals))).toHaveLength(0);
  });
});
