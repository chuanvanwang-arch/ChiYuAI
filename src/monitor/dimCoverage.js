// src/monitor/dimCoverage.js — DIM_PREFIX 单一来源（仅服务于 getSevenDimCoverage 旧覆盖视图）
// 注意：本模块是「场景级 eval_dimensions 条件前缀覆盖」旧语义，与 decision.attribution 物化解耦。
// attribution.required_fill 的「必填齐缺」判定必须走 sevenDimensionsCheck（ctx[dim] 空值口径），严禁用这里的前缀匹配。
export const DIM_PREFIX = {
  identity: 'identity',
  structure: 'decision_chain', // 决策链结构属 Structure（OPP_QUALIFY.decision_chain）
  semantics: 'pain', // 痛点/需求语义属 Semantics（pain_clear/pain_source 等）
  time: 'time',
  history: 'precedent', // 先例/历史（benchmark_precedent 等，若存在）
  state: 'stage', // 阶段状态（若存在）
  governance: 'governance', // 审批/红线（governance_approval / *redline / *approval）
};
export const SEVEN_DIMS = ['identity', 'structure', 'semantics', 'time', 'history', 'state', 'governance'];

export function asArray(v) {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'string') {
    try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; }
  }
  return [];
}

export function coverageOf(evalDimensions) {
  const conds = asArray(evalDimensions).map((c) => c?.cond).filter(Boolean);
  const cov = {};
  for (const [dim, prefix] of Object.entries(DIM_PREFIX)) {
    cov[dim] = conds.some((c) => c.startsWith(prefix)) ? 'provided' : 'missing';
  }
  return cov;
}
