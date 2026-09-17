// src/config/configDecision.js — 配置写的「第 0 闸」铸造器（单一实现）
// 为什么抽取：config_store['integration-providers'] 有**两个写面**
//   （/api/integration/providers 通用实例 CRUD 与 /api/channels 通道专属接入），
//   若各自实现铸决策，同一键就会有两套写闸语义（本仓「同名字段解释权单一模块」红线）。
//   收敛到本文件后两处同源、同场景（'config-change'）、同降级策略。
import { requireDecision, decisionIdOf } from '../decision/autonomyEngine.js';
import { recordDecisionEvent } from '../decision/decisionRepo.js';

// 配置写一律需决策；场景不可辨识时降级为**记录事件**（不硬抛，保持既有业务写语义）
export async function produceConfigDecision(scene, ctx) {
  try {
    const r = await requireDecision(scene, ctx || {});
    const did = decisionIdOf(r);
    return { decisionId: did, ok: !!did };
  } catch {
    await recordDecisionEvent('config_change', { scenario_id: scene, trigger_context: ctx });
    return { decisionId: null, ok: true };
  }
}
