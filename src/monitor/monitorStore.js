// src/monitor/monitorStore.js — 销售决策监控存储聚合（只读，供监控台/API 读）
// 设计输入：CRM-sales-decision-monitoring-design.md §4/§5（7 闸门闭环监控）
// 复用决策数据底座（decision 表），只做聚合查询，不写决策
// G3 C3 扩展：failsByKind 内存失败计数（可观测化 · 静默吞错改观测）——monitorStore.js:88 起
import { query } from '../db.js';
import { listDecisions } from '../decision/decisionRepo.js';
import { coverageOf } from './dimCoverage.js';
import { ROOT_CAUSES } from '../decision/rootCauseClassifier.js';

// 七类根因码（+UNKNOWN）——单一事实源复用 rootCauseClassifier.ROOT_CAUSES，
// 新增第八类时此处自动同步，杜绝硬编码漂移（P4 右栏七类显示）
export function emptyRootCauseCounts() {
  const out = {};
  for (const k of Object.keys(ROOT_CAUSES)) out[k] = 0;
  return out;
}

// 7 阶段闸门（决策场景，与 db/seed.sql 同步）
export const GATE_SCENARIOS = [
  'LEAD_FOLLOW_UP', 'OPP_QUALIFY', 'SOLUTION_VALUE', 'QUOTE_PRICING',
  'SIGN_RISK', 'POST_CONTRACT', 'LOSS_REVIEW', 'DEAL_REOPEN',
];

// ───────────────────── G3 C3 可观测化（内存失败计数，不新增表/不升级 alert）─────────────────────
const failsByKind = new Map();

// 记录一次失败（kind 按设计 R1/R1b/R2 语义：precedent-link-failed / decision-memory-failed / nightly-distill-failed / crm-risk-scan-failed）
export function recordFailure(kind, error) {
  failsByKind.set(kind, (failsByKind.get(kind) || 0) + 1);
  return { kind, count: failsByKind.get(kind) };
}

// 按 kind 聚合失败计数（监控台/API 读；无记录 → 0）
export function getFailures() {
  return Object.fromEntries(failsByKind);
}

// 测试隔离：清空内存失败计数
export function resetFailures() {
  failsByKind.clear();
}

// 闸门指标：按 scenario 聚合 自主/升级/处置分布（读 decision 表）
// T13 租户隔离（2026-09-04）：tenantId 缺省 '*'=全量（不追加条件，行为兼容现状）；
//   显式传租户时按 (tenant_id=$N OR tenant_id='system') 回退（对齐 executor.js:25 范式）
export async function getGateMetrics({ scenario_id = null, state = null, limit = 50, tenantId = '*' } = {}) {
  const params = [];
  let where = '';
  if (scenario_id) { params.push(scenario_id); where += ` WHERE scenario_id=$${params.length}`; }
  if (state) { params.push(state); where += (where ? ' AND ' : ' WHERE ') + `state=$${params.length}`; }
  if (tenantId && tenantId !== '*') {
    params.push(tenantId);
    where += (where ? ' AND ' : ' WHERE ') + `(tenant_id=$${params.length} OR tenant_id='system')`;
  }
  params.push(limit);
  const r = await query(
    `SELECT scenario_id, state, count(*)::int n
     FROM crm.decision ${where}
     GROUP BY scenario_id, state ORDER BY scenario_id LIMIT $${params.length}`,
    params
  );
  const agg = { total: 0, autonomous: 0, escalated: 0, human: 0 };
  for (const row of r.rows) {
    agg.total += row.n;
    if (row.state === 'AUTONOMOUS') agg.autonomous += row.n;
    if (row.state === 'HUMAN') agg.human += row.n;
    if (row.state === 'REQUIRED' || row.state === 'ESCALATED') agg.escalated += row.n;
  }
  return agg;
}

// 七维覆盖：legacy 场景级覆盖视图（仅 serve 旧监控，与 attribution 解耦，走 dimCoverage.coverageOf）
// T13 租户隔离（2026-09-04）：tenantId 缺省 '*'=全量；显式传租户按回退范式（对齐 executor.js:25）
export async function getSevenDimCoverage({ scenario_id, tenantId = '*' } = {}) {
  const where = ['scenario_id=$1'];
  const params = [scenario_id];
  let order = '';
  if (tenantId && tenantId !== '*') {
    params.push(tenantId);
    where.push(`(tenant_id=$${params.length} OR tenant_id='system')`);
    order = ` ORDER BY (tenant_id=$${params.length}) DESC LIMIT 1`;
  }
  const r = (await query(`SELECT eval_dimensions FROM crm.decision_scenario WHERE ${where.join(' AND ')}${order}`, params)).rows[0];
  return coverageOf(r?.eval_dimensions);
}

// 决策列表：复用 decisionRepo.listDecisions
// T13 租户隔离（2026-09-04）：透传 tenantId（缺省 '*'=全量，行为兼容现状）
export async function getDecisionList({ scenario_id = null, limit = 20, tenantId = '*' } = {}) {
  return listDecisions({ scenario_id, limit, tenantId });
}

// ───────────────────── 决策质量稽核台：归因交叉矩阵聚合 ─────────────────────
// 单决策 → 4 类归因分类（口径红线：必填齐缺来源于 attribution.required_fill，准确率来源于 accuracy_signal / human_disposition）
// 交叉矩阵（设计 §1/§3）：
//   必填齐 + 不准(被推翻)        → inference_bias  (推理偏差：输入对了还错，调 agent 而非补数据)
//   必填缺 + 不准              → input_error     (输入问题：缺/错导致判错)
//   必填缺 + 准/待定           → input_missing   (输入缺失：必填未齐)
//   必填齐 + level='warn'(上下文弱) → context_insufficient (上下文不足，非阻断)
// 其余（必填齐 + 准/待定且无 warn）→ null（良性，不计入错误类）
export function classifyAttribution(a) {
  const rf = a?.required_fill || {};
  const missing = (rf.missing?.length ?? 0) > 0;
  const inaccurate = a?.accuracy_signal === 'inaccurate' || a?.category === 'inference_bias';
  if (!missing && inaccurate) return 'inference_bias';
  if (missing && inaccurate) return 'input_error';
  if (missing && !inaccurate) return 'input_missing';
  if (!missing && a?.level === 'warn') return 'context_insufficient';
  return null;
}

function emptyGateAgg() {
  return {
    total: 0,
    filled: 0,
    accuracy: { accurate: 0, inaccurate: 0, pending: 0, total: 0, accuracy_rate: null },
    required_fill_rate: null,
    categories: { input_missing: 0, input_error: 0, inference_bias: 0, context_insufficient: 0 },
    // P4 七类根因（J3 溯源归因 decision.root_cause.code；与旧 categories 并存：
    //   categories=拦截即时判定（attribution.category），root_causes=溯源七类（更精细））
    root_causes: emptyRootCauseCounts(),
    cross: { filled_accurate: 0, filled_inaccurate: 0, missing_accurate: 0, missing_inaccurate: 0 },
  };
}

// 按闸门聚合归因交叉矩阵（近 30 天、有 attribution 的决策）
// T13 租户隔离（2026-09-04）：decision 表已有 tenant_id 列（migrate-tenant.js:14）；tenantId 缺省 '*'=全量；
//   显式传租户按 (tenant_id=$N OR tenant_id='system') 回退（对齐 executor.js:25 范式）；q 可注入以单测
export async function getGateAttribution(tenantId = '*', { query: q = query } = {}) {
  const where = [`attribution IS NOT NULL`, `created_at >= now() - interval '30 days'`];
  const params = [];
  if (tenantId && tenantId !== '*') {
    params.push(tenantId);
    where.push(`(tenant_id=$${params.length} OR tenant_id='system')`);
  }
  const r = await q(
    `SELECT scenario_id, attribution, human_disposition, root_cause
     FROM crm.decision
     WHERE ${where.join(' AND ')}`,
    params
  );
  const byGate = {};
  for (const s of GATE_SCENARIOS) byGate[s] = emptyGateAgg();

  for (const row of r.rows || []) {
    const g = byGate[row.scenario_id] || (byGate[row.scenario_id] = emptyGateAgg());
    g.total += 1;
    const a = row.attribution || {};

    // 准确率：human_disposition 同源（CONFIRMED/APPROVED=准，OVERRIDDEN/CORRECTED=不准，其余=待定）
    const hd = row.human_disposition;
    const inaccurate = a.accuracy_signal === 'inaccurate' || a.category === 'inference_bias';
    if (hd === 'CONFIRMED' || hd === 'APPROVED') g.accuracy.accurate += 1;
    else if (hd === 'OVERRIDDEN' || hd === 'CORRECTED') g.accuracy.inaccurate += 1;
    else if (hd) g.accuracy.pending += 1; // 其他非空 human_disposition 视为待定/中立
    else g.accuracy.pending += 1;
    g.accuracy.total += 1;

    // 必填完整率
    const missing = (a.required_fill?.missing?.length ?? 0) > 0;
    if (!missing) g.filled += 1;

    // 4 类归因（旧：写时物化即时判定，保留兼容）
    const cat = classifyAttribution(a);
    if (cat) g.categories[cat] += 1;

    // 七类根因（新：J3 溯源归因 decision.root_cause.code，P4 右栏按此呈现）
    const rcCode = (row.root_cause && row.root_cause.code) || null;
    if (rcCode && g.root_causes[rcCode] !== undefined) g.root_causes[rcCode] += 1;

    // 2×2 交叉
    if (missing && inaccurate) g.cross.missing_inaccurate += 1;
    else if (missing && !inaccurate) g.cross.missing_accurate += 1;
    else if (!missing && inaccurate) g.cross.filled_inaccurate += 1;
    else g.cross.filled_accurate += 1;
  }

  // 终算比率
  for (const s of Object.keys(byGate)) {
    const g = byGate[s];
    const verdicted = g.accuracy.accurate + g.accuracy.inaccurate;
    g.accuracy.accuracy_rate = verdicted ? Number((g.accuracy.accurate / verdicted * 100).toFixed(1)) : null;
    g.required_fill_rate = g.total ? Number((g.filled / g.total * 100).toFixed(1)) : null;
  }

  return Object.entries(byGate).map(([scenario_id, g]) => ({ scenario_id, ...g }));
}

// ───────────────────── T16 J2 反馈回路：闸门业务结果聚合 ─────────────────────
// 聚合某 scenario：「决策通过率」(被采纳占比) vs「业务成功率」(outcome_verified 成功占比)
// 并暴露「隐性错误簇」：人工未推翻（采纳）但业务失败(lost/partial/stalled)的决策 → 红色高亮直链巡检卡
// T13 租户隔离（2026-09-04）：tenantId 缺省 '*'=全量；显式传租户按回退范式（对齐 executor.js:25）
// q 可注入以单测（避免真实连接）
export async function getGateOutcome(scenarioId, { query: q = query, window_days, tenantId = '*' } = {}) {
  let sql = `SELECT decision_id, disposition, human_disposition, state, outcome_verified
     FROM crm.decision WHERE scenario_id=$1`;
  const params = [scenarioId];
  if (tenantId && tenantId !== '*') {
    params.push(tenantId);
    sql += ` AND (tenant_id=$${params.length} OR tenant_id='system')`;
  }
  if (window_days) {
    sql += ` AND created_at >= now() - ($${params.length + 1}::int || ' days')::interval`;
    params.push(window_days);
  }
  const r = await q(sql, params);
  const rows = r.rows || [];
  const total = rows.length;
  let passCount = 0;
  let businessSuccess = 0;
  const hiddenErrorCluster = [];
  for (const d of rows) {
    const adopted = !(d.human_disposition === 'OVERRIDDEN' || d.human_disposition === 'CORRECTED');
    if (adopted) passCount += 1;
    const bizOk = d.outcome_verified === 'won' || d.outcome_verified === 'paid';
    if (bizOk) businessSuccess += 1;
    // 隐性错误簇：被采纳（人未推翻）但业务失败
    if (adopted && (d.outcome_verified === 'lost' || d.outcome_verified === 'partial' || d.outcome_verified === 'stalled')) {
      hiddenErrorCluster.push({
        decision_id: d.decision_id,
        disposition: d.disposition,
        human_disposition: d.human_disposition,
        outcome_verified: d.outcome_verified,
      });
    }
  }
  return {
    scenario_id: scenarioId,
    total,
    decision_pass_rate: total ? Number((passCount / total * 100).toFixed(1)) : null,
    business_success_rate: total ? Number((businessSuccess / total * 100).toFixed(1)) : null,
    hidden_error_cluster: hiddenErrorCluster,
  };
}

// ───────────────────── 平台运营洞察：智能体成败聚合（2026-09-05 设计 §2.1）─────────────────────
// 数据源：monitor_event（agent 域 loop-started/done/failed + context_facts.error）+ agent_contract_feedback（契约 pass/miss）
// 注：monitor_event / agent_contract_feedback 无 tenant_id 列 → 本聚合为平台级全局遥测（sysadmin 通配语义），不按租户过滤。
// 失败原因归一：loop-failed 的 context_facts.error（agentLoop.js:119 已埋点）；当前库无 loop-failed 样本 → 原因聚合为空，逻辑容错。
export async function getAgentSummary({ days = 7 } = {}) {
  const since = new Date(Date.now() - Number(days) * 864e5).toISOString();
  const evs = (await query(
    `SELECT agent_id, event_type, context_facts, created_at
       FROM crm.monitor_event
      WHERE domain='agent' AND created_at >= $1
      ORDER BY created_at`,
    [since]
  )).rows;
  // 契约反馈（agent_contract_feedback 无 tenant_id，按 agent 聚合；gap_type='success' 记 pass，其余记 miss）
  const feedback = (await query(
    `SELECT agent, gap_type, severity FROM crm.agent_contract_feedback WHERE ts >= $1`,
    [since]
  )).rows;
  const byAgent = {};
  const ensure = (id) => byAgent[id] || (byAgent[id] = { agent_id: id, starts: 0, done: 0, failed: 0, degraded: 0, reasons: [] });
  for (const e of evs) {
    const a = ensure(e.agent_id);
    if (e.event_type === 'loop-started') a.starts += 1;
    else if (e.event_type === 'loop-done') { a.done += 1; if (e.context_facts?.degraded) a.degraded += 1; }
    else if (e.event_type === 'loop-failed') { a.failed += 1; a.reasons.push(e.context_facts?.error || 'unknown'); }
  }
  for (const f of feedback) {
    const a = ensure(f.agent);
    a.contract = a.contract || { pass: 0, miss: 0 };
    if (f.gap_type === 'success') a.contract.pass += 1; else a.contract.miss += 1;
  }
  const rows = Object.values(byAgent).map((a) => ({
    ...a,
    runs: a.starts || (a.done + a.failed), // runs = 起点计数；缺 loop-started 时回退为 done+failed
    reasons: a.reasons.slice(0, 5), // 只保留前 5 条（展示聚合不铺全量）
  }));
  const totals = rows.reduce((acc, a) => ({
    runs: acc.runs + a.runs, done: acc.done + a.done, failed: acc.failed + a.failed, degraded: acc.degraded + a.degraded,
  }), { runs: 0, done: 0, failed: 0, degraded: 0 });
  // 失败原因全局归一（按前缀/关键字归并）
  const reasonCounts = {};
  for (const a of rows) for (const r of a.reasons) {
    const key = normFailReason(r);
    reasonCounts[key] = (reasonCounts[key] || 0) + 1;
  }
  const failReasons = Object.entries(reasonCounts).map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);
  return {
    window: { days: Number(days), from: since, to: new Date().toISOString() },
    totals: {
      ...totals,
      fail_rate: totals.runs ? Number((totals.failed / totals.runs).toFixed(4)) : 0,
      degrade_rate: totals.runs ? Number((totals.degraded / totals.runs).toFixed(4)) : 0,
    },
    by_agent: rows,
    fail_reasons: failReasons,
    feedback: { rows: feedback.length },
  };
}

function normFailReason(err) {
  const s = String(err || '');
  if (s.includes('SKILL 不存在')) return 'SKILL 不存在';
  if (s.includes('parse_empty')) return 'parse_empty（生成失败）';
  if (s.includes('timeout') || s.includes('超时')) return 'LLM/网络超时';
  if (s.includes('ECONNREFUSED')) return '连接拒绝';
  return s.slice(0, 80) || 'unknown';
}

// 租户隔离：缺省 '*'/system = 全量（不追加条件）；显式租户 → (tenant_id=$N OR tenant_id='system') 回退（对齐 monitorStore 既有范式）
function tenantClause(tenantId, params) {
  if (!tenantId || tenantId === '*' || tenantId === 'system') return '';
  params.push(tenantId);
  return ` AND (tenant_id=$${params.length} OR tenant_id='system')`;
}

// ───────────────────── 决策健康聚合（2026-09-05 设计 §2.2）─────────────────────
// 数据源：decision_event（made/required/escalated）+ decision_outcome（won/lost/stalled/paid + reason）+ agent_sla（4 问审计）
// decision_event 含 tenant_id → 按既有回退范式隔离；agent_sla 为平台级快照（取最新一条）
export async function getDecisionHealth({ days = 30, tenantId = '*' } = {}) {
  const since = new Date(Date.now() - Number(days) * 864e5).toISOString();
  const evParams = [since];
  const evClause = tenantClause(tenantId, evParams);
  const evs = (await query(
    `SELECT event_type, scenario_id FROM crm.decision_event WHERE created_at >= $1${evClause}`,
    evParams
  )).rows;
  const outs = (await query(
    `SELECT outcome_type, payload FROM crm.decision_outcome WHERE created_at >= $1`,
    [since]
  )).rows;
  const byScenario = {};
  const made = evs.filter((e) => e.event_type === 'made').length;
  const required = evs.filter((e) => e.event_type === 'required').length;
  const escalated = evs.filter((e) => e.event_type === 'escalated').length;
  for (const e of evs) {
    const s = byScenario[e.scenario_id] || (byScenario[e.scenario_id] = { scenario_id: e.scenario_id || '(none)', total: 0, made: 0, escalated: 0 });
    s.total += 1;
    if (e.event_type === 'made') s.made += 1;
    if (e.event_type === 'escalated') s.escalated += 1;
  }
  const outcomes = { won: 0, lost: 0, stalled: 0, paid: 0 };
  const lostReasons = {};
  for (const o of outs) {
    if (o.outcome_type != null && outcomes[o.outcome_type] !== undefined) outcomes[o.outcome_type] += 1;
    if (o.outcome_type === 'lost') {
      const reason = o.payload?.reason || o.payload?.note || '未记录';
      lostReasons[reason] = (lostReasons[reason] || 0) + 1;
    }
  }
  const byScenarioList = Object.values(byScenario).map((s) => ({ ...s, fail_rate: s.total ? Number((s.escalated / s.total).toFixed(4)) : 0 }));
  // agent_sla 4 问审计（近快照，latest 取最新一条）
  let audit4q = { pass: 0, warn: 0, fail: 0 };
  const sla = (await query(
    `SELECT q1_pass, q1_warn, q1_fail, q2_pass, q2_warn, q2_fail, q3_pass, q3_warn, q3_fail, q4_pass, q4_warn, q4_fail
       FROM crm.agent_sla ORDER BY measured_at DESC LIMIT 1`
  )).rows[0];
  if (sla) {
    audit4q = {
      pass: sla.q1_pass + sla.q2_pass + sla.q3_pass + sla.q4_pass,
      warn: sla.q1_warn + sla.q2_warn + sla.q3_warn + sla.q4_warn,
      fail: sla.q1_fail + sla.q2_fail + sla.q3_fail + sla.q4_fail,
    };
  }
  return {
    window: { days: Number(days) },
    made, required, escalated,
    by_scenario: byScenarioList,
    outcomes,
    lost_reasons: Object.entries(lostReasons).map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
    audit_4q: audit4q,
  };
}