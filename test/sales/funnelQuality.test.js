// test/sales/funnelQuality.test.js — T7 漏斗质量纯函数（红灯先行）
// 依据：docs/2026-08-30-sales-p0-p1-test-plan.md §6 T7-C1~C22
//       docs/2026-08-30-sales-p0-p1-taoran-bantcc-swas-funnel-design.md §5
// 原则（用户 2026-08-30）：加权值/抖动阈值/承诺评价带等一律走后台配置，
//   不得硬编码——故补 T7-C23/C24 锁死「随配置变化」语义。

import { describe, it, expect } from 'vitest';
import {
  mantOk, funnelZone, forecastClass, weightedAmount, salesPotential, jitterRate, commitAccuracy, funnelHealth, applyBaselineSnapshot,
} from '../../src/sales/funnelQuality.js';

// 构造 CRM_DEAL 形态（payload.funnel + payload.expected_amount）
const deal = (over = {}) => ({ payload: { expected_amount: 0, funnel: {}, ...over } });
const funnel = (over = {}) => ({ mant: {}, ...over });
const allOk = (m = true, a = true, n = true, t = true) => ({ m: { ok: m }, a: { ok: a }, n: { ok: n }, t: { ok: t } });

describe('T7 漏斗质量纯函数', () => {
  // ── MANT ───────────────────────────────────────────────
  describe('T7-C1~C2 mantOk', () => {
    it('【T7-C1】四要素全明确 → ok=true missing=[]', () => {
      expect(mantOk(funnel({ mant: allOk() }))).toEqual({ ok: true, missing: [] });
    });
    it('【T7-C2】缺 M → ok=false missing=["m"]', () => {
      expect(mantOk(funnel({ mant: allOk(false) }))).toEqual({ ok: false, missing: ['m'] });
    });
  });

  // ── funnelZone ─────────────────────────────────────────
  describe('T7-C3~C6 funnelZone', () => {
    it('【T7-C3】四要素全不清 → 线索', () => {
      expect(funnelZone(deal({ funnel: { mant: allOk(false, false, false, false) } }))).toBe('线索');
    });
    it('【T7-C4】ANT≥1 且 M 不清 → 机会-', () => {
      expect(funnelZone(deal({ funnel: { mant: allOk(false, true, false, false) } }))).toBe('机会-');
    });
    it('【T7-C5】M 明确且 ANT 未全清 → 机会+', () => {
      expect(funnelZone(deal({ funnel: { mant: allOk(true, false, false, false) } }))).toBe('机会+');
    });
    it('【T7-C6】四要素全清 → 漏斗内', () => {
      expect(funnelZone(deal({ funnel: { mant: allOk(true, true, true, true) } }))).toBe('漏斗内');
    });
  });

  // ── forecastClass ──────────────────────────────────────
  describe('T7-C7~C10 forecastClass', () => {
    it('【T7-C7】有中标通知书 → 确保', () => {
      expect(forecastClass(deal({ funnel: { win_notice: true } }))).toBe('确保');
    });
    it('【T7-C8】决策者为我司支持者 → 优势', () => {
      expect(forecastClass(deal({ funnel: { supporter: true } }))).toBe('优势');
    });
    it('【T7-C9】势均力敌 → 可能+', () => {
      expect(forecastClass(deal({ funnel: { stance: 'even' } }))).toBe('可能+');
    });
    it('【T7-C10】处于劣势 → 可能-', () => {
      expect(forecastClass(deal({ funnel: { stance: 'weak' } }))).toBe('可能-');
    });
  });

  // ── weightedAmount ─────────────────────────────────────
  describe('T7-C11~C14 加权值（默认配置）', () => {
    it('【T7-C11】确保 × 100万 → 900000', () => {
      expect(weightedAmount(deal({ expected_amount: 1000000, funnel: { forecast_class: '确保' } }))).toBe(900000);
    });
    it('【T7-C12】优势 × 100万 → 600000', () => {
      expect(weightedAmount(deal({ expected_amount: 1000000, funnel: { forecast_class: '优势' } }))).toBe(600000);
    });
    it('【T7-C13】可能+ × 100万 → 300000', () => {
      expect(weightedAmount(deal({ expected_amount: 1000000, funnel: { forecast_class: '可能+' } }))).toBe(300000);
    });
    it('【T7-C14】可能- × 100万 → 0', () => {
      expect(weightedAmount(deal({ expected_amount: 1000000, funnel: { forecast_class: '可能-' } }))).toBe(0);
    });
    it('【T7-C?】无分类 → 0（不报错）', () => {
      expect(weightedAmount(deal({ expected_amount: 1000000 }))).toBe(0);
    });
  });

  // ── salesPotential ─────────────────────────────────────
  describe('T7-C15~C16 销售潜力', () => {
    it('【T7-C15】已下单 50 + 预期加权 60，任务 100 → 1.1', () => {
      const deals = [deal({ expected_amount: 100, funnel: { forecast_class: '优势' } })]; // 100*0.6=60
      expect(salesPotential(deals, 100, 50)).toBeCloseTo(1.1, 6);
    });
    it('【T7-C16】已下单 20 + 预期加权 30，任务 100 → 0.5', () => {
      const deals = [deal({ expected_amount: 50, funnel: { forecast_class: '优势' } })]; // 50*0.6=30
      expect(salesPotential(deals, 100, 20)).toBeCloseTo(0.5, 6);
    });
    it('【T7-C?】年任务为 0 → 防除零返回 0', () => {
      expect(salesPotential([deal()], 0, 10)).toBe(0);
    });
  });

  // ── jitterRate ─────────────────────────────────────────
  describe('T7-C17~C18 抖动率', () => {
    it('【T7-C17】基线 100，取消+后延 20 → 0.2', () => {
      expect(jitterRate(100, 20)).toBeCloseTo(0.2, 6);
    });
    it('【T7-C18】缺基线（null）→ null（不返回 0）', () => {
      expect(jitterRate(null, 20)).toBeNull();
      expect(jitterRate(0, 20)).toBeNull();
    });
  });

  // ── commitAccuracy ─────────────────────────────────────
  describe('T7-C19~C22 承诺兑现', () => {
    it('【T7-C19】100/100 → {rate:1.0, level:green}', () => {
      expect(commitAccuracy(100, 100)).toEqual({ rate: 1.0, level: 'green' });
    });
    it('【T7-C20】100/85 → level:yellow', () => {
      const r = commitAccuracy(100, 85);
      expect(r.rate).toBeCloseTo(0.85, 6);
      expect(r.level).toBe('yellow');
    });
    it('【T7-C21】100/70 → level:red', () => {
      expect(commitAccuracy(100, 70).level).toBe('red');
    });
    it('【T7-C22】100/130 → level:purple（承诺过低）', () => {
      const r = commitAccuracy(100, 130);
      expect(r.rate).toBeCloseTo(1.3, 6);
      expect(r.level).toBe('purple');
    });
  });

  // ── 配置化锁死（用户铁律：阈值必须可配，不硬编码） ──────
  describe('T7-C23~C24 配置化', () => {
    it('【T7-C23】加权值随配置变化（默认 0.9 → 配 0.95）', () => {
      const d = deal({ expected_amount: 1000000, funnel: { forecast_class: '确保' } });
      expect(weightedAmount(d)).toBe(900000); // 默认
      const cfg = { funnel: { weighted: { win: 0.95, adv: 0.6, even: 0.3, weak: 0 } } };
      expect(weightedAmount(d, cfg)).toBe(950000); // 客户可调后
    });
    it('【T7-C24】commit 评价带随配置变化（默认绿边界 0.9 → 调 0.95 后 0.92 变黄）', () => {
      expect(commitAccuracy(100, 92).level).toBe('green'); // 默认 0.9≤rate≤1.1
      const cfg = { funnel: { commit: { green_low: 0.95, green_high: 1.1, yellow_low: 0.8 } } };
      expect(commitAccuracy(100, 92, cfg).level).toBe('yellow');
    });
  });

  // ── B 接线：健康线判定 + 紫带读配置 ────────────────────
  describe('【B】funnelHealth 健康线 + commit 紫带配置化', () => {
    it('【B-C1】销售潜力 1.1 ≥ 默认健康线 1.0 → 健康', () => {
      expect(funnelHealth(1.1)).toBe(true);
    });
    it('【B-C2】销售潜力 0.9 < 默认健康线 1.0 → 不健康', () => {
      expect(funnelHealth(0.9)).toBe(false);
    });
    it('【B-C3】健康线随配置变化（调 0.95 → 0.9 也健康；调 1.2 → 1.1 不健康）', () => {
      const loose = { funnel: { health_min_ratio: 0.95 } };
      expect(funnelHealth(0.9, loose)).toBe(false);
      expect(funnelHealth(1.0, loose)).toBe(true);
      const strict = { funnel: { health_min_ratio: 1.2 } };
      expect(funnelHealth(1.1, strict)).toBe(false);
    });
    it('【B-C4】紫带随 purple_low 配置变化（默认 1.1 → 1.3 才紫；调 1.05 → 1.08 变紫）', () => {
      expect(commitAccuracy(100, 130).level).toBe('purple'); // 默认 ≥1.1 紫
      const cfg = { funnel: { commit: { green_low: 0.9, green_high: 1.1, yellow_low: 0.8, purple_low: 1.3 } } };
      expect(commitAccuracy(100, 130, cfg).level).toBe('green'); // 1.3 未达 1.3 紫带 → 绿（仍在绿带 90-110%）
      expect(commitAccuracy(100, 135, cfg).level).toBe('purple'); // 1.35 ≥1.3 → 紫
      const cfg2 = { funnel: { commit: { green_low: 0.9, green_high: 1.1, yellow_low: 0.8, purple_low: 1.05 } } };
      expect(commitAccuracy(100, 108, cfg2).level).toBe('purple'); // 1.08 ≥1.05 → 紫
    });
  });

  // ── T9 baseline 快照（幂等） ──────────────────────────
  describe('T9-C1~C2 baseline 快照', () => {
    it('【T9-C1】快照落库 baseline_amount = expected_amount', () => {
      const out = applyBaselineSnapshot([{ id: 'x', payload: { expected_amount: 120, funnel: {} } }]);
      expect(out[0].payload.funnel.baseline_amount).toBe(120);
    });
    it('【T9-C2】快照幂等（连跑两次结果一致）', () => {
      const input = [{ id: 'x', payload: { expected_amount: 120, funnel: { baseline_amount: 999 } } }];
      const once = applyBaselineSnapshot(input);
      const twice = applyBaselineSnapshot(once.map((o) => ({ id: o.id, payload: o.payload })));
      expect(twice[0].payload.funnel.baseline_amount).toBe(once[0].payload.funnel.baseline_amount);
      expect(twice[0].payload.funnel.baseline_amount).toBe(120); // 不被旧值 999 污染
    });
  });
});
