// test/alerts/ruleEvaluator-sales.test.js — 三分类 A 类规则评估分支（TDD 红→绿）
// 设计：docs/2026-08-30-sales-indicator-3class-deep-implementation-design.md §1.2
import { describe, it, expect } from 'vitest';
import { evaluateAlertRule } from '../../src/alerts/ruleEvaluator.js';

describe('ruleEvaluator 指标分支', () => {
  it('coverage_gap：目标客户超 target_days 未拜访 -> hit', () => {
    const rule = {
      kind: 'coverage_gap', enabled: true,
      match: { particleTypes: ['CRM_ACCOUNT'], actions: ['daily_scan'] },
      check_params: { target_days: 30, potential_days: 90 },
    };
    const hit = evaluateAlertRule(rule, {
      particleType: 'CRM_ACCOUNT', action: 'daily_scan',
      metric: { tier: '目标', daysSinceVisit: 45, windowDays: 30 },
    });
    expect(hit.hit).toBe(true);
    expect(hit.payload.tier).toBe('目标');
    expect(hit.payload.threshold).toBe(30);
  });

  it('coverage_gap：潜力客户超 potential_days -> hit', () => {
    const rule = {
      kind: 'coverage_gap', enabled: true,
      match: { particleTypes: ['CRM_ACCOUNT'], actions: ['daily_scan'] },
      check_params: { target_days: 30, potential_days: 90 },
    };
    const hit = evaluateAlertRule(rule, {
      particleType: 'CRM_ACCOUNT', action: 'daily_scan',
      metric: { tier: '潜力', daysSinceVisit: 120, windowDays: 90 },
    });
    expect(hit.hit).toBe(true);
    expect(hit.payload.tier).toBe('潜力');
  });

  it('coverage_gap：达标不命中', () => {
    const rule = {
      kind: 'coverage_gap', enabled: true,
      match: { particleTypes: ['CRM_ACCOUNT'], actions: ['daily_scan'] },
      check_params: { target_days: 30, potential_days: 90 },
    };
    const hit = evaluateAlertRule(rule, {
      particleType: 'CRM_ACCOUNT', action: 'daily_scan',
      metric: { tier: '目标', daysSinceVisit: 10, windowDays: 30 },
    });
    expect(hit.hit).toBe(false);
  });

  it('lost_contact：无拜访超 lost_days -> hit', () => {
    const rule = {
      kind: 'lost_contact', enabled: true,
      match: { particleTypes: ['CRM_ACCOUNT'], actions: ['daily_scan'] },
      check_params: { lost_days: 90 },
    };
    const hit = evaluateAlertRule(rule, {
      particleType: 'CRM_ACCOUNT', action: 'daily_scan',
      metric: { daysSinceVisit: 100 },
    });
    expect(hit.hit).toBe(true);
    expect(hit.payload.threshold).toBe(90);
  });

  it('funnel_unhealthy：销售潜力低于 health_min -> hit', () => {
    const rule = {
      kind: 'funnel_unhealthy', enabled: true,
      match: { particleTypes: ['CRM_DEAL'], actions: ['daily_scan'] },
      check_params: { health_min: 1.0 },
    };
    const hit = evaluateAlertRule(rule, {
      particleType: 'CRM_DEAL', action: 'daily_scan',
      metric: { salesPotential: 0.7 },
    });
    expect(hit.hit).toBe(true);
  });

  it('commit_red：承诺准确率低于 yellow_low -> hit', () => {
    const rule = {
      kind: 'commit_red', enabled: true,
      match: { particleTypes: ['CRM_DEAL'], actions: ['daily_scan'] },
      check_params: { yellow_low: 0.8 },
    };
    const hit = evaluateAlertRule(rule, {
      particleType: 'CRM_DEAL', action: 'daily_scan',
      metric: { commitRate: 0.55 },
    });
    expect(hit.hit).toBe(true);
  });

  it('visit_shortfall：当日拜访低于 daily_target -> hit', () => {
    const rule = {
      kind: 'visit_shortfall', enabled: true,
      match: { particleTypes: ['CRM_ACCOUNT'], actions: ['daily_scan'] },
      check_params: { daily_target: 3, weekly_target: 15 },
    };
    const hit = evaluateAlertRule(rule, {
      particleType: 'CRM_ACCOUNT', action: 'daily_scan',
      metric: { dailyVisits: 1, weeklyVisits: 8 },
    });
    expect(hit.hit).toBe(true);
  });

  it('info_collect_lag：周新增客户低于 weekly_min -> hit', () => {
    const rule = {
      kind: 'info_collect_lag', enabled: true,
      match: { particleTypes: ['CRM_ACCOUNT'], actions: ['daily_scan'] },
      check_params: { weekly_min: 5 },
    };
    const hit = evaluateAlertRule(rule, {
      particleType: 'CRM_ACCOUNT', action: 'daily_scan',
      metric: { weekNew: 2 },
    });
    expect(hit.hit).toBe(true);
  });

  it('funnel_jitter：抖动率高于 jitter_max -> hit', () => {
    const rule = {
      kind: 'funnel_jitter', enabled: true,
      match: { particleTypes: ['CRM_DEAL'], actions: ['daily_scan'] },
      check_params: { jitter_max: 0.3 },
    };
    const hit = evaluateAlertRule(rule, {
      particleType: 'CRM_DEAL', action: 'daily_scan',
      metric: { jitterRate: 0.45 },
    });
    expect(hit.hit).toBe(true);
  });
});