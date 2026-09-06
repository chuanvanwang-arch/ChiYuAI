// B7 极简自检卡：读模型（设计 §10 / 归档 selfcheck §6）
// 输入一个 decision 行（八要素 JSONB 列 + conditions_evaluated + rubric），
// 输出 7 问 × pass/warn/fail + 证据指针。不新增任何列，不写库。
// 健壮性铁律：(x.y || []).map 是假防御 → 所有 JSONB 列经 asObj/asArr 安全解析。

function asObj(v) {
  if (v == null) return {};
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return {}; } }
  return v;
}
function asArr(v) {
  if (v == null) return [];
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return []; } }
  if (!Array.isArray(v)) return [];
  return v;
}

/**
 * 决策自检卡（极简 7 问）。
 * @param {object} decision decision 行（含 intent/conditions_evaluated/assumptions/inference/viewpoints/implications/risk_register/stop_loss/rubric）
 * @returns {{decision_id:string|null, questions:Array, summary:object}}
 */
export function buildSelfCheck(decision = {}) {
  const intent = asObj(decision.intent);
  const conditions = asArr(decision.conditions_evaluated); // 信息维度事实列表（数组）
  const assumptions = asArr(decision.assumptions);
  const inference = asObj(decision.inference);
  const chain = asArr(inference.chain);
  const viewpoints = asArr(decision.viewpoints);
  const implications = asArr(decision.implications);
  const riskRegister = asArr(decision.risk_register);
  const stopLoss = asObj(decision.stop_loss);
  const rubric = asObj(decision.rubric);

  const questions = [];

  // Q1 真实目标
  const q1pass = !!(intent.purpose && intent.question);
  questions.push({
    no: 1,
    ask: '我真实目标是什么？核心要解决什么问题？',
    status: q1pass ? 'pass' : 'warn',
    element_ref: 'intent',
    dim_ref: null,
    evidence: q1pass ? `purpose="${intent.purpose}"; question="${intent.question}"` : 'intent.purpose 或 intent.question 为空',
  });

  // Q2 信息来源可靠完整（事实 + 假设台账）
  const assumBasisOk = assumptions.length > 0 && assumptions.every((a) => a && a.basis);
  const hasInput = conditions.length > 0 || assumptions.length > 0;
  const q2pass = conditions.length > 0 && assumBasisOk;
  const q2status = !hasInput ? 'fail' : q2pass ? 'pass' : 'warn';
  questions.push({
    no: 2,
    ask: '信息来源可靠完整吗？哪些是事实，哪些是假设？',
    status: q2status,
    element_ref: 'conditions_evaluated/assumptions',
    dim_ref: null,
    evidence: `facts=${conditions.length}; assumptions=${assumptions.length}${assumptions.length ? `, 标注basis=${assumptions.filter((a) => a && a.basis).length}` : ''}`,
  });

  // Q3 推论证据足够
  const chainOk = chain.length > 0 && chain.every((c) => c && c.conclusion && c.evidence && c.via_assumption);
  const q3status = chain.length === 0 ? 'fail' : chainOk ? 'pass' : 'warn';
  questions.push({
    no: 3,
    ask: '我的推论是否证据足够？有没有脑补？',
    status: q3status,
    element_ref: 'inference',
    dim_ref: null,
    evidence: `chain=${chain.length}${chain.length ? `, 证据完整=${chain.filter((c) => c && c.evidence && c.via_assumption).length}` : ''}`,
  });

  // Q4 视角覆盖（≥3 且含反方）
  const hasCounter = viewpoints.some((v) => v && /反|oppose|counter|对立|risk|negativ/i.test(String(v.stance || '')));
  const q4pass = viewpoints.length >= 3 && hasCounter;
  const q4status = viewpoints.length === 0 ? 'fail' : q4pass ? 'pass' : 'warn';
  questions.push({
    no: 4,
    ask: '我看到了哪些视角？漏掉了谁？',
    status: q4status,
    element_ref: 'viewpoints',
    dim_ref: null,
    evidence: `viewpoints=${viewpoints.length}, 反方=${hasCounter ? '是' : '否'}`,
  });

  // Q5 连锁后果（含 negative + mitigation）
  const negWithMit = implications.filter((i) => i && (i.type === 'negative' || i.type === '风险') && i.mitigation);
  const q5status = implications.length === 0 ? 'fail' : negWithMit.length > 0 ? 'pass' : 'warn';
  questions.push({
    no: 5,
    ask: '这么做会带来什么连锁后果风险？',
    status: q5status,
    element_ref: 'implications',
    dim_ref: null,
    evidence: `implications=${implications.length}, negative+mitigation=${negWithMit.length}`,
  });

  // Q6 九尺子加权总分
  const weightedTotal = typeof rubric.weighted_total === 'number' ? rubric.weighted_total : null;
  const passLine = typeof rubric.pass_line === 'number' ? rubric.pass_line : 0.5;
  let q6status = 'fail';
  if (weightedTotal != null) q6status = weightedTotal >= passLine ? 'pass' : 'warn';
  questions.push({
    no: 6,
    ask: '9 把尺子快扫',
    status: q6status,
    element_ref: 'rubric',
    dim_ref: null,
    evidence: weightedTotal != null ? `weighted_total=${weightedTotal.toFixed(2)} (pass_line=${passLine})` : 'rubric 未生成（决策落库时自动评分，若缺失请查评分器）',
  });

  // Q7 风险与止损点
  const slArmed = stopLoss.status === 'armed' && !!stopLoss.deadline;
  const hasRisk = riskRegister.length > 0 || stopLoss.status;
  const q7pass = riskRegister.length > 0 && slArmed;
  const q7status = !hasRisk ? 'fail' : q7pass ? 'pass' : 'warn';
  questions.push({
    no: 7,
    ask: '风险是什么？止损点在哪里？',
    status: q7status,
    element_ref: 'risk_register/stop_loss',
    dim_ref: null,
    evidence: `risk_register=${riskRegister.length}, stop_loss.status=${stopLoss.status || '—'}${stopLoss.deadline ? `, deadline=${stopLoss.deadline}` : ''}`,
  });

  const passCount = questions.filter((q) => q.status === 'pass').length;
  const warnCount = questions.filter((q) => q.status === 'warn').length;
  const failCount = questions.filter((q) => q.status === 'fail').length;
  const overall = failCount > 0 ? 'warn' : passCount === 7 ? 'pass' : 'warn';

  return {
    decision_id: decision.decision_id || null,
    questions,
    summary: { pass: passCount, warn: warnCount, fail: failCount, overall },
  };
}
