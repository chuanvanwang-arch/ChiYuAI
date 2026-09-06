// src/approval/rules.js — 审批流四类配置项执行语义（G22 实证）
// 实证（§5bis G22）：①条件分支 ②审批模式 ③表单权限（隐藏/查看/编辑）④结果后动作
// 联动：规则闸（B7 写护栏）+ 决策闸（写操作第 0 闸，无决策不写）
export const FIELD_PERM_ACTIONS = { HIDE: 'hide', VIEW: 'view', EDIT: 'edit' };

export const POST_ACTIONS = { pass: 'auto-update', reject: 'rollback' };

// 四类配置项 → 执行语义（条件分支/审批模式/字段权限/结果后动作）
export function buildApprovalRules({ conditions = [], mode = 'ANY', field_perms = {}, post = {} }) {
  return {
    route: conditions.length ? 'conditional' : 'direct',   // 条件分支：有条件→路由，无条件→直通
    mode,                                                  // 审批模式：ANY/ALL/SEQUENTIAL
    field_perm: Object.fromEntries(
      Object.entries(field_perms).map(([f, p]) => [f, FIELD_PERM_ACTIONS[p] || p])),
    post: { pass: post.pass || POST_ACTIONS.pass, reject: post.reject || POST_ACTIONS.reject },
  };
}

// 审批×规则闸联动：写操作进入审批流前，先过规则层
// （B7 实证「商机只能向前/合同金额超 20% 审批」）
export function approvalGateRules() {
  return [
    { scope: 'CRM_DEAL', condition: 'stage_forward_only', action: 'block_if_violation' },
    { scope: 'CRM_CONTRACT', condition: 'amount_change_over_20pct', action: 'escalate_to_approval' },
    { scope: 'CRM_QUOTATION', condition: 'amount_gt_threshold', action: 'escalate_to_approval' },
  ];
}