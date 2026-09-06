// src/sales/reopenDeal.js — 反向重开（S7/S8→S2），保留原粒子身份，不新建粒子
// 设计：docs/specs/2026-09-03-deal-reopen-stop-loss-mirror-design.md Task 1
// 不动 advanceStage 只进不退契约（lifecycle.js:14）；决策由调用方(handler)先 mint，decision_id 传入
import { getParticle, updateParticle } from '../particles/particleRepo.js';
import { emit } from '../events/bus.js';

export const REOPENABLE_STAGES = new Set(['S7', 'S8']); // 输单 / 丢单

// decision_id 已由 action handler 经第 0 闸 mint（DEAL_REOPEN），此处只做粒子写
export async function reopenDeal(dealId, { reason, owner, decision_id } = {}) {
  const deal = await getParticle(dealId);
  if (!deal) throw new Error(`DEAL 不存在: ${dealId}`);
  const cur = deal.payload.stage;
  if (!REOPENABLE_STAGES.has(cur)) {
    throw new Error(`仅退出态(S7/S8)可重开，当前=${cur}`);
  }
  if (!decision_id) throw new Error('reopenDeal 需携带决策锚定 decision_id');
  const patch = {
    stage: 'S2',
    reopen_count: (deal.payload.reopen_count || 0) + 1,
    reopened_at: new Date().toISOString(),
    last_reopen_reason: reason || null,
    last_reopen_decision_id: decision_id,
    transitionedBecause: reason || `reopen from ${cur}`,
  };
  const updated = await updateParticle(dealId, { patch });
  emit('decision', 'deal-reopen', { deal_id: dealId, from: cur, to: 'S2', decision_id, owner });
  return { ...updated, decision_id };
}
