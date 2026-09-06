// test/alerts/payment-due-plan.test.js — S05 T6 逾期规则扩维到 PAYMENT_PLAN（TDD：先失败后实现）
// 验证：① alertRegistry 注册 payment_due_plan 规则；② 逾期 PAYMENT_PLAN 事件 → financeAlertHook 命中 → createAlert + SSE
import { describe, it, expect } from 'vitest';
import { registerFinanceAlertHook, unregisterFinanceAlertHook } from '../../src/alerts/financeAlertHook.js';
import { emit } from '../../src/events/bus.js';
import { listAlertRules, resetAlertRegistry, enabledAlertRules } from '../../src/alerts/alertRegistry.js';
import { listAlerts, resetAlertStore } from '../../src/alerts/alertStore.js';
import { query } from '../../src/db.js';

describe('PAYMENT_PLAN 逾期 → payment_due_plan 告警', () => {
  it('alertRegistry 含 payment_due_plan 规则', () => {
    resetAlertRegistry();
    expect(listAlertRules().some((x) => x.kind === 'payment_due_plan')).toBe(true);
  });

  it('逾期 PAYMENT_PLAN 事件 → alerts 新增 payment_due_plan + SSE', async () => {
    resetAlertRegistry();
    resetAlertStore();
    // 隔离：清掉 config_store['finance-receivables']（T5 PUT 可能残留，保证测缺省 7 命中）
    try { await query(`DELETE FROM crm.config_store WHERE key='finance-receivables'`); } catch {}
    unregisterFinanceAlertHook();
    registerFinanceAlertHook();
    const before = (await listAlerts()).length;
    console.log('[t6] before:', before);
    emit('payment', 'payment_overdue_plan', { particleType: 'CRM_PAYMENT_PLAN', contract_id: 'CT1', plan_id: 'P1', due_days: 10 });
    // hook 内异步（含 config_store DB 读）→ 等待完成
    await new Promise((r) => setTimeout(r, 300));
    const after = (await listAlerts()).length;
    expect(after).toBe(before + 1);
    const newest = (await listAlerts())[after - 1];
    expect(newest.kind).toBe('payment_due_plan');
    expect(newest.target_role).toBe('finance');
    unregisterFinanceAlertHook();
  });
});