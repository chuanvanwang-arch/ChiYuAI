// test/invoice-service.test.js — T3-8 INVOICE 粒子 + 核销闭环（F19：开票→回款→对账核销）
// 验收：① 发票写时校验（编号/类型/金额/日期/合同引用） ② 核销状态机 open→reconciled（实回≥发票金额） ③ Action 接线
import { describe, it, expect, beforeEach } from 'vitest';
import { canReconcile, nextReconcileStatus, validateInvoice } from '../src/sales/invoiceService.js';

// —— 核销纯逻辑（无 PG）——
describe('T3-8 · 发票核销纯逻辑', () => {
  it('实回≥发票金额 → 可核销（can=true, gap=0 或负数超额）', () => {
    const r = canReconcile(11800, [{ paid_amount: 8000 }, { paid_amount: 4000 }]);
    expect(r.can).toBe(true);
    expect(r.paid).toBe(12000);
    expect(r.gap).toBe(-200);
  });

  it('实回<发票金额 → 不可核销', () => {
    const r = canReconcile(11800, [{ paid_amount: 5000 }]);
    expect(r.can).toBe(false);
    expect(r.gap).toBe(6800);
  });

  it('状态机：open + 实回充足 → reconciled（changed=true）；不足 → 保持 open', () => {
    const yes = nextReconcileStatus('open', 11800, [{ paid_amount: 11800 }]);
    expect(yes.status).toBe('reconciled');
    expect(yes.changed).toBe(true);
    const no = nextReconcileStatus('open', 11800, [{ paid_amount: 3000 }]);
    expect(no.status).toBe('open');
    expect(no.changed).toBe(false);
  });

  it('状态机：已 reconciled → 幂等（不重复变更）', () => {
    const r = nextReconcileStatus('reconciled', 11800, [{ paid_amount: 11800 }]);
    expect(r.status).toBe('reconciled');
    expect(r.changed).toBe(false);
  });

  it('发票写时校验：编号/类型/金额非负/日期/合同引用', () => {
    const ok = validateInvoice({ invoice_no: 'FP-2026-001', invoice_type: '增值税专票', invoice_amount: 11800, invoice_date: '2026-08-25', contract_id: 'c_001' });
    expect(ok.ok).toBe(true);
    expect(ok.errors).toHaveLength(0);
    const bad = validateInvoice({ invoice_type: '增值税专票', invoice_amount: -1, contract_id: '' });
    expect(bad.ok).toBe(false);
    expect(bad.errors.length).toBeGreaterThanOrEqual(3); // 缺编号/负金额/缺日期/缺合同
  });
});

// —— Action 接线（T3-8：发票创建 / 核销经 Action 注册可写）——
import { seedActions } from '../src/action/seed-actions.js';
import { resetRegistry, getAction, detectCrudExplosion } from '../src/action/registry.js';

describe('T3-8 · 发票 Action 接线', () => {
  beforeEach(() => {
    resetRegistry();
    seedActions();
  });

  it('crm-invoice-create 已注册（confirm normal + autoDecision）', () => {
    const a = getAction('crm-invoice-create');
    expect(a).not.toBeNull();
    expect(a.autoDecision).toBe(true);
    expect(a.confirm).toBe('normal');
    expect(a.namespace).toBe('crm');
  });

  it('crm-invoice-reconcile 已注册（核销闭环入口）', () => {
    const a = getAction('crm-invoice-reconcile');
    expect(a).not.toBeNull();
    expect(a.autoDecision).toBe(true);
    expect(a.namespace).toBe('crm');
  });

  it('反爆炸护栏：两个 invoice Action 均非 CRUD 爆炸', () => {
    const r = detectCrudExplosion();
    expect(r.exploded).toBe(false);
    expect(r.offenders).not.toContain('crm-invoice-create');
    expect(r.offenders).not.toContain('crm-invoice-reconcile');
  });
});