// src/decision/disposition.js — 人工处置回写（HITL 闭环唯一出口）
// 设计依据：docs/2026-08-28-decision-quality-calibration-design.md §2.1 / §3
// 背景（代码级核实）：confirmDecision / reverseDecision（decisionRepo.js:195/:214）全仓 0 调用方，
//   导致 state='CONFIRMED'/'REVERSED' 恒不产生、reversal_rate 恒为 0。本模块是被调量的采集点。
// 铁律：
//  - 绝不覆写 decider_type/decider_id/decider_role —— 这三个字段记录「引擎当初把决策判给谁」，
//    是决策来源的溯源凭据（P1 的 autonomy_override_rate 靠 decider_type 筛自主样本）。
//    人工信息一律只写 human_* 四列，与原字段严格分离。
//  - 处置动作不新建 decision（避免决策自引用）；审计复用被处置决策自身的 id（audit_event.decision_id 列本就为此设计）。
import { query, queryWrite } from '../db.js';
import { emit } from '../events/bus.js';
import { recordDecisionEvent, writebackHumanDisposition } from './decisionRepo.js';
import { recordAudit } from '../action/auditHook.js';
import { addDecision, isAvailable } from './ageGraph.js';

// 可被人工处置的状态集合（已终结的 CONFIRMED / REVERSED 不可再处置）
export const DISPOSABLE_STATES = new Set(['REQUIRED', 'HUMAN', 'AUTONOMOUS']);

// 记录人工最终处置。返回 { ok, decision, overridden, next_state } 或 { ok:false, status, error }
export async function recordHumanDisposition(decision_id, { disposition, by_id = null, by_role = null, note = '' } = {}) {
  if (!decision_id) throw new Error('recordHumanDisposition: 缺少 decision_id');
  if (!disposition || typeof disposition !== 'string') throw new Error('recordHumanDisposition: 缺少 disposition');

  const cur = (await query(
    `SELECT decision_id, scenario_id, disposition AS suggested_disposition, state
       FROM crm.decision WHERE decision_id=$1`, [decision_id])).rows[0];
  if (!cur) return { ok: false, status: 404, error: '决策不存在' };
  if (!DISPOSABLE_STATES.has(cur.state)) {
    return { ok: false, status: 409, error: `决策状态 ${cur.state} 不可处置` };
  }

  const overridden = cur.suggested_disposition !== disposition;
  const nextState = overridden ? 'REVERSED' : 'CONFIRMED';

  const r = await queryWrite(
    `UPDATE crm.decision
        SET human_disposition = $2,
            human_decided_at  = now(),
            human_decider_id  = $3,
            human_decider_role= $4,
            state             = $5,
            outcome           = CASE WHEN $5 = 'REVERSED' THEN 'REVERSED' ELSE outcome END,
            updated_at        = now()
      WHERE decision_id = $1
      RETURNING *`,
    [decision_id, disposition, by_id, by_role, nextState]
  );
  const d = r.rows[0];

  // 【稽核台】滞后回写 attribution（必填齐+被推翻 → inference_bias；准否信号同步）
  // 失败仅 trace，不阻断 HITL 主链路（与决策物化纪律一致）
  await writebackHumanDisposition(decision_id, disposition).catch((err) => {
    emit('trace', 'attribution-writeback-failed', { decision_id, error: String(err?.message || err) });
  });

  // 审计留痕：复用被处置决策自身的 id（不新建 decision，避免自引用）
  await recordAudit({
    target_particle_type: 'decision',
    source: 'approval',
    action: 'human-disposition',
    actor: by_id || 'system',
    decision_id,
    payload: {
      scenario_id: cur.scenario_id,
      from_disposition: cur.suggested_disposition,
      to_disposition: disposition,
      overridden,
      note,
    },
  }).catch(() => {});

  await recordDecisionEvent('human-disposition', {
    decision_id, scenario_id: cur.scenario_id, disposition, overridden, by_id, by_role,
  }).catch(() => {});

  if (isAvailable()) {
    try {
      await addDecision(d);
    } catch (e) {
      emit('trace', 'decision-graph-sync-failed', { decision_id, error: String(e?.message || e) });
    }
  }

  emit('decision', overridden ? 'overridden' : 'confirmed', { decision_id, disposition, by_role });
  return { ok: true, decision: d, overridden, next_state: nextState };
}