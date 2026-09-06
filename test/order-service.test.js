// test/order-service.test.js — T3-9 ORDER 粒子 + 状态看板（G25：业务对象看板视图）
// 验收：① 订单状态机单向前进（draft→confirmed→shipped→completed，跨步/回退拒绝） ② 看板聚合 ③ Action 接线
import { describe, it, expect, beforeEach } from 'vitest';
import { canAdvanceOrder, boardView } from '../src/sales/orderService.js';

// —— 状态机纯逻辑（无 PG）——
describe('T3-9 · 订单状态机纯逻辑', () => {
  it('单向逐步推进合法：draft→confirmed / confirmed→shipped / shipped→completed', () => {
    expect(canAdvanceOrder('draft', 'confirmed').ok).toBe(true);
    expect(canAdvanceOrder('confirmed', 'shipped').ok).toBe(true);
    expect(canAdvanceOrder('shipped', 'completed').ok).toBe(true);
  });

  it('跨步/回退/未知状态拒绝', () => {
    expect(canAdvanceOrder('draft', 'completed').ok).toBe(false); // 跨步
    expect(canAdvanceOrder('confirmed', 'draft').ok).toBe(false); // 回退
    expect(canAdvanceOrder('draft', 'draft').ok).toBe(false);      // 同态
    expect(canAdvanceOrder('unknown', 'confirmed').ok).toBe(false); // 未知
  });
});

// —— 看板聚合（无 PG）——
describe('T3-9 · 订单看板聚合', () => {
  it('按状态分桶：count/amount 四桶 + total', () => {
    const r = boardView([
      { status: 'draft', amount: 10000 },
      { status: 'confirmed', amount: 20000 },
      { status: 'confirmed', amount: 30000 },
      { status: 'shipped', amount: 40000 },
    ]);
    expect(r.buckets.draft).toEqual({ count: 1, amount: 10000 });
    expect(r.buckets.confirmed).toEqual({ count: 2, amount: 50000 });
    expect(r.buckets.shipped).toEqual({ count: 1, amount: 40000 });
    expect(r.buckets.completed).toEqual({ count: 0, amount: 0 });
    expect(r.total).toEqual({ count: 4, amount: 100000 });
    expect(r.flow).toEqual(['draft', 'confirmed', 'shipped', 'completed']);
  });

  it('未知状态容错归入 draft 桶', () => {
    const r = boardView([{ status: 'weird', amount: 999 }]);
    expect(r.buckets.draft).toEqual({ count: 1, amount: 999 });
  });
});

// —— Action 接线（T3-9：订单推进经 Action 注册）——
import { seedActions } from '../src/action/seed-actions.js';
import { resetRegistry, getAction, detectCrudExplosion } from '../src/action/registry.js';

describe('T3-9 · ORDER Action 接线', () => {
  beforeEach(() => {
    resetRegistry();
    seedActions();
  });

  it('crm-order-advance 已注册（confirm critical + autoDecision）', () => {
    const a = getAction('crm-order-advance');
    expect(a).not.toBeNull();
    expect(a.confirm).toBe('critical');
    expect(a.autoDecision).toBe(true);
    expect(a.namespace).toBe('crm');
  });

  it('crm-order-create 已注册（confirm normal + autoDecision）', () => {
    const a = getAction('crm-order-create');
    expect(a).not.toBeNull();
    expect(a.autoDecision).toBe(true);
    expect(a.confirm).toBe('normal');
    expect(a.namespace).toBe('crm');
  });

  it('反爆炸护栏：两个 order Action 均非 CRUD 爆炸', () => {
    const r = detectCrudExplosion();
    expect(r.exploded).toBe(false);
    expect(r.offenders).not.toContain('crm-order-create');
    expect(r.offenders).not.toContain('crm-order-advance');
  });
});