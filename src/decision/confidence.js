// src/decision/confidence.js — 决策置信度反算（T8，纯函数，G5）
// 单一事实源：confidence 由 outcome_verified（滞后业务反证，金律18 双信号之一）+ human_disposition（即时人工判）反算。
// 业务结果信号优先于人工即时判（业务结果更滞后但更客观）。
export function computeConfidence({ outcomeVerified = null, humanDisposition = null, engineConfidence = null } = {}) {
  if (outcomeVerified === 'won' || outcomeVerified === 'paid') return 0.9;
  if (outcomeVerified === 'lost' || outcomeVerified === 'partial') return 0.3;
  if (outcomeVerified === 'stalled') return 0.5;

  if (humanDisposition === 'OVERRIDDEN' || humanDisposition === 'CORRECTED') return 0.2;
  if (humanDisposition === 'CONFIRMED' || humanDisposition === 'APPROVED') return 0.85;

  // 无信号：回退引擎置信度或中性 0.6（不脑补）
  return typeof engineConfidence === 'number' ? Math.max(0, Math.min(1, engineConfidence)) : 0.6;
}
