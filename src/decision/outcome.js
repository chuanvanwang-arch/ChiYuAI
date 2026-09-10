// src/decision/outcome.js — 业务结果回写（T5/T15，L2 反馈回路）
// 幂等键：(decision_id, outcome_type, source)；落库同时回写 decision.outcome_verified。
// 业务事件 → 结果 由 outcomeIngester 按 outcome_event_map 匹配后调用 writeOutcome（T16）。
import { queryWrite, query as defaultQuery } from '../db.js';
import { computeConfidence } from './confidence.js';

export const OUTCOME_TYPES = ['won', 'lost', 'paid', 'stalled', 'partial', 'other'];

export function isValidOutcomeType(t) {
  return OUTCOME_TYPES.includes(t);
}

// 业务结果 → 置信度（供回写 decision.confidence）
export function outcomeToConfidence(outcomeType) {
  return computeConfidence({ outcomeVerified: outcomeType });
}

// 幂等 upsert 业务结果 + 回写 outcome_verified
export async function writeOutcome(decisionId, { outcome_type, source, payload = {}, confidence = null, created_by = null }, { query = defaultQuery, write = queryWrite } = {}) {
  if (!isValidOutcomeType(outcome_type)) throw new Error(`非法 outcome_type: ${outcome_type}`);
  if (!decisionId) throw new Error('writeOutcome 需要 decision_id');
  const conf = typeof confidence === 'number' ? confidence : outcomeToConfidence(outcome_type);
  const r = await write(
    `INSERT INTO crm.decision_outcome (decision_id, outcome_type, source, payload, confidence, created_by)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (decision_id, outcome_type, source)
     DO UPDATE SET payload=EXCLUDED.payload, confidence=EXCLUDED.confidence, verified_at=now()
     RETURNING *`,
    [decisionId, outcome_type, source, JSON.stringify(payload), conf, created_by]
  );
  // 回写 decision.outcome_verified（单一事实源）
  await write(`UPDATE crm.decision SET outcome_verified=$2 WHERE decision_id=$1`, [decisionId, outcome_type]);
  // P0-1（2026-09-10）：outcome 落库后发 'outcome-set' 事件，打通 ⑥ 实时校准链。
  //   背景：`autoSuggest.js:104` 订阅 decision-created / outcome-set / feedback-set，但全仓
  //   从未 emit 过这三个名字（探针 D5 实测：订阅 3 个 vs 实际 emit 17 个，交集为空）→
  //   实时校准永不触发，只能等夜间 retro 批量。补齐此处即通电。
  //   必须带 scenario_id：autoSuggest 的 trigger 依此定位场景，缺失会直接 return。
  //   事件发送失败绝不能影响结果回写（写路径优先），故整体 try/catch 隔离。
  try {
    const { emit } = await import('../events/bus.js');
    const d = await query(`SELECT scenario_id FROM crm.decision WHERE decision_id=$1 LIMIT 1`, [decisionId]);
    emit('decision', 'outcome-set', {
      decision_id: decisionId,
      scenario_id: d.rows[0]?.scenario_id || null,
      outcome_type,
      source,
    });
  } catch (e) {
    console.error('[writeOutcome] emit outcome-set failed:', e?.message);
  }
  return r.rows[0];
}

// 读：某决策的全部业务结果（按时间倒序）
export async function listOutcomes(decisionId, { query = defaultQuery } = {}) {
  if (!decisionId) return [];
  const r = await query(
    `SELECT * FROM crm.decision_outcome WHERE decision_id=$1 ORDER BY verified_at DESC`,
    [decisionId]
  );
  return r.rows;
}
