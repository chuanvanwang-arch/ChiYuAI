// src/calibration/replay.js — 影子重放（Shadow Replay）：用历史决策存量数据精确重算置信度与自主/升级判定
// 设计依据：docs/2026-08-28-decision-quality-calibration-design.md §6
// 核心原则：
//   ① 公式与运行端 autonomyEngine.js 逐字一致 —— F5 修复后不再各写一遍，
//      两端共用单一事实源 src/decision/methodologyScoring.js（此前重写一遍，改一端漏一端 = 校准失真）
//   ② avgSimilarity/coverage 从决策行已落库的 referenced_precedents[].similarity 复算，
//      不重跑检索 —— 先例库随时间演化，重跑会漂移；落库值是"决策当时"的快照，可精确复现（设计 §6 已知约束）
//   ③ 纯确定性计算，零 LLM 成本
//   ④ 置信度校验（误差 < 1e-6）在 test/calibration/replay.test.js 锁死，是重放可信度守卫
import {
  isLegacyConditions,
  scoreMethodology,
  scoreMethodologyLegacy,
  composeConfidence,
} from '../decision/methodologyScoring.js';

export function replayConfidence(decision, cfg) {
  const w = cfg.weights || {};
  // JSONB 列防假防御铁律：truthy 非数组（对象）必须 Array.isArray 判定，不能 || []
  const conditions = Array.isArray(decision.conditions_evaluated) ? decision.conditions_evaluated : [];
  const precs = Array.isArray(decision.referenced_precedents) ? decision.referenced_precedents : [];
  const k = 5; // 技术债：运行端 k 未落库，重放端取常量（与 constants.js REPLAY_K 对齐）

  // 方法论三项 —— 公式来自单一事实源 methodologyScoring.js（此前在此处重写一遍，两端易漂移）
  // 格式分支（F5 修复 2026-09-02）：修复前落库的行无 required 字段、当时跑的也是旧公式，
  //   必须用旧公式重放才叫"精确复现"（见 methodologyScoring.js 中的理由）。
  const legacy = isLegacyConditions(conditions);
  const { methodScore, evidenceCov, allMet } = legacy
    ? scoreMethodologyLegacy(conditions)
    : scoreMethodology(conditions);

  // autonomyEngine.js 同公式；coverage 用 REPLAY_K（运行端 opts.k || 5）
  const avgSimilarity = precs.length
    ? precs.reduce((s, p) => s + (Number(p.similarity) || 0), 0) / precs.length : 0;
  const coverage = Math.min(precs.length / k, 1);

  // legacy 行：evidence_coverage 权重归零（该项在决策当时不存在，施加它等于篡改历史）。
  //   归零后旧行的置信度与修复前逐字一致 —— 这正是 replay.test.js 的存量断言所锁死的。
  const wEff = legacy ? { ...w, evidence_coverage: 0 } : w;
  const confRaw = composeConfidence(wEff, { avgSimilarity, coverage, methodScore, evidenceCov, allMet });

  // relBoost —— autonomyEngine.js:79-83 同公式（强关系 champion/high / relationship high/strong 各 +0.3）
  const rel = (decision.trigger_context && decision.trigger_context.relations) || {};
  const relBoost = (['high', 'champion'].includes(rel.champion_strength) ? 0.3 : 0)
    + (['high', 'strong'].includes(rel.relationship_strength) ? 0.3 : 0);

  // autonomyEngine.js:85-88 同公式（cap 0.95）
  return Math.min(confRaw + relBoost, 0.95);
}

// 判定升级/自主 —— 镜像 autonomyEngine.js:97 的 escalated 布尔
// EXCEPTION 强制升级有落库痕迹：outcome='AUDIT_HIGHLIGHT'（autonomyEngine.js:132），与配置无关恒升级
export function wouldEscalate(decision, cfg, tier = decision.business_tier || 'NORMAL') {
  if (decision.outcome === 'AUDIT_HIGHLIGHT') return true;
  const rel = (decision.trigger_context?.relations) || {};
  const relBoost = (['high', 'champion'].includes(rel.champion_strength) ? 0.3 : 0)
    + (['high', 'strong'].includes(rel.relationship_strength) ? 0.3 : 0);
  const relThresholdRelax = relBoost > 0 ? 0.1 : 0;
  const effectiveThreshold = Math.max((cfg.threshold ?? 0.8) - relThresholdRelax, 0.5); // floor 0.5 与引擎 :84 对齐
  const conf = replayConfidence(decision, cfg);
  return tier === 'HIGH' || (tier !== 'HIGH' && conf < effectiveThreshold);
}

// 场景级重放：给定候选配置，重放全部历史决策 → 预测自主/升级分布变化
// estimated_override_rate 为一阶近似：重放后自主样本按当前 autonomy_override_rate 加权、
// 升级样本按当前升级件覆写率加权（设计 §6 接口说明；UI 必须标注"估算，非承诺"）
export function replayScenario(decisions, cfg) {
  const list = Array.isArray(decisions) ? decisions : [];
  const n = list.length;
  if (!n) return { autonomy: 0, escalated: 0, delta: 0, estimated_override_rate: 0, base_autonomy: 0 };

  const baseAutonomy = list.filter((d) => d.decider_type === 'AUTONOMOUS_AGENT').length;
  const isOverridden = (d) => Boolean(d.human_disposition) && d.human_disposition !== d.disposition;
  const autonomous = list.filter((d) => d.decider_type === 'AUTONOMOUS_AGENT');
  const escalatedList = list.filter((d) => d.decider_type === 'HUMAN');
  const autonomyOverrideRate = autonomous.length ? autonomous.filter(isOverridden).length / autonomous.length : 0;
  const escalatedOverrideRate = escalatedList.length ? escalatedList.filter(isOverridden).length / escalatedList.length : 0;
  // 样本不足时保守估计（R6 精神：小样本上不宣称改善）
  const minSample = 20;
  const sufficient = n >= minSample;

  let autonomy = 0;
  for (const d of list) {
    if (!wouldEscalate(d, cfg)) autonomy += 1;
  }
  const estimatedOverrideRate = sufficient
    ? (autonomy * autonomyOverrideRate + (n - autonomy) * escalatedOverrideRate) / n
    : null;

  return {
    autonomy,
    escalated: n - autonomy,
    delta: autonomy - baseAutonomy,
    estimated_override_rate: estimatedOverrideRate,
    base_autonomy: baseAutonomy,
    sufficient_sample: sufficient,
  };
}