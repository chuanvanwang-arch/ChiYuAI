// src/sales/invoiceService.js — 发票核销闭环（T3-8；设计 §F19：开票(应核销)→回款(实回)→对账核销）
// 发票 = 「业务→财务」数据协同的接缝层：开票记录 + 实回关联 + 核销状态机（open→reconciled）
// 写时管线：createInvoice → createParticle（hooks 自动建 has_contract 边 + 向量）
//           核销条件：累计实回 ≥ 发票金额 → reconcileInvoice 置 reconciled（幂等）
import { emit } from '../events/bus.js';

// —— 核销判定（纯函数）：累计实回 vs 发票金额 → 是否可核销 ——
// records: [{ paid_amount, contract_id }]（该合同下实回记录）
export function canReconcile(invoice_amount, records) {
  const paid = (records || []).reduce((s, r) => s + (Number(r.paid_amount) || 0), 0);
  return { paid, can: paid >= Number(invoice_amount), gap: Number(invoice_amount) - paid };
}

// —— 核销状态机（纯函数）：open → reconciled（条件满足才允许）——
export function nextReconcileStatus(current, invoice_amount, records) {
  if (current === 'reconciled') return { status: 'reconciled', changed: false, ...canReconcile(invoice_amount, records) };
  const check = canReconcile(invoice_amount, records);
  if (!check.can) return { status: 'open', changed: false, ...check };
  return { status: 'reconciled', changed: true, ...check };
}

// —— 发票校验（写时闸：编号/类型/金额非负/日期必填，对齐 F19 字段集）——
export function validateInvoice({ invoice_no, invoice_type, invoice_amount, invoice_date, contract_id }) {
  const errors = [];
  if (!invoice_no || !String(invoice_no).trim()) errors.push('发票编号必填（invoice_no）');
  if (!invoice_type) errors.push('发票类型必填（invoice_type）');
  if (invoice_amount == null || Number(invoice_amount) < 0) errors.push('发票金额不可为负（invoice_amount）');
  if (!invoice_date) errors.push('开票日期必填（invoice_date）');
  if (!contract_id) errors.push('缺少 contract_id 引用（发票挂合同）');
  return { ok: errors.length === 0, errors };
}

// —— 写时管线：创建发票（应核销侧）——
export async function createInvoice({ invoice_no, invoice_type, invoice_amount, invoice_date, contract_id, customer_id, attachments = [], tenantId = 'system', decisionId = null }) {
  const check = validateInvoice({ invoice_no, invoice_type, invoice_amount, invoice_date, contract_id });
  if (!check.ok) throw new Error(`发票校验失败: ${check.errors.join('; ')}`);
  const { createParticle } = await import('../particles/particleRepo.js');
  const invoice = await createParticle('CRM_INVOICE', {
    invoice_no, invoice_type, invoice_amount, invoice_date, contract_id, customer_id,
    attachments, reconcile_status: 'open', invalid: false,
  }, { tenantId, requireDecisionId: decisionId });
  emit('crm', 'invoice-created', { invoice_id: invoice.id, contract_id, invoice_amount });
  return invoice;
}

// —— 核销闭环（F19：开票→回款→对账核销可追踪）：实回记录到达后核销发票 ——
// 条件：该合同累计实回 ≥ 发票金额；幂等（已核销不重复）
export async function reconcileInvoice(invoiceId, invoice_amount, records, { tenantId = 'system', decisionId = null } = {}) {
  const next = nextReconcileStatus('open', invoice_amount, records);
  if (!next.changed) return { ok: false, status: next.status, reason: `实回不足: paid=${next.paid} < invoice=${invoice_amount}`, ...next };
  const { updateParticle } = await import('../particles/particleRepo.js');
  const invoice = await updateParticle(invoiceId, { patch: { reconcile_status: 'reconciled', reconciled_at: new Date().toISOString() }, requireDecisionId: decisionId });
  emit('crm', 'invoice-reconciled', { invoice_id: invoiceId, paid: next.paid, invoice_amount });
  return { ok: true, status: 'reconciled', ...next };
}