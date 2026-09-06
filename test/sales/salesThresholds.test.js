// test/sales/salesThresholds.test.js — 判定阈值配置化（T11）红灯用例
// 配套设计：docs/2026-08-30-sales-thresholds-config-design.md §5
// 原则：业务阈值不得硬编码在 SKILL 或代码中，一律走 config_store['sales-thresholds']；
//       代码仅在配置缺失时回退 DEFAULT_THRESHOLDS（保证向后兼容）。
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_THRESHOLDS,
  readThreshold,
  mergedThresholds,
  deriveRhythmDays,
} from '../../src/sales/salesThresholds.js';

describe('【T11】判定阈值配置化', () => {
  it('T11-C1 readThreshold 读配置值优先于默认值', () => {
    const cfg = { bantcc: { pass: 0.8 } };
    expect(readThreshold(cfg, 'bantcc.pass')).toBe(0.8);
  });

  it('T11-C2 readThreshold 配置缺失时回退默认', () => {
    expect(readThreshold({}, 'bantcc.pass')).toBe(DEFAULT_THRESHOLDS.bantcc.pass);
    expect(readThreshold(undefined, 'bantcc.pass')).toBe(0.6);
    expect(readThreshold({ bantcc: {} }, 'bantcc.pass')).toBe(0.6);
  });

  it('T11-C3 mergedThresholds 铺底 + 覆写（深层合并，不丢键）', () => {
    const m = mergedThresholds({ bantcc: { pass: 0.9 }, stage: { stuck_days: 45 } });
    expect(m.bantcc.pass).toBe(0.9);
    expect(m.bantcc.unknown).toBe(0.5); // 未覆写项保留默认
    expect(m.stage.stuck_days).toBe(45);
    expect(m.behavior.min_contacts).toBe(2); // 未提及的分组完整保留
  });

  it('T11-C4 deriveRhythmDays 从 id30 window_days 派生（消除双源漂移）', () => {
    const targetsCfg = { window_days: { week: 7, month: 30, quarter: 90 } };
    const d = deriveRhythmDays(targetsCfg, DEFAULT_THRESHOLDS);
    expect(d.potential_days).toBe(90); // quarter
    expect(d.target_days).toBe(30);    // month
  });

  it('T11-C6 指名拜访告警阈值默认：warn_days=1 / alert_days=2（零硬编码走配置）', () => {
    expect(DEFAULT_THRESHOLDS.coverage.named_visit_warn_days).toBe(1);
    expect(DEFAULT_THRESHOLDS.coverage.named_visit_alert_days).toBe(2);
    // readThreshold 读路径生效（配置覆写）
    expect(readThreshold({ coverage: { named_visit_alert_days: 5 } }, 'coverage.named_visit_alert_days')).toBe(5);
    expect(readThreshold({}, 'coverage.named_visit_alert_days')).toBe(2);
  });

  it('T11-C5 id30 缺失时 deriveRhythmDays 回退默认 90/30', () => {
    const d = deriveRhythmDays({}, DEFAULT_THRESHOLDS);
    expect(d.potential_days).toBe(90);
    expect(d.target_days).toBe(30);
  });

  it('T11-C5b 自定义 window_days 时派生值同步变化', () => {
    const targetsCfg = { window_days: { month: 20, quarter: 60 } };
    const d = deriveRhythmDays(targetsCfg, DEFAULT_THRESHOLDS);
    expect(d.potential_days).toBe(60);
    expect(d.target_days).toBe(20);
  });

  it('T11-C6 DEFAULT_THRESHOLDS 覆盖全部 13 项阈值键', () => {
    expect(DEFAULT_THRESHOLDS.bantcc.pass).toBe(0.6);
    expect(DEFAULT_THRESHOLDS.bantcc.unknown).toBe(0.5);
    expect(DEFAULT_THRESHOLDS.behavior.min_customer_types).toBe(2);
    expect(DEFAULT_THRESHOLDS.behavior.min_contacts).toBe(2);
    expect(DEFAULT_THRESHOLDS.behavior.recent_visit_days).toBe(7);
    expect(DEFAULT_THRESHOLDS.rhythm.adherence_window_days).toBe(30);
    expect(DEFAULT_THRESHOLDS.stage.stuck_days).toBe(30);
    expect(DEFAULT_THRESHOLDS.gate.s1_s2_min_need_facts).toBe(2);
    expect(DEFAULT_THRESHOLDS.ui.behavior_pass_rate_ok).toBe(80);
    expect(DEFAULT_THRESHOLDS.taoran.achieved_ratio).toBe(80);
  });
});
