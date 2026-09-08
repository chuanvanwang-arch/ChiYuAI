// src/decision/adviceCard.js — 决策建议卡装配（条件体检 + A/B/C 三档）
// 设计：docs/2026-09-08-dialog-driven-decision-advice-design.md §3
// 铁律：纯函数、不碰 DB、不调用 LLM；红线判定由 scenarioAdvisors 传入（业务知识不在此层硬编码）
export function evaluateConditions(eval_dimensions = [], facts = {}) {
  const list = Array.isArray(eval_dimensions) ? eval_dimensions : [];
  const satisfied = [];
  const missing = [];
  let sw = 0;
  let tw = 0;
  for (const d of list) {
    const w = Number(d?.weight) || 0;
    tw += w;
    const v = facts?.[d?.cond];
    if (v !== undefined && v !== null && v !== '') { satisfied.push({ ...d, value: v }); sw += w; }
    else missing.push({ ...d });
  }
  return {
    satisfied, missing,
    requiredMissing: missing.filter((m) => m.required === true),
    coverage: tw > 0 ? sw / tw : 0,
  };
}

export function buildAdviceCard({ scenario = {}, coordinate = {}, facts = {}, redlines = [], precedents = [] } = {}) {
  const dims = Array.isArray(scenario.eval_dimensions) ? scenario.eval_dimensions : [];
  const ev = evaluateConditions(dims, facts);
  const passLine = Number(scenario.rubric_pass_line) || 0.6;
  const confidence = coordinate.confidence || 'low';
  const stage = coordinate.stage || null;

  let tier;
  let disposition = null;
  if (confidence !== 'high' || ev.requiredMissing.length > 0) tier = 'C';
  else if (Array.isArray(redlines) && redlines.length > 0) { tier = 'B'; disposition = 'ESCALATE'; }
  else { tier = 'A'; disposition = ev.coverage >= passLine ? 'APPROVE' : 'ESCALATE'; }

  const gaps = [...ev.requiredMissing, ...ev.missing.filter((m) => m.required !== true)]
    .sort((a, b) => (Number(b.weight) || 0) - (Number(a.weight) || 0))
    .map((m) => ({ cond: m.cond, label: m.label, weight: Number(m.weight) || 0 }));

  return {
    tier,
    disposition,
    scenario_id: coordinate.scenario_id || scenario.scenario_id || null,
    stage,
    headline: `${scenario.stage || coordinate.scenario_id || '未定位'}${stage ? ` · ${stage}` : ''}｜建议档位 ${tier}`,
    reasons: ev.satisfied.map((s) => ({ cond: s.cond, label: s.label, value: s.value })),
    gaps,
    redlines: Array.isArray(redlines) ? redlines : [],
    approval_flow: tier === 'B' ? 'CRM_APPROVAL_FLOW' : null,
    precedents: Array.isArray(precedents) ? precedents : [],
    coverage: Number(ev.coverage.toFixed(4)),
    confidence,
  };
}
