// src/alerts/financeAlertHook.js — S05 T6 财务逾期告警钩子（订阅 bus 'payment' 域）
// 触发：checkOverdueAndEmit 第二维 emit('payment','payment_overdue_plan',{...})（时间推移产生，非粒子写事件）
// 链路：on('payment') → 匹配 payment_due_plan 规则 → 动态读 config_store['finance-receivables'].payment_overdue_days
//       → evaluateAlertRule 判定 → createAlert + emit('alert','alert_created',...)（与 alertHook 同链路）
// 订阅者抛错绝不阻断业务主流程（bus.js:2 订阅者异常隔离）
import { on, emit } from '../events/bus.js';
import { enabledAlertRules } from './alertRegistry.js';
import { evaluateAlertRule } from './ruleEvaluator.js';
import { createAlert } from './alertStore.js';
import { readConfig } from '../config/configStore.js';

let unsub = null;

export function registerFinanceAlertHook() {
  if (unsub) return unsub;
  unsub = on('payment', (msg) => {
    if (msg.type !== 'payment_overdue_plan') return;
    const rule = enabledAlertRules().find((r) => r.kind === 'payment_due_plan');
    if (!rule) return;
    void (async () => {
      try {
        // 动态阈值：config_store['finance-receivables'].payment_overdue_days 覆盖规则缺省 due_days（fail-open 读缺省）
        let dueDays = rule.check_params?.due_days ?? 7;
        // 租户化（T2，P0）：事件载荷携带租户（checkOverdueAndEmit 第二维 payload 无 tenant_id 时恒回退 'system'，
        //   fail-open 不阻断——设计 §6 风险「events 载荷无 tenant_id」的兜底链）
        const tenantId = msg.summary?.tenant_id || msg.tenant_id || 'system';
        try {
          const c = await readConfig('finance-receivables', { tenantId });
          dueDays = c?.value?.payment_overdue_days ?? dueDays;
        } catch { /* fail-open 保持缺省 */ }
        const metric = { dueDays: msg.summary?.due_days ?? 0 };
        const r = evaluateAlertRule(
          { ...rule, check_params: { ...rule.check_params, due_days: dueDays } },
          { particleType: 'CRM_PAYMENT_PLAN', action: 'payment_overdue_plan', metric }
        );
        if (r.hit) {
          const a = createAlert({
            kind: 'payment_due_plan',
            severity: 'high',
            target_role: 'finance',
            particle_id: msg.summary?.plan_id || null,
            payload: r.payload,
          });
          if (a.ok) emit('alert', 'alert_created', { alert: a.alert, kind: 'payment_due_plan' });
        }
      } catch (e) {
        console.error('[financeAlertHook] error:', e?.message);
      }
    })();
  });
  return unsub;
}

export function unregisterFinanceAlertHook() {
  if (unsub) { unsub(); unsub = null; }
}