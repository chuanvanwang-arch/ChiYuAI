// src/signal/adoption.js — T18 建议卡采纳/否决回路（写通道第 0 闸）
// 采纳：必带 decision_id（无则拒，第 0 闸）→ signal.status='acted' + action_ref 落库 + 写 crm.decision_outcome
// 否决：必带 decision_id → 写 crm.decision_outcome（source='suggestion-reject'）→ signal 关闭
// 设计：docs/2026-09-15-final-design-coexistence-and-proactive.md §T18（建议卡回写经决策，绝不越权改业务）
import { writeOutcome as defaultWriteOutcome } from '../decision/outcome.js';

export function createAdoption({ signalStore, writeOutcome = defaultWriteOutcome } = {}) {
  // 采纳：人 mint 决策调既有 Action；本函数只做「采纳记账」（action 执行由调用方经既有 Action 完成）
  async function adopt({ signal_id, tenant_id = 'system', actor, decision_id, suggestedAction = null } = {}) {
    if (!decision_id) return { ok: false, error: 'decision_required' }; // 第 0 闸：无决策凭证不写
    const r = await signalStore.setStatus(tenant_id, signal_id, 'acted', { action_ref: suggestedAction, decision_id }).catch(() => ({ ok: false }));
    if (r?.ok) {
      await writeOutcome(decision_id, {
        outcome_type: 'other', source: 'suggestion-adopt',
        payload: { signal_id, suggested_action: suggestedAction, adopted_by: actor },
      }).catch(() => {});
    }
    return { ok: r?.ok !== false, signal_id, decision_id };
  }
  // 否决：回写决策结果（可观测），signal 关闭
  async function reject({ signal_id, tenant_id = 'system', actor, decision_id, reason = null } = {}) {
    if (!decision_id) return { ok: false, error: 'decision_required' };
    const r = await signalStore.setStatus(tenant_id, signal_id, 'closed', { rejected_by: actor, reason }).catch(() => ({ ok: false }));
    if (r?.ok) {
      await writeOutcome(decision_id, {
        outcome_type: 'other', source: 'suggestion-reject',
        payload: { signal_id, rejected_by: actor, reason },
      }).catch(() => {});
    }
    return { ok: r?.ok !== false, signal_id, decision_id };
  }
  return { adopt, reject };
}
