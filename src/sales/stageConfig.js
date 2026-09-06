// src/sales/stageConfig.js — DEAL 阶段-赢率配置（B5：opportunity_stage_config 实证）
// 实证（§5bis B5）：每个阶段可配赢率（预测量）+ 可配是否允许回退（防作弊/误操作）
//   "商机只能向前推进（除非管理员）"（business-rules 实证 → crm-deal-rollback 特权 Action）
// 设计输入：综合详设 §3 B5 粒子 Schema（stage_config: [{stage, win_rate, allow_back}]）
// 纯逻辑（无 PG 依赖，本地可单测）；写时由种子/配置提供 stage_config，此处给默认表 + 判定函数

// 阶段 → 赢率默认表（B5 实证 10%→100%：S1 10 / S2 40 / S3 60 / S4 85 / S5 95 / S6 100 / S7 0）
export const DEFAULT_STAGE_CONFIG = [
  { stage: 'S1', win_rate: 0.10, allow_back: false },
  { stage: 'S2', win_rate: 0.40, allow_back: false },
  { stage: 'S3', win_rate: 0.60, allow_back: false },
  { stage: 'S4', win_rate: 0.85, allow_back: false },
  { stage: 'S5', win_rate: 0.95, allow_back: false },
  { stage: 'S6', win_rate: 1.00, allow_back: false },
  { stage: 'S7', win_rate: 0.00, allow_back: false },
  { stage: 'S8', win_rate: 0.00, allow_back: false },
];

// 读取某阶段赢率（可传入 payload.stage_config 覆盖默认表；未命中 → null）
export function winRate(stage, stageConfig = DEFAULT_STAGE_CONFIG) {
  const row = (stageConfig || DEFAULT_STAGE_CONFIG).find(s => s.stage === stage);
  return row ? row.win_rate : null;
}

// 回退判定：allow_back 显式允许 或 特权（admin 由 Action RBAC 拦截，此处仅看配置）
// 未在配置中 → 默认不允许回退（保守）
export function canRollback(stage, stageConfig = DEFAULT_STAGE_CONFIG) {
  const row = (stageConfig || DEFAULT_STAGE_CONFIG).find(s => s.stage === stage);
  return row ? !!row.allow_back : false;
}

// 回退合法性（privileged 语义）：回退目标必须是当前阶段的合法前阶段（flow 内）
// 返回 { ok, reason }
export function checkRollback(currentStage, toStage, { stageConfig, allowBack } = {}) {
  const flow = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8'];
  const curIdx = flow.indexOf(currentStage);
  const toIdx = flow.indexOf(toStage);
  if (curIdx < 0 || toIdx < 0) return { ok: false, reason: `未知阶段: ${currentStage}→${toStage}` };
  // 回退 = 目标阶段序号必须小于当前（向前推进已有 crm-deal-advance 负责）
  if (toIdx >= curIdx) return { ok: false, reason: `目标阶段 ${toStage} 非 ${currentStage} 的前阶段（回退语义=序号更小）` };
  // 配置闸：allow_back 显式允许 或 调用方显式 allowBack（特权绕行由 RBAC admin 单独把关）
  if (!allowBack && !canRollback(currentStage, stageConfig)) {
    return { ok: false, reason: `阶段 ${currentStage} 配置不允许回退（allow_back=false）` };
  }
  return { ok: true };
}