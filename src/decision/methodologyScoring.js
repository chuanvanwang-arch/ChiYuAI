// src/decision/methodologyScoring.js — 方法论评分单一事实源（覆盖率/达标率分离）
//
// 设计依据：docs/2026-09-02-lightfield-memory-decision-study.md §11（F5 修复，Q2=②）
//
// 为什么独立成模块：同一套公式此前在 autonomyEngine.js（运行端）与 calibration/replay.js（重放端）
//   各写一遍。两处一旦漂移，重放结果与原判不符 → 决策质量校准的输入本身失真，而这种失真
//   无法从任何单侧测试看出来。故收敛为单一事实源，两端 import，parity 由测试锁死。
//
// —— F5 缺陷回顾（旧公式为何锁死自主路径）——
//   旧 methodologyScore：分母含**全部**维度，`met:null`（未采集）与 `met:false`（采集到但不达标）同罚
//   旧 allMet：`conditions.every(c => c.met)`，null 不为真 → 恒 false
//   后果：调用方从不填 trigger_context.conditions（7 个业务通道无一例外）→ met 全 null
//        → methodScore 恒 0 且 allMet 恒 false → 置信度天花板 = w.similarity + w.coverage = 0.70
//        < 阈值 0.8 → **绑了方法论的场景 100% 升级人工，反而未绑方法论的场景能满分自主**（倒挂）
//
// —— 新语义：三项正交，各答一问 ——
//   methodologyScore  「已经看到的证据里，达标比例多少」→ 分母只含 met != null
//   evidenceCoverage  「该看的证据采齐了多少」          → 权重占比，独立进置信度
//   requiredMet       「必填维度是否都有证据且达标」    → required=true 的硬闸
//
// 关键裁定（零证据不给中性分）：assessed 为空时 methodologyScore 返 **0 而非 1.0**。
//   "部分未知"与"完全无依据"是两种事：前者可按已知部分如实评分（这正是分离的意义），
//   后者没有任何可主张的达标事实，给中性满分等于白送 w.method。此立场与引擎既有的
//   「无先例（coverage=0）即 HITL」保守原则同源 —— 无依据不自主。

// 已采集维度的加权达标率。分母只含 met != null —— 未采集不再被当作不达标。
// @param conditions [{cond,label,weight,required,met,value}]
// @returns 0..1；零证据返 0（见上文裁定），场景未绑方法论（conditions 空）返 1.0（无要求即满足）
export function methodologyScore(conditions) {
  const list = Array.isArray(conditions) ? conditions : [];
  if (!list.length) return 1.0;                        // 场景未绑方法论 → 无达标要求
  const assessed = list.filter((c) => c && c.met != null);
  if (!assessed.length) return 0;                      // 零证据 → 无可主张的达标事实
  const totalW = assessed.reduce((s, c) => s + (c.weight || 1), 0);
  const earned = assessed.reduce((s, c) => s + (c.weight || 1) * (c.met ? 1 : 0), 0);
  return totalW ? earned / totalW : 0;
}

// 证据覆盖率：已采集维度权重 / 全维度权重。回答「该看的证据采齐了多少」。
// @returns 0..1；conditions 空返 1.0（未绑方法论无证据要求，不应因此扣分）
export function evidenceCoverage(conditions) {
  const list = Array.isArray(conditions) ? conditions : [];
  if (!list.length) return 1.0;
  const totalW = list.reduce((s, c) => s + (c.weight || 1), 0);
  const gotW = list.reduce((s, c) => s + (c.weight || 1) * (c && c.met != null ? 1 : 0), 0);
  return totalW ? gotW / totalW : 1.0;
}

// required 维度硬闸：required=true 的维度必须**有证据且达标**。
// 旧 allMet 语义（every(c=>c.met)）把"未采集"也算不达标，与达标率重复计罚且恒 false；
// 新语义只管必填维度，选填维度缺失不再拖垮整个判定。
// @returns boolean；无 required 维度返 true
export function requiredMet(conditions) {
  const list = Array.isArray(conditions) ? conditions : [];
  const req = list.filter((c) => c && c.required);
  if (!req.length) return true;
  return req.every((c) => c.met === true);
}

// 置信度合成（运行端与重放端共用；权重全部来自配置，零硬编码）
// @param weights {similarity,coverage,method,evidence_coverage,allMet}
export function composeConfidence(weights, { avgSimilarity, coverage, methodScore: ms, evidenceCov, allMet }) {
  const w = weights || {};
  return (w.similarity || 0) * (avgSimilarity || 0)
       + (w.coverage || 0) * (coverage || 0)
       + (w.method || 0) * (ms || 0)
       + (w.evidence_coverage || 0) * (evidenceCov || 0)
       + (w.allMet || 0) * (allMet ? 1 : 0);
}

// 三项一次算齐（调用端少写三行、少一次漂移机会）
export function scoreMethodology(conditions) {
  return {
    methodScore: methodologyScore(conditions),
    evidenceCov: evidenceCoverage(conditions),
    allMet: requiredMet(conditions),
  };
}

// —— 旧格式兼容（重放专用，勿用于新决策）——
//
// 为什么必须保留旧公式：replay.js 的立身原则是「精确复现决策当时的判定」。
//   F5 修复前落库的 conditions_evaluated **没有 required 字段**，当时跑的也是旧公式。
//   若拿新公式去重放旧决策，会把"当初为什么升级"改写成另一个答案 →
//   校准台据此算出的 override_rate / 处方全部建立在虚构的历史上。
//   所以：旧格式行用旧公式（保真），新格式行用新公式（一致）。判据是 required 字段是否存在。

// 旧格式判据：一条都不带 required 字段 → 视为 F5 修复前的历史行
// 注意用 hasOwnProperty 而非 truthy —— required:false 是合法的新格式值，不能误判为旧格式。
export function isLegacyConditions(conditions) {
  const list = Array.isArray(conditions) ? conditions : [];
  if (!list.length) return false;                      // 空数组两公式同义（都不扣分），无需分支
  return !list.some((c) => c && Object.prototype.hasOwnProperty.call(c, 'required'));
}

// F5 修复前的原始公式（autonomyEngine.js 旧 :48-53 / :84 逐字等价）
export function scoreMethodologyLegacy(conditions) {
  const list = Array.isArray(conditions) ? conditions : [];
  const totalW = list.reduce((s, c) => s + (c.weight || 1), 0);
  const earned = list.reduce((s, c) => s + (c.weight || 1) * (c.met ? 1 : 0), 0);
  return {
    methodScore: totalW ? earned / totalW : 1.0,
    // 旧公式无 evidence_coverage 项；给 0 会凭空扣分、给 1 会凭空加分 —— 两者都篡改历史。
    // 正解：让调用端在 legacy 分支不施加该权重（composeConfidence 的 evidence_coverage 传 null，
    // 且 replay 侧把 w.evidence_coverage 归零），故此处返回 null 作为「该项不适用」的显式信号。
    evidenceCov: null,
    allMet: list.length ? list.every((c) => c.met) : true,
  };
}
