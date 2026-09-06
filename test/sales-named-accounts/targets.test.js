// test/sales-named-accounts/targets.test.js — 目标指标（named-account-targets）纯函数
import { describe, it, expect } from 'vitest';
import { DEFAULTS, mergedTargets, tierOf, visitsInWindow, visitTargetFor, visitDueAt, metricDimensions, METRIC_LABELS } from '../../src/sales/namedAccountTargets.js';

describe('目标指标（named-account-targets）纯函数', () => {
  it('DEFAULTS 三档：重点1/周 目标1/月 潜力1/季', () => {
    expect(DEFAULTS.tiers).toHaveLength(3);
    expect(DEFAULTS.tiers[0].visit_freq).toEqual({ times: 1, window: 'week' });
    expect(DEFAULTS.tiers[1].visit_freq).toEqual({ times: 1, window: 'month' });
    expect(DEFAULTS.tiers[2].visit_freq).toEqual({ times: 1, window: 'quarter' });
  });

  it('mergedTargets：旧配置缺字段时不丢默认（键级合并）', () => {
    const m = mergedTargets({ tiers: [{ tier: '重点', visit_freq: { times: 2, window: 'week' } }] });
    expect(m.tiers).toHaveLength(1);
    expect(m.window_days).toEqual({ week: 7, month: 30, quarter: 90 });
    expect(m.metrics).toEqual(['visit', 'lead', 'deal', 'contract']);
    expect(m.tier_rule).toBe('by_payload');
  });

  it('tierOf：payload.tier 命中；空 → 潜力（保守默认）', () => {
    expect(tierOf({ tier: '重点' }).tier).toBe('重点');
    expect(tierOf({}).tier).toBe('潜力');
  });

  it('visitsInWindow：只数窗口内', () => {
    const p = {
      visit_notes: [
        { at: new Date(Date.now() - 2 * 86400000).toISOString() },
        { at: new Date(Date.now() - 60 * 86400000).toISOString() },
      ],
    };
    expect(visitsInWindow(p, 'month')).toBe(1);
    expect(visitsInWindow(p, 'quarter')).toBe(2);
  });

  it('visitTargetFor：重点近7天≥1 达标', () => {
    const p = {
      tier: '重点',
      visit_notes: [{ at: new Date(Date.now() - 2 * 86400000).toISOString() }],
    };
    const r = visitTargetFor(p);
    expect(r.target).toBe(1);
    expect(r.pass).toBe(true);
    expect(r.window).toBe('week');
  });

  it('visitTargetFor：目标近30天0次 → 不达标', () => {
    const p = { tier: '目标', visit_notes: [{ at: new Date(Date.now() - 60 * 86400000).toISOString() }] };
    const r = visitTargetFor(p);
    expect(r.actual).toBe(0);
    expect(r.pass).toBe(false);
  });

  it('visitDueAt：重点(week) 最近拜访 8-01 + 7天 → 8-08', () => {
    const due = visitDueAt({ visit_notes: [{ at: '2026-08-01T09:00:00+08:00' }] }, '重点');
    expect(due.getTime()).toBe(new Date('2026-08-08T09:00:00+08:00').getTime());
  });

  it('visitDueAt：无拜访 → assignedAt + 窗口天数（month=30）', () => {
    const due = visitDueAt({}, '目标', DEFAULTS, new Date('2026-08-10T09:00:00+08:00'));
    expect(due.getTime()).toBe(new Date('2026-09-09T09:00:00+08:00').getTime());
  });

  it('④ metricDimensions：默认 4 维带可读标签', () => {
    const dims = metricDimensions(mergedTargets({}));
    expect(dims).toHaveLength(4);
    expect(dims[0]).toEqual({ code: 'visit', label: '拜访记录' });
    expect(dims[3]).toEqual({ code: 'contract', label: '合同' });
  });

  it('④ metricDimensions：随配置变化（自定义 metrics 也出 label，未知 code 回退原值）', () => {
    const dims = metricDimensions(mergedTargets({ metrics: ['deal', 'custom_x'] }));
    expect(dims).toHaveLength(2);
    expect(dims[0]).toEqual({ code: 'deal', label: '非线索商机' });
    expect(dims[1]).toEqual({ code: 'custom_x', label: 'custom_x' });
    expect(METRIC_LABELS.deal).toBe('非线索商机');
  });

  it('④ metricDimensions：空 metrics 回退默认（防页面空）', () => {
    const dims = metricDimensions(mergedTargets({ metrics: [] }));
    expect(dims).toHaveLength(4);
  });
});