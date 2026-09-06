// src/particles/lifecycle.js — DEAL 阶段状态机：只进不退 + why 载体必填
// 实证（§5ter.3）：商机阶段只能向前推进；输单/关键阶段需 why 载体
import { PARTICLE_TYPES } from './particleModel.js';
import { getParticle, createParticle, updateParticle, createEdge } from './particleRepo.js';

export async function advanceStage(particleId, toStage, { transitionedBecause, owner } = {}) {
  const p = await getParticle(particleId);
  if (!p) throw new Error(`粒子不存在: ${particleId}`);
  const flow = PARTICLE_TYPES[p.type].states.flow;
  const cur = p.payload.stage || p.payload.state;
  const curIdx = flow.indexOf(cur);
  const toIdx = flow.indexOf(toStage);
  if (toIdx < 0) throw new Error(`未知阶段: ${toStage}（合法阶段: ${flow.join('→')}）`);
  if (toIdx < curIdx) throw new Error(`阶段只进不退: ${cur} → ${toStage}`);

  const patch = { stage: toStage, stage_changed_at: new Date().toISOString() };
  const why = PARTICLE_TYPES[p.type].why;
  if (why && toStage === 'S7' && !transitionedBecause && !p.payload.closed_reason) {
    throw new Error(`输单必填原因（closed_reason 或 transitionedBecause）`);
  }
  if (transitionedBecause) {
    patch[why] = transitionedBecause;
    patch.transitionedBecause = transitionedBecause;  // why 载体落 payload
  }
  if (['S2','S3','S4','S5','S6'].includes(toStage)) {
    patch.actual_close_date = toStage === 'S6' ? new Date().toISOString() : p.payload.actual_close_date;
  }

  // Task 3（2026-08-27 state/stage 解耦）：推进只改 payload.stage，state 列保持生命周期（ACTIVE）
  // 历史遗留：把 toStage 写进 state 列与生命周期混用 → 修复后 state 恒定 ACTIVE（业务阶段在 payload.stage）
  const updated = await updateParticle(particleId, { state: undefined, patch });
  // 受控边 transitionedBecause：DEAL → KNOWLEDGE（决策理由载体），edge_source=human
  if (transitionedBecause) {
    const know = await createParticle('CRM_KNOWLEDGE', { term: `transition-${particleId.slice(0,8)}`, content: transitionedBecause }).catch(() => null);
    if (know) {
      await createEdge(p.type, particleId, 'transitionedBecause', 'CRM_KNOWLEDGE', know.id,
        { edge_source: 'human', ai_reasoning_trace: owner || null, reason: transitionedBecause });
    }
  }
  return updated;
}
