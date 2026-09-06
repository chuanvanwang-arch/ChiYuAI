// test/http/named-accounts-cov.test.js — Task 7：boardSummary cov* 消费 + 21 条合格率配置化
// 设计：docs/2026-08-30-sales-indicator-3class-deep-implementation-design.md §2
// 语义（B 类展示）：标准卡读 cov* 六键（sales-thresholds 出厂标准）；21 条合格率着色阈值
//   硬编码 80 → 读配置键 behavior_pass_rate_ok（防阈值漂移，配置中心可调）
import { describe, it, expect } from 'vitest';
import { boardSummary } from '../../src/sales/namedAccountBoard.js';
import { mergedThresholds } from '../../src/sales/salesThresholds.js';

describe('boardSummary cov* 消费', () => {
  it('cov* 六键 + 达标布尔齐全', () => {
    const s = boardSummary([], [], [], {}, null, [], {}, mergedThresholds({}));
    expect(s.covDailyVisitTarget).toBe(3);
    expect(s.covWeeklyVisitTarget).toBe(15);
    expect(s.covDailyVisitOptimized).toBe(4);
    expect(s.covInfoCollectWeekly).toBe(5);
    expect(s.covCustomerCountMin).toBe(60);
    expect(s.covCustomerCountTarget).toBe(75);
    expect(s.covVisitsOk).toBe(false);
    expect(s.covWeekVisitsOk).toBe(false);
    expect(s.covCustomerOk).toBe(false);
  });
  it('客户数 < 60 -> covCustomerOk false', () => {
    const accounts = [{ id: 'a1', payload: { owner_id: 'alice', owner: 'alice' } }];
    const s = boardSummary(accounts, [], [], {}, 'alice', [], {}, mergedThresholds({}));
    expect(s.covCustomerOk).toBe(false);
  });
  it('阈值随配置变化', () => {
    const s = boardSummary([], [], [], {}, null, [], {}, mergedThresholds({ coverage: { customer_count_min: 80 } }));
    expect(s.covCustomerCountMin).toBe(80);
  });
  it('21 条合格率着色阈值配置化（behavior_pass_rate_ok）', () => {
    const s = boardSummary([], [], [], {}, null, [], {}, mergedThresholds({ ui: { behavior_pass_rate_ok: 85 } }));
    expect(s.behaviorPassRateThreshold).toBe(85);
    const d = boardSummary([], [], [], {}, null, [], {}, mergedThresholds({}));
    expect(d.behaviorPassRateThreshold).toBe(80); // 出厂默认 80
  });
});