// src/decision/feedback.js — T26 结构化业务反馈回写（决策结果反证，金律18 滞后业务信号）
// feedback 字段（设计 full-traceability-root-cause-design.md §2.1）：
//   usable          bool   决策结果可用/不可用（业务能否直接采用）
//   major_deviation bool   是否重大偏差（造成业务损失/客户投诉/合规风险）
//   actual_outcome  enum   won/lost/partial/paid/none
//   deviation_note  text   偏差描述（供 A9/NLP 抽取）
//   reporter_role   text   谁反馈（销售/售前/经理），用于权重
// 与 decision_outcome.outcome_verified（业务结果）互补：feedback 是「业务主观可用性判」，outcome 是「系统客观结果」。

import { query as defaultQuery } from '../db.js';

// 纯函数：由结构化反馈推导 accuracy_signal（人工即时判之外的滞后业务判）
// 设计 §2.2：usable=false ∪ major_deviation=true → inaccurate（触发强制归因）；usable=true → accurate
export function deriveAccuracySignal(feedback = {}) {
  const usable = feedback.usable;
  const major = feedback.major_deviation === true;
  if (usable === false && major) return 'inaccurate';
  if (usable === true) return 'accurate';
  return 'pending'; // 信息不足：不强行判，保留既有（或 pending）
}

// DB 版：回写 decision.feedback + 同步 attribution.accuracy_signal（不覆盖既有 accurate/inaccurate，避免回退）
export async function setDecisionFeedback(decisionId, feedback = {}, { query: q = defaultQuery } = {}) {
  if (!decisionId) throw new Error('decision_id required');
  const dRes = await q(`SELECT decision_id, attribution FROM crm.decision WHERE decision_id=$1`, [decisionId]);
  const d = dRes.rows[0];
  if (!d) throw new Error(`decision 不存在: ${decisionId}`);

  const signal = deriveAccuracySignal(feedback);
  const attribution = d.attribution || {};
  const prev = attribution.accuracy_signal;
  // 仅在本次有明确信号时覆盖；pending 不回退既有 accurate/inaccurate
  const accuracy_signal = signal === 'pending' ? (prev || 'pending') : signal;

  const newAttribution = { ...attribution, feedback, accuracy_signal };
  await q(
    `UPDATE crm.decision SET feedback=$1::jsonb, attribution=$2::jsonb, updated_at=now() WHERE decision_id=$3`,
    [JSON.stringify(feedback), JSON.stringify(newAttribution), decisionId]
  );
  return { ok: true, decision_id: decisionId, accuracy_signal, feedback };
}
