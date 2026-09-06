// test/payment-service.test.js — T3-7 PAYMENT_PLAN/RECORD 双粒子 + 对账回路
// 验收：① 计划(应回) vs 记录(实回) 对账（差额/逾期指标可算） ② 逾期自动触发催收预警（payment_due 事件源）
import { describe, it, expect, beforeEach } from 'vitest';
import { reconcilePlan, reconcileContract, checkOverdueAndEmit } from '../src/sales/paymentService.js';

// —— 对账纯逻辑（无 PG）——
describe('T3-7 · 对账回路纯逻辑', () => {
  it('pending：无实回且未到期 → gap=全额', () => {
    const r = reconcilePlan(
      { id: 'p1', contract_id: 'c1', plan_amount: 100000, plan_end: '2026-09-30' },
      [],
      { today: new Date('2026-08-25') }
    );
    expect(r.gap).toBe(100000);
    expect(r.status).toBe('pending');
    expect(r.overdue).toBe(false);
  });

  it('partial→done：部分实回 → partial；实回≥计划 → done', () => {
    const partial = reconcilePlan(
      { id: 'p2', contract_id: 'c1', plan_amount: 100000, plan_end: '2026-09-30' },
      [{ paid_amount: 40000 }],
      { today: new Date('2026-08-25') }
    );
    expect(partial.gap).toBe(60000);
    expect(partial.status).toBe('partial');
    const done = reconcilePlan(
      { id: 'p3', contract_id: 'c1', plan_amount: 100000, plan_end: '2026-09-30' },
      [{ paid_amount: 60000 }, { paid_amount: 40000 }],
      { today: new Date('2026-08-25') }
    );
    expect(done.status).toBe('done');
    expect(done.gap).toBe(0);
  });

  it('逾期：plan_end 已过且实回不足 → overdue + due_days', () => {
    const r = reconcilePlan(
      { id: 'p4', contract_id: 'c1', plan_amount: 100000, plan_end: '2026-07-31' },
      [{ paid_amount: 30000 }],
      { today: new Date('2026-08-25') }
    );
    expect(r.overdue).toBe(true);
    expect(r.due_days).toBe(25);
    expect(r.gap).toBe(70000);
  });

  it('批量对账：合同维度 Σ计划/Σ实回/Σ差额 + 逾期计划列表', () => {
    const r = reconcileContract(
      [
        { id: 'p1', contract_id: 'c1', plan_amount: 100000, plan_end: '2026-09-30' },
        { id: 'p2', contract_id: 'c1', plan_amount: 50000, plan_end: '2026-07-31' },
      ],
      new Map([
        ['p1', [{ paid_amount: 40000 }]],
        ['p2', []],
      ])
    );
    expect(r.total_plan).toBe(150000);
    expect(r.total_paid).toBe(40000);
    expect(r.total_gap).toBe(110000);
    expect(r.overdue_plans).toHaveLength(1);
    expect(r.overdue_plans[0].plan_id).toBe('p2');
  });
});

// —— 逾期事件源（payment_due → 财务预警 + 催收优先级）——
describe('T3-7 · payment_due 事件源', () => {
  it('无逾期 → 不触发事件', () => {
    const emitted = [];
    checkOverdueAndEmit('c1',
      [{ id: 'p1', plan_amount: 100000, plan_end: '2026-09-30' }],
      new Map([['p1', [{ paid_amount: 100000 }]]]),
      { today: new Date('2026-08-25'), emitFn: (...a) => emitted.push(a) }
    );
    expect(emitted).toHaveLength(0);
  });

  it('有逾期 → payment_due 携带 contract_id + gap + 优先级', () => {
    const emitted = [];
    const overdue = checkOverdueAndEmit('c1',
      [
        { id: 'p1', plan_amount: 100000, plan_end: '2026-08-01' }, // 逾期 24 天
        { id: 'p2', plan_amount: 50000, plan_end: '2026-09-30' },
      ],
      new Map([['p1', [{ paid_amount: 20000 }]], ['p2', []]]),
      { today: new Date('2026-08-25'), emitFn: (...a) => emitted.push(a) }
    );
    expect(overdue).toHaveLength(1);
    expect(emitted[0][0]).toBe('payment');
    expect(emitted[0][1]).toBe('payment_due');
    expect(emitted[0][2].contract_id).toBe('c1');
    expect(emitted[0][2].total_gap).toBe(80000);
  });

  it('逾期 ≥30 天 → 催收优先级 high', () => {
    const emitted = [];
    checkOverdueAndEmit('c1',
      [{ id: 'p1', plan_amount: 100000, plan_end: '2026-07-01' }],
      new Map([['p1', []]]),
      { today: new Date('2026-08-25'), emitFn: (...a) => emitted.push(a) }
    );
    expect(emitted[0][2].priority).toBe('high');
  });
});

// —— 双粒子写接线（T3-7：应回/实回均经 Action 注册可写；反爆炸护栏不误伤）——
import { seedActions } from '../src/action/seed-actions.js';
import { resetRegistry, getAction, detectCrudExplosion } from '../src/action/registry.js';

describe('T3-7 · PAYMENT 双粒子 Action 接线', () => {
  beforeEach(() => {
    resetRegistry();
    seedActions();
  });

  it('crm-payment-plan-create 已注册（应回侧，confirm normal）', () => {
    const a = getAction('crm-payment-plan-create');
    expect(a).not.toBeNull();
    expect(a.autoDecision).toBe(true);
    expect(a.confirm).toBe('normal');
    expect(a.namespace).toBe('crm');
  });

  it('crm-payment-record-create 已注册（实回侧，confirm normal）', () => {
    const a = getAction('crm-payment-record-create');
    expect(a).not.toBeNull();
    expect(a.autoDecision).toBe(true);
    expect(a.namespace).toBe('crm');
  });

  it('反爆炸护栏：两个 payment Action 均非 CRUD 爆炸', () => {
    const r = detectCrudExplosion();
    expect(r.exploded).toBe(false);
    expect(r.offenders).not.toContain('crm-payment-plan-create');
    expect(r.offenders).not.toContain('crm-payment-record-create');
  });
});