// B5 故事三构件（设计 §3.1 M 记忆系统）：characters / dynamics / trajectory
// 把决策八要素 + 时间线从"流水账"升级为"证据链"。每条输出带 element_ref（八要素字段）
// 与 dim_ref（7 轴事实域维度，可选）。纯函数、无 DB 依赖、fail-open（缺字段不报错）。
// 依赖 A3（故事源：events/memory_log.entity_id）——当真实流量（P0-②）到位后 trajectory 才有时间线；
// 当前基于决策八要素即可产出 characters/dynamics，trajectory 退化为"决策节点 + 止损/结果"。

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
 * 生成决策故事三构件。
 * @param {object} decision decision 行（八要素 JSONB 列 + 基础字段）
 * @param {object} [opts] { timeline?: Array, decider?: object }
 *   timeline：外部传入的时间线事件（events/ provenance），每条 {type, at, text}
 * @returns {{characters:Array, dynamics:Array, trajectory:Array}}
 */
export function buildStory(decision = {}, opts = {}) {
  const decision_id = decision.decision_id || null;
  const intent = asObj(decision.intent);
  const assumptions = asArr(decision.assumptions);
  const inference = asObj(decision.inference);
  const chain = asArr(inference.chain);
  const viewpoints = asArr(decision.viewpoints);
  const implications = asArr(decision.implications);
  const riskRegister = asArr(decision.risk_register);
  const stopLoss = asObj(decision.stop_loss);

  const characters = [];
  // 决策主体
  if (decision.decider_id || decision.decider_role) {
    characters.push({
      role: 'decider',
      name: decision.decider_id || (decision.decider_type || 'unknown'),
      meta: { type: decision.decider_type, role: decision.decider_role },
      element_ref: null,
      dim_ref: null,
    });
  }
  // 涉及方（involved_entities）
  asArr(decision.involved_entities).forEach((e) => {
    characters.push({ role: 'entity', name: (e && (e.name || e.id || e.type)) || String(e), meta: e, element_ref: 'involved_entities', dim_ref: null });
  });
  // 视角持有方（viewpoints.holder）
  viewpoints.forEach((v) => {
    if (v && v.holder) {
      characters.push({ role: 'viewpoint-holder', name: String(v.holder), meta: { stance: v.stance }, element_ref: 'viewpoints', dim_ref: null });
    }
  });

  const dynamics = [];
  // 信息/假设前提
  if (assumptions.length) {
    dynamics.push({ kind: 'assumption', text: `${assumptions.length} 条假设前置`, detail: assumptions.map((a) => a.text), element_ref: 'assumptions', dim_ref: null });
  }
  // 推论链
  chain.forEach((c, i) => {
    dynamics.push({
      kind: 'inference',
      text: c.conclusion || (c.evidence ? `由"${c.evidence}"推出` : '推论'),
      detail: { evidence: c.evidence, via_assumption: c.via_assumption },
      element_ref: 'inference',
      dim_ref: null,
      index: i,
    });
  });
  if (inference.conclusion) {
    dynamics.push({ kind: 'conclusion', text: inference.conclusion, element_ref: 'inference', dim_ref: null });
  }
  // 后果
  implications.forEach((im, i) => {
    dynamics.push({ kind: `implication:${im.type || 'neutral'}`, text: im.text, detail: { probability: im.probability, mitigation: im.mitigation }, element_ref: 'implications', dim_ref: null, index: i });
  });
  // 风险
  riskRegister.forEach((rk, i) => {
    dynamics.push({ kind: 'risk', text: rk.risk, detail: { severity: rk.severity, mitigation: rk.mitigation }, element_ref: 'risk_register', dim_ref: null, index: i });
  });

  const trajectory = [];
  // 决策节点（必有）
  trajectory.push({ at: decision.decided_at || decision.created_at || null, type: 'decision', text: `决策(${decision.disposition || '—'})：${intent.purpose || decision.rationale || decision_id || ''}`, element_ref: 'intent', dim_ref: null });
  // 止损条件（armed）
  if (stopLoss.status) {
    trajectory.push({ at: stopLoss.deadline || null, type: 'stop_loss', text: `止损(${stopLoss.status})：${stopLoss.condition || ''}${stopLoss.trigger ? ` 触发=${stopLoss.trigger}` : ''}`, element_ref: 'stop_loss', dim_ref: null });
  }
  // 外部时间线（events/ provenance）——有真实流量时填充
  asArr(opts.timeline).forEach((ev) => {
    trajectory.push({ at: ev.at || null, type: ev.type || 'event', text: ev.text || '', element_ref: null, dim_ref: null });
  });
  // 结果
  if (decision.outcome) {
    trajectory.push({ at: decision.outcome_verified_at || decision.updated_at || null, type: 'outcome', text: `结果：${decision.outcome}`, element_ref: null, dim_ref: null });
  }

  return { characters, dynamics, trajectory };
}
