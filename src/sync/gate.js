// src/sync/gate.js — 接入与映射变更评审闸门（HITL 落点）
// 设计输入：docs/2026-09-15-final-design-coexistence-and-proactive.md §T10
// 四类动作：first-connect（首次接入）/ mapping-change（映射变更）/ trust-elevate（信任级别提升）/ enable-writeback（启用回写）
// 铁律：未获人工放行一律拒绝（fail-closed）；放行记录留 decision_id 与审批人；无自动放行路径
export const SYNC_GATE_ACTIONS = ['first-connect', 'mapping-change', 'trust-elevate', 'enable-writeback'];

export function createSyncGate({ reviewGate } = {}) {
  if (!reviewGate || typeof reviewGate.hasApproval !== 'function') {
    throw new Error('sync gate 需要注入 reviewGate.hasApproval');
  }
  async function check({ action, tenantId = 'system', ctx = {} } = {}) {
    if (!SYNC_GATE_ACTIONS.includes(action)) {
      return { ok: false, error: `unknown_action: ${action}` };
    }
    const approval = await reviewGate.hasApproval({ action, tenantId, ctx }).catch(() => null);
    if (!approval) return { ok: false, error: `not_approved: ${action} 未获人工放行` };
    return { ok: true, action, approval };
  }
  // 铁律：无 autoApprove（无自动放行路径）
  return { check, actions: SYNC_GATE_ACTIONS };
}
