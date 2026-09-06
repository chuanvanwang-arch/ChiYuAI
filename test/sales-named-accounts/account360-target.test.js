// test/sales-named-accounts/account360-target.test.js — account-360 目标达标数据面契约
import { describe, it, expect } from 'vitest';
import { visitTargetFor, visitsInWindow, tierOf, mergedTargets } from '../../src/sales/namedAccountTargets.js';

describe('account-360 目标达标数据面', () => {
  it('visitTargetFor 输出 {target, actual, pass, window, tier} 五元组', () => {
    const r = visitTargetFor({ tier: '目标', visit_notes: [{ at: new Date(Date.now() - 5 * 86400000).toISOString() }] });
    expect(r).toHaveProperty('target');
    expect(r).toHaveProperty('actual');
    expect(r).toHaveProperty('pass');
    expect(r).toHaveProperty('window');
    expect(r).toHaveProperty('tier');
  });

  it('tierOf 保守默认（空 payload → 潜力档）', () => {
    expect(tierOf({}).tier).toBe('潜力');
  });

  it('mergedTargets 键级合并：window_days 部分覆盖保留默认', () => {
    const m = mergedTargets({ window_days: { week: 5 } });
    expect(m.window_days).toEqual({ week: 5, month: 30, quarter: 90 });
    expect(m.tiers).toEqual([{ tier: '重点', visit_freq: { times: 1, window: 'week' } }, { tier: '目标', visit_freq: { times: 1, window: 'month' } }, { tier: '潜力', visit_freq: { times: 1, window: 'quarter' } }]);
  });

  it('visitTargetFor 按配置覆盖后仍正确（tiers 自定义档位）', () => {
    const cfg = { tiers: [{ tier: '金钻', visit_freq: { times: 2, window: 'week' } }], window_days: { week: 7, month: 30, quarter: 90 } };
    const r = visitTargetFor({ tier: '金钻', visit_notes: [{ at: new Date(Date.now() - 1 * 86400000).toISOString() }] }, cfg);
    expect(r.tier).toBe('金钻');
    expect(r.target).toBe(2);
    expect(r.window).toBe('week');
    expect(r.actual).toBe(1);
    expect(r.pass).toBe(false);
  });
});