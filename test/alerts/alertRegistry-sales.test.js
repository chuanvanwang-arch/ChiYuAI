// test/alerts/alertRegistry-sales.test.js — 三分类 A 类规则注册（TDD 红→绿）
// 设计：docs/2026-08-30-sales-indicator-3class-deep-implementation-design.md §1.1
import { describe, it, expect, beforeEach } from 'vitest';
import { listAlertRules, evaluateForEvent, resetAlertRegistry } from '../../src/alerts/alertRegistry.js';

beforeEach(() => resetAlertRegistry());

describe('alertRegistry 规则', () => {
  it('注册 5 条新规则（coverage_gap/lost_contact/funnel_unhealthy/commit_red/funnel_jitter）', () => {
    const kinds = listAlertRules().map(r => r.kind);
    for (const k of ['coverage_gap', 'lost_contact', 'funnel_unhealthy', 'commit_red', 'funnel_jitter']) {
      expect(kinds).toContain(k);
    }
  });

  it('出厂建议值正确（coverage 30/90、lost 90、health 1.0、yellow 0.8、jitter 0.3）', () => {
    const byKind = Object.fromEntries(listAlertRules().map(r => [r.kind, r]));
    expect(byKind.coverage_gap.check_params.target_days).toBe(30);
    expect(byKind.coverage_gap.check_params.potential_days).toBe(90);
    expect(byKind.lost_contact.check_params.lost_days).toBe(90);
    expect(byKind.funnel_unhealthy.check_params.health_min).toBe(1.0);
    expect(byKind.commit_red.check_params.yellow_low).toBe(0.8);
    expect(byKind.funnel_jitter.check_params.jitter_max).toBe(0.3);
  });

  it('evaluateForEvent 命中 coverage_gap（目标客户超期）', () => {
    const hits = evaluateForEvent({
      particleType: 'CRM_ACCOUNT', action: 'daily_scan',
      metric: { tier: '目标', daysSinceVisit: 40 },
    });
    expect(hits.some(h => h.rule.kind === 'coverage_gap')).toBe(true);
  });

  it('evaluateForEvent 命中 commit_red（承诺准确率红带）', () => {
    const hits = evaluateForEvent({
      particleType: 'CRM_DEAL', action: 'daily_scan',
      metric: { commitRate: 0.55 },
    });
    expect(hits.some(h => h.rule.kind === 'commit_red')).toBe(true);
  });

  it('evaluateForEvent 命中 lost_contact（>90 天无拜访）', () => {
    const hits = evaluateForEvent({
      particleType: 'CRM_ACCOUNT', action: 'daily_scan',
      metric: { daysSinceVisit: 100 },
    });
    expect(hits.some(h => h.rule.kind === 'lost_contact')).toBe(true);
  });

  it('evaluateForEvent 命中 funnel_jitter（抖动超 0.3）', () => {
    const hits = evaluateForEvent({
      particleType: 'CRM_DEAL', action: 'daily_scan',
      metric: { jitterRate: 0.45 },
    });
    expect(hits.some(h => h.rule.kind === 'funnel_jitter')).toBe(true);
  });
});