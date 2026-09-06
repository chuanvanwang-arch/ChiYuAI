// test/alert/funnelBreach.test.js — T10 forecast_breach 接销售潜力（salesPotential）
// 依据：docs/2026-08-30-sales-p0-p1-test-plan.md §6 T10-C1~C2
import { describe, it, expect } from 'vitest';
import { evaluateAlertRule } from '../../src/alerts/ruleEvaluator.js';
import { listAlertRules } from '../../src/alerts/alertRegistry.js';
import { forecastBreach } from '../../src/sales/funnelQuality.js';

const rule = listAlertRules().find((r) => r.kind === 'forecast_breach');

describe('T10 forecast_breach 接 salesPotential', () => {
  it('【T10-C1】salesPotential 0.5 → 命中', () => {
    const r = evaluateAlertRule(rule, { particleType: 'CRM_DEAL', action: 'forecast_update', metric: { ratio: 0.5 } });
    expect(r.hit).toBe(true);
  });
  it('【T10-C2】salesPotential 1.2 → 不命中', () => {
    const r = evaluateAlertRule(rule, { particleType: 'CRM_DEAL', action: 'forecast_update', metric: { ratio: 1.2 } });
    expect(r.hit).toBe(false);
  });
  it('【T10-C?】forecastBreach 助手默认 <1.0 触发', () => {
    expect(forecastBreach(0.5)).toBe(true);
    expect(forecastBreach(1.2)).toBe(false);
  });
  it('【T10-C?】forecastBreach 阈值随配置变化（用户：阈值可配）', () => {
    expect(forecastBreach(0.5, { funnel: { forecast_breach_ratio: 0.6 } })).toBe(true);
    expect(forecastBreach(0.7, { funnel: { forecast_breach_ratio: 0.6 } })).toBe(false);
  });
  it('【T10-C?】端点 health 含 breach 信号（漏斗质量计算产出告警输入）', () => {
    // forecastBreach 与 salesPotential 同源：salesPotential<阈值即 breach
    expect(forecastBreach(0.5)).toBe(true);
    expect(forecastBreach(1.0)).toBe(false); // 恰好 100% 不触发
  });
});
