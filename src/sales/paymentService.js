// src/sales/paymentService.js — 回款对账回路（T3-7；设计 §B8：计划(应回) vs 记录(实回) = 对账 + 逾期预警）
// 原生机制：双粒子 + 本体边（§5ter-quater Q.7：对账 = 反馈闭环核心环节；财务闭环四对象）
// 写时管线：createPaymentPlan/Record → createParticle（hooks 自动建 has_contract 边 + 向量）
// 对账机制：Σplan_amount vs Σpaid_amount → 差额/逾期指标 → payment_due 事件（催收预警源）
import { emit } from '../events/bus.js';

// —— 对账核心（纯函数）：单计划 vs 实回记录 → 差额 + 状态 + 逾期判定 ——
// plan:   { id, contract_id, plan_amount, plan_end, plan_status }
// records:[{ paid_amount, paid_at }]
// 状态机：pending（差额=全额 且 未到期）→ partial（已部分回款）→ done（差额=0）
export function reconcilePlan(plan, records = [], { today = new Date() } = {}) {
  const planAmount = Number(plan.plan_amount) || 0;
  const paid = records.reduce((s, r) => s + (Number(r.paid_amount) || 0), 0);
  const gap = planAmount - paid;
  const planEnd = plan.plan_end ? new Date(plan.plan_end) : null;
  const overdue = planEnd ? planEnd < today && paid < planAmount : false;
  const dueDays = planEnd && overdue ? Math.ceil((today - planEnd) / 86400000) : 0;
  const status = paid >= planAmount ? 'done' : (paid > 0 ? 'partial' : 'pending');
  return { plan_id: plan.id, contract_id: plan.contract_id, plan_amount: planAmount, paid, gap, status, overdue, due_days: dueDays };
}

// —— 批量对账（合同维度聚合）：Σ计划 vs Σ实回 → 合同应回/实回/差额 ——
export function reconcileContract(plans, recordsByPlan) {
  const byPlan = new Map(plans.map((p) => [p.id, reconcilePlan(p, recordsByPlan.get(p.id) || [])]));
  const rows = [...byPlan.values()];
  return {
    rows,
    total_plan: rows.reduce((s, r) => s + r.plan_amount, 0),
    total_paid: rows.reduce((s, r) => s + r.paid, 0),
    total_gap: rows.reduce((s, r) => s + r.gap, 0),
    overdue_plans: rows.filter((r) => r.overdue),
  };
}

// —— 逾期检查（事件源）：任一计划逾期 → 触发 payment_due（财务预警 + 催收优先级）——
// §B8 验收②：逾期自动触发催收预警（事件源）
export function checkOverdueAndEmit(contractId, plans, recordsByPlan, { today = new Date(), emitFn = emit } = {}) {
  const { rows } = reconcileContract(plans, recordsByPlan);
  const overdue = rows.filter((r) => r.overdue);
  if (overdue.length) {
    emitFn('payment', 'payment_due', {
      contract_id: contractId,
      overdue_plans: overdue.map((r) => ({ plan_id: r.plan_id, gap: r.gap, due_days: r.due_days })),
      total_gap: overdue.reduce((s, r) => s + r.gap, 0),
      priority: overdue.some((r) => r.due_days >= 30) ? 'high' : 'normal',
    });
    // S05 T6 第二维：逐计划逾期事件（供 financeAlertHook 判 payment_due_plan 告警）
    for (const r of overdue) {
      emitFn('payment', 'payment_overdue_plan', {
        particleType: 'CRM_PAYMENT_PLAN',
        contract_id: contractId,
        plan_id: r.plan_id,
        gap: r.gap,
        due_days: r.due_days,
      });
    }
  }
  return overdue;
}

// —— 写时管线：回款计划（应回侧）——
export async function createPaymentPlan({ contract_id, plan_seq, plan_amount, plan_end, tenantId = 'system', decisionId = null }) {
  const { createParticle } = await import('../particles/particleRepo.js');
  const plan = await createParticle('CRM_PAYMENT_PLAN', {
    contract_id, plan_seq, plan_amount, plan_end, plan_status: 'pending', invalid: false,
  }, { tenantId, requireDecisionId: decisionId });
  return plan;
}

// —— 写时管线：回款记录（实回侧）——
export async function createPaymentRecord({ contract_id, paid_seq, paid_amount, paid_at = new Date().toISOString(), voucher = null, tenantId = 'system', decisionId = null }) {
  const { createParticle } = await import('../particles/particleRepo.js');
  const record = await createParticle('CRM_PAYMENT_RECORD', {
    contract_id, paid_seq, paid_amount, paid_at, voucher, invalid: false,
  }, { tenantId, requireDecisionId: decisionId });
  return record;
}