// src/approval/stateMachine.js — 审批实例状态机：状态×操作矩阵（G23 实证）
// 实证（§5bis G23）：流程状态（待提交/审批中/已通过/已驳回/已撤销）× 操作（查看/编辑/提交/审批/撤销）
// 状态机内建：非法操作从机制上不可能（审批态禁删 = 禁删红线；终态保护 = 审计留痕）
export const INSTANCE_STATES = ['PENDING_SUBMIT', 'APPROVING', 'APPROVED', 'REJECTED', 'CANCELED'];

// 操作集（G23 实证收敛）：
//   submit   提交（PENDING_SUBMIT → APPROVING）
//   approve_all  会签全过（APPROVING → APPROVED）
//   approve_any  或签一过（APPROVING → APPROVED）
//   reject   驳回（APPROVING → REJECTED）
//   cancel   撤销（APPROVING → CANCELED）
//   withdraw 提交人撤回（PENDING_SUBMIT/APPROVING → CANCELED）
//   add_sign / return / transfer  加签/退回/转交（APPROVING 内任务级操作，不改实例状态）
//   view     终态只读（无状态迁移）
export const OPERATIONS_BY_STATE = {
  PENDING_SUBMIT: ['submit', 'edit', 'withdraw'],
  APPROVING: ['approve_all', 'approve_any', 'reject', 'cancel', 'add_sign', 'return', 'transfer', 'withdraw'],
  APPROVED: ['view'],
  REJECTED: ['view'],
  CANCELED: ['view'],
};

export function canTransition(state, op) {
  return (OPERATIONS_BY_STATE[state] || []).includes(op);
}

export function assertTransition(state, op) {
  if (!canTransition(state, op)) {
    throw new Error(`状态机拒绝: ${state} 不允许操作 ${op}（合法: ${(OPERATIONS_BY_STATE[state] || []).join('/')}）`);
  }
  return true;
}

// 状态推进（在审批实例上应用操作 → 新状态；任务级操作不改实例状态）
export function nextState(state, op) {
  assertTransition(state, op);
  if (op === 'submit') return 'APPROVING';
  if (op === 'approve_all' || op === 'approve_any') return 'APPROVED';
  if (op === 'reject') return 'REJECTED';
  if (op === 'cancel' || op === 'withdraw') return 'CANCELED';
  return state; // add_sign/return/transfer 不改变实例状态（仅任务移动）
}