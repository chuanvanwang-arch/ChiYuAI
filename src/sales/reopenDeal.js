// src/sales/reopenDeal.js — 反向重开（S7/S8 或 S0+lost → S0P），保留原粒子身份，不新建粒子
// 设计：docs/2026-09-11-lead-public-pool-tenant-design.md（场景③：战败归档 → 再激活）
//   2026-09-11 改：重开目标由 S2 改为 S0P —— 重开是「重新获取线索」，须重走 BANT 校验，
//   不得直接落 S2（原实现让战败商机免校验复活，绕过 BANT 闸）。
// 不动 advanceStage 只进不退契约（lifecycle.js:17）；决策由调用方(handler)先 mint，decision_id 传入
import { getParticle, updateParticle } from '../particles/particleRepo.js';
import { emit } from '../events/bus.js';
import { toStageCode } from './stageTaxonomy.js';

export const REOPENABLE_STAGES = new Set(['S7', 'S8']); // 输单 / 丢单
export const REOPEN_TARGET_STAGE = 'S0P';               // 重开后回私海待校验，重走 BANT

// decision_id 已由 action handler 经第 0 闸 mint（DEAL_REOPEN），此处只做粒子写
export async function reopenDeal(dealId, { reason, owner, decision_id, tenantId = null } = {}) {
  const deal = await getParticle(dealId);
  if (!deal) throw new Error(`DEAL 不存在: ${dealId}`);
  const cur = deal.payload.stage;
  const code = toStageCode(cur);
  // 战败公海（S0 + pool_type=lost）同样可激活；普通公海（S0 + new/nurture）不可
  const fromLostPool = code === 'S0' && deal.payload.pool_type === 'lost';
  if (!REOPENABLE_STAGES.has(code) && !fromLostPool) {
    throw new Error(`仅退出态(S7/S8)或战败公海(S0+lost)可重开，当前=${cur}`);
  }
  if (!decision_id) throw new Error('reopenDeal 需携带决策锚定 decision_id');
  const patch = {
    stage: REOPEN_TARGET_STAGE,
    reopen_count: (deal.payload.reopen_count || 0) + 1,
    reopened_at: new Date().toISOString(),
    last_reopen_reason: reason || null,
    last_reopen_decision_id: decision_id,
    transitionedBecause: reason || `reopen from ${cur}`,
    // 出池：恢复战败前的池归属（归档时留痕），无痕则回默认池
    pool_id: deal.payload.prev_pool_id || deal.payload.pool_id,
    pool_type: deal.payload.prev_pool_type || 'new',
    last_terminal_stage: code === 'S0' ? (deal.payload.last_terminal_stage || null) : code,
  };
  const updated = await updateParticle(dealId, { patch, tenantId });
  emit('decision', 'deal-reopen', { deal_id: dealId, from: cur, to: REOPEN_TARGET_STAGE, decision_id, owner });
  return { ...updated, decision_id };
}
