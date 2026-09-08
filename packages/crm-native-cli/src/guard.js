// src/guard.js — 写操作红线：判定顺序即安全边界，必须排在任何转发/降级之前
// 真实写类工具名取自 src/action/seed-actions.js（kind: 'write'），另含 P2P 付费域动词以防跨系统误调
export const WRITE_TOOLS = new Set([
  'crm-deal-advance', 'crm-deal-reopen', 'crm-deal-swas-update',
  'crm-asset-attach', 'crm-knowledge-upsert', 'crm-memory-upsert',
  'data-particle-create', 'data-particle-update', 'data-particle-attr-update', 'data-particle-edge-create',
  'crm-approval-start', 'crm-approval-approve', 'crm-approval-add-sign', 'crm-approval-transfer', 'crm-approval-withdraw',
  'crm-review-gate-approve',
  'submit', 'approve', 'pay', 'split', 'reject', 'withdraw',
  'payment-budget-prehold', 'payment-budget-release', 'payment-hold',
  'crm-login', 'crm_login',
]);

// 前缀匹配：payment_* / write_* / delete_* / remove_* 一类
const WRITE_PREFIXES = ['payment-', 'payment_', 'write-', 'delete-', 'remove-'];

export function isWriteTool(name) {
  const n = String(name || '').toLowerCase();
  return WRITE_TOOLS.has(n) || WRITE_PREFIXES.some((p) => n.startsWith(p));
}

export function assertReadOnly(tool) {
  if (isWriteTool(tool)) {
    throw new Error(
      `拒绝执行写类工具 "${tool}"：crm-native-cli 第一版仅支持只读。` +
      `写操作须经 HITL 显式确认、携带 decision_id，并走 CRM_APPROVAL_FLOW；` +
      `线下/绕过系统的写入会形成治理缺口，请改用平台页面或已授权的写入通道。`
    );
  }
  return true;
}
