// test/pool.test.js — 线索池规则（B6：PickRule 领取校验 + RecycleRule 回收判据）
// 纯逻辑本地可跑（无 PG 依赖）；池 = 组织治理配置（挂 CRM_ORGANIZATION.pool_config）
import { describe, it, expect } from 'vitest';
import { checkPickRule, checkRecycleRule, DEFAULT_POOL_CONFIG } from '../src/sales/pool.js';

describe('领取校验 checkPickRule（B6 PickRule 四条件）', () => {
  it('每日限额：今日领取已达上限 → 拒绝', () => {
    const r = checkPickRule(DEFAULT_POOL_CONFIG.pick_rule, { owner: 'person-sales-a', today_picked_count: 10 });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain('daily_limit');
  });
  it('每日限额：未达上限 → 放行', () => {
    const r = checkPickRule(DEFAULT_POOL_CONFIG.pick_rule, { owner: 'person-sales-a', today_picked_count: 2 });
    expect(r.ok).toBe(true);
  });
  it('领取间隔：距上次领取不足 24h → 拒绝', () => {
    const r = checkPickRule(DEFAULT_POOL_CONFIG.pick_rule, {
      owner: 'person-sales-a', last_picked_at: new Date(Date.now() - 1 * 3600000).toISOString(),
    });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain('pick_interval');
  });
  it('领取间隔：超过 24h → 放行', () => {
    const r = checkPickRule(DEFAULT_POOL_CONFIG.pick_rule, {
      owner: 'person-sales-a', last_picked_at: new Date(Date.now() - 48 * 3600000).toISOString(),
    });
    expect(r.ok).toBe(true);
  });
  it('限前归属人领取（prev_owner_only=true）→ 非前归属拒绝', () => {
    const r = checkPickRule({ ...DEFAULT_POOL_CONFIG.pick_rule, prev_owner_only: true },
      { owner: 'person-sales-b', prev_owner: 'person-sales-a' });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain('prev_owner_only');
  });
  it('限前归属人领取（prev_owner_only=true）+ 前归属本人 → 放行', () => {
    const r = checkPickRule({ ...DEFAULT_POOL_CONFIG.pick_rule, prev_owner_only: true },
      { owner: 'person-sales-a', prev_owner: 'person-sales-a' });
    expect(r.ok).toBe(true);
  });
  it('限新数据（new_data_only=true）+ 已跟进 → 拒绝', () => {
    const r = checkPickRule(DEFAULT_POOL_CONFIG.pick_rule, { owner: 'a', follow_up_at: '2026-08-01T00:00:00Z', is_new: false });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain('new_data_only');
  });
});

describe('回收判据 checkRecycleRule（B6 RecycleRule 超期未跟进）', () => {
  it('从未跟进 → 不回收（避免新线索误回收）', () => {
    const r = checkRecycleRule(DEFAULT_POOL_CONFIG.recycle_rule, { last_follow_up_at: null });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('never_followed_up');
  });
  it('超期（>30 天未跟进）→ 回收', () => {
    const r = checkRecycleRule(DEFAULT_POOL_CONFIG.recycle_rule,
      { last_follow_up_at: new Date(Date.now() - 45 * 86400000).toISOString() });
    expect(r.ok).toBe(true);
    expect(r.reason).toContain('45d');
  });
  it('30 天内跟进过 → 不回收', () => {
    const r = checkRecycleRule(DEFAULT_POOL_CONFIG.recycle_rule,
      { last_follow_up_at: new Date(Date.now() - 10 * 86400000).toISOString() });
    expect(r.ok).toBe(false);
  });
  it('自定义回收阈值生效（recycle_days=60）', () => {
    const r = checkRecycleRule({ ...DEFAULT_POOL_CONFIG.recycle_rule, recycle_days: 60 },
      { last_follow_up_at: new Date(Date.now() - 45 * 86400000).toISOString() });
    expect(r.ok).toBe(false);
  });
});