// test/signal-freshness.test.js — P0-1a 信号时间衰减纯函数（设计 docs/2026-09-15-anysite-borrowing-analysis.md §3 P0-1）
// 纯函数测试，零 DB 依赖；直连约定：PGDATABASE=crm_native_test 先设再 import
import { describe, it, expect } from 'vitest';
import { freshnessMultiplier, ageDaysOf, DEFAULT_AGE_TIERS } from '../src/config/signalFreshness.js';

describe('freshnessMultiplier', () => {
  it('新鲜（≤7天）返回 1.0', () => {
    expect(freshnessMultiplier(3, DEFAULT_AGE_TIERS)).toBe(1.0);
  });
  it('30天内按档衰减到 0.6', () => {
    expect(freshnessMultiplier(20, DEFAULT_AGE_TIERS)).toBe(0.6);
  });
  it('90天内按档衰减到 0.3', () => {
    expect(freshnessMultiplier(60, DEFAULT_AGE_TIERS)).toBe(0.3);
  });
  it('陈旧（>90天）落到 0.1', () => {
    expect(freshnessMultiplier(120, DEFAULT_AGE_TIERS)).toBe(0.1);
  });
  it('缺省状态(无 ts)按 1.0（向后兼容）', () => {
    expect(freshnessMultiplier(null, DEFAULT_AGE_TIERS)).toBe(1.0);
  });
  it('tiers 为空 → 1.0（向后兼容）', () => {
    expect(freshnessMultiplier(50, [])).toBe(1.0);
  });
});

describe('ageDaysOf', () => {
  it('3 天前 → 3', () => {
    expect(ageDaysOf(Date.now() - 3 * 86400000)).toBe(3);
  });
  it('无 ts → null', () => {
    expect(ageDaysOf(null)).toBe(null);
  });
  it('非法 ts → null', () => {
    expect(ageDaysOf('not-a-date')).toBe(null);
  });
});
