// src/calibration/autoSuggest.js — T21 J3 自动建议（实时偏差→浮卡，无 LLM、确定性）
// 设计依据：docs/2026-08-30-j2-j3-comprehensive-design.md §3(b) 自动建议触发器
// 定位：夜间批量复盘（retro.js）的「实时」补充——偏差（闸门标红 / outcome_mismatch /
//   边应存缺 / context_insufficient）一出现，即按 attribute(metrics) 产出建议；
//   经 SSE calibration 域推浮卡；一键批准走既有 approvePatch（第0闸），本模块不碰写通道。
// 铁律：守卫（R5/R6）优先，样本不足先例不足 → 零处方；绝不自批自方；订阅者异常隔离。
import { on } from '../events/bus.js';
import { emit } from '../events/bus.js';
import { attribute } from './rules.js';
import { computeMetrics } from './metrics.js';
import { query as defaultQuery } from '../db.js';

// ── 偏差指示器：由近窗决策行聚合出 R7–R17 依赖的 J3 指标 ─────────────────────────
// 输入：近窗决策行数组（含 attribution.edge_compliance / feedback / outcome_verified /
//       attribution.category / human_disposition / disposition）
// 输出：供 attribute() 直接消费的 metrics 混合体（computeMetrics 存量键 + J3 增量键）
export function deriveDeviationMetrics(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const withOutcome = list.filter((d) => d.outcome_verified);
  const adopted = list.filter(
    (d) => !(d.human_disposition === 'OVERRIDDEN' || d.human_disposition === 'CORRECTED')
  );
  const adoptedWithOutcome = adopted.filter((d) => d.outcome_verified);

  // outcome_mismatch_rate：人工采纳但业务失败（lost/partial/stalled）占比——隐性错误簇
  const bizFail = adoptedWithOutcome.filter(
    (d) => d.outcome_verified === 'lost' || d.outcome_verified === 'partial' || d.outcome_verified === 'stalled'
  );
  const outcome_mismatch_rate = adoptedWithOutcome.length
    ? bizFail.length / adoptedWithOutcome.length : 0;

  // edge_missing_rate：T29-b 三元组语义——「应连未连」边数 / 应连边总数（投影 missing 不算缺）。
  //   attribution.edge_compliance：known=true 才构成应连依据；required_edges=应连全清单（分母），
  //   required_missing=应连未连子集（分子）。旧数据无 required_edges 时以 required_missing 长度兜底分母。
  let edgeMissingSum = 0;
  let edgeExpectedSum = 0;
  for (const d of list) {
    const ec = d.attribution?.edge_compliance || {};
    if (ec.known !== true) continue; // 无应连依据（known=false/旧投影）不计数，避免把投影 missing 当缺
    const rm = Array.isArray(ec.required_missing) ? ec.required_missing : [];
    const req = Array.isArray(ec.required_edges) ? ec.required_edges : [];
    edgeExpectedSum += req.length || rm.length;
    edgeMissingSum += rm.length;
  }
  const edge_missing_rate = edgeExpectedSum ? edgeMissingSum / edgeExpectedSum : 0;

  // context_insufficient_rate：attribution.category=context_insufficient（上下文弱，非阻断）
  const ctxInsuf = list.filter((d) => d.attribution?.category === 'context_insufficient').length;
  const context_insufficient_rate = list.length ? ctxInsuf / list.length : 0;

  // need_dim_order_rate：维度不齐但非必填缺失（category=input_missing 或 required_fill.missing 非空）近似
  const dimIncomplete = list.filter((d) => {
    const rf = d.attribution?.required_fill || {};
    return (rf.missing?.length ?? 0) > 0;
  });
  const need_dim_order_rate = list.length ? dimIncomplete.length / list.length : 0;

  // precedent_pollution_rate：先例被污染信号（feedback.deviation_note 提及先例/标杆）
  const precedentPolluted = list.filter((d) =>
    /先例|标杆|precedent/i.test(String(d.feedback?.deviation_note || ''))
  );
  const precedent_pollution_rate = list.length ? precedentPolluted.length / list.length : 0;

  const base = computeMetrics(list);
  return { ...base, outcome_mismatch_rate, edge_missing_rate, context_insufficient_rate, need_dim_order_rate, precedent_pollution_rate };
}

// ── 单场景：拉近窗决策 → 偏差指标 → attribute(metrics)（守卫优先）──────────────────
export async function suggestForScenario(
  scenarioId,
  { windowDays = 30, query: q = defaultQuery } = {}
) {
  const r = await q(
    `SELECT decision_id, scenario_id, disposition, human_disposition, state,
            outcome_verified, attribution, feedback, decider_type,
            created_at, human_decided_at, conditions_evaluated,
            referenced_precedents
     FROM crm.decision
     WHERE scenario_id=$1 AND created_at >= now() - ($2::int || ' days')::interval`,
    [scenarioId, windowDays]
  );
  const rows = r.rows || [];
  const metrics = deriveDeviationMetrics(rows);
  const result = attribute(metrics);
  return {
    scenario_id: scenarioId,
    sample_size: metrics.sample_size,
    metrics,
    patches: result.patches,
    guards: result.guards,
    reason: result.reason,
  };
}

// ── 进程级实时订阅：decision 域事件（新决策/回写）→ 触发建议 → SSE calibration 域推浮卡
// 幂等注册；订阅者异常隔离（不阻断决策写路径）；无配置场景清单时只对已知 GATE_SCENARIOS 提示
let unsubscribers = [];
export function registerAutoSuggest({
  scenarios = null,            // 默认 null = 全部闸门不触发（避免高频扫描），由调用方注入
  emitSuggestions = defaultEmit,
} = {}) {
  if (unsubscribers.length) return { ok: false, reason: 'already registered' };
  const trigger = async (msg) => {
    if (msg?.type !== 'decision-created' && msg?.type !== 'outcome-set' && msg?.type !== 'feedback-set') return;
    const scenarioId = msg?.summary?.scenario_id || msg?.summary?.scenarioId;
    if (!scenarioId || (scenarios && !scenarios.includes(scenarioId))) return;
    try {
      const s = await suggestForScenario(scenarioId);
      if (s.patches.length) emitSuggestions(s);
    } catch (e) {
      // 订阅者异常隔离
      console.error('[autoSuggest] trigger failed:', e?.message);
    }
  };
  unsubscribers.push(on('decision', trigger));
  return { ok: true };
}
export function unregisterAutoSuggest() {
  unsubscribers.forEach((u) => u && u());
  unsubscribers = [];
}

// 默认 SSE 出口：calibration 域 retro-suggestions 事件（复用前端既有 subscribe——见
// sales-decision-monitor.html:1225 监听 calibration 域、:1228 判 msg.summary.event==='retro-suggestions'，
// 因为 bus.emit 包装成 { domain,type,ts,summary }）。autoSuggest 与 retro.js 同事件名，
// 前端零改动即可显示浮卡；source 字段区分来源（autoSuggest=实时偏差触发 / retro=夜间批量）。
function defaultEmit(s) {
  emit('calibration', 'retro-suggestions', {
    source: 'autoSuggest',
    run_at: new Date().toISOString(),
    scenario_id: s.scenario_id,
    sample_size: s.sample_size,
    // 与 renderRetroFab 契约对齐：draft_patches / draftPatches 均可（前端两者都读）
    draft_patches: s.patches.map((p) => ({
      scenario_id: s.scenario_id,
      root_cause_class: p.id,          // 规则 id 即根因类（R7→outcome_mismatch…）
      recommended_knob: p.knob,
      expected_impact: p.label,
      llm_notes: `evidence: ${JSON.stringify(p.evidence)}`,
      risk: p.risk,
    })),
    // 浮卡可展示守卫信息（样本不足等）
    guards: s.guards,
    reason: s.reason,
  });
}