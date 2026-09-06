// src/decision/auditability.js — 决策可审计性「4 问验证」共享评分（单一事实源）
// 设计：docs/2026-08-31-auditability-sla-materialization-design.md（§4 架构 / §6 物化 / §9 A9 闭环）
// 复用面：per-decision 端点(monitor→graph audit-4q) / 平台聚合(monitor/auditability) /
//         物化(agent_sla) / A9 趋势闭环 四者共用 computeAudit4q + aggregateAuditability，评分口径永不漂移。
// 依赖全部来自 src/decision/ 可复用层（decisionRepo/decisionTrace/provenance/conflict），无循环依赖。
import { query } from '../db.js';
import { getDecision } from './decisionRepo.js';
import { traceDecision, getImpact } from './decisionTrace.js';
import { exportAudit } from './provenance.js';
import { detectConflicts } from './conflict.js';
import { DECISION_TIME_BASIS } from '../context/timelineSource.js';
import { getDecisionContextSnapshot } from '../context/snapshotStore.js';

// §7.1 Q1 门槛：dim_coverage 中 supplied_dims ≥ 5/7（设计文档字面口径）
// 冷启动豁免（设计 §7.1 注）：S2 先例召回与 S3 冲突探测允许合法 empty，
// 但豁免后剩余 5 维（identity/structure/time_config/operational_state/governance）须真实供给，
// 故门槛维持 5；未达 → warn，诚实暴露缺口而非用「有理由」掩盖（BG-04 反假绿铁律）。
export const Q1_MIN_SUPPLIED_DIMS = 5;

// 等价于 routes.js 原 graphTraceHandler（4 问评分仅消费 upstream/downstream；typedEdges 属 T11 图视图附加，不参与评分）
async function traceForAudit(decisionId, { maxDepth = 4 } = {}) {
  const upstream = await traceDecision(decisionId, { direction: 'upstream', maxDepth });
  const downstream = await traceDecision(decisionId, { direction: 'downstream', maxDepth });
  return { decision_id: decisionId, upstream, downstream };
}

// 等价于 routes.js 原 graphImpactHandler
async function impactForAudit(decisionId, { maxDepth = 4 } = {}) {
  return getImpact(decisionId, { maxDepth });
}

// 单决策 4 问评分：Q1 解释直接原因 / Q2 追溯到源头 / Q3 发现冲突事实 / Q4 看下游影响
// 返回 health（可审计性 N/4）+ 四问逐条 status；决策不存在返回 null（调用方按 404 处理）
export async function computeAudit4q(id) {
  const d = await getDecision(id);
  if (!d) return null;
  const entities = (Array.isArray(d.involved_entities) ? d.involved_entities : [])
    .map((e) => (e && typeof e === 'object' ? e.id : e)).filter(Boolean);
  // 三路并行取图证据；单路失败转 {error} 不拖垮整体（Q4/Q2 据此判 fail/warn）
  const [trace, impact, prov, snap] = await Promise.all([
    traceForAudit(id, { maxDepth: 4 }).catch((e) => ({ error: String(e.message || e) })),
    impactForAudit(id, { maxDepth: 4 }).catch((e) => ({ error: String(e.message || e) })),
    exportAudit({ decision_id: id }).catch((e) => ({ error: String(e.message || e) })),
    // Q1 证据源：上下文快照的维度供给数（设计 §7.1）；无快照 → null，按「缺证据」判 warn
    getDecisionContextSnapshot(id).catch(() => null),
  ]);
  // Q3：逐实体检测未裁决冲突（needs_review = 多源给出不同值且待裁决，保留不删）
  const conflicts = [];
  let entitiesScanned = 0;
  for (const ent of entities) {
    entitiesScanned++;
    const det = await detectConflicts(ent).catch(() => null);
    if (!det) continue;
    const byAttr = {};
    for (const a of (det.assertions || [])) {
      if (a.needs_review) (byAttr[a.attr] = byAttr[a.attr] || new Set()).add(a.value);
    }
    for (const [attr, vals] of Object.entries(byAttr)) {
      conflicts.push({
        entity_id: ent, attr, values: [...vals],
        sources: (det.assertions || []).filter((x) => x.attr === attr)
          .map((x) => ({ source_id: x.source_id, value: x.value, valid: x.valid })),
      });
    }
  }
  const upstreamCount = (trace && trace.upstream) ? trace.upstream.length : 0;
  const downstreamCount = (impact && impact.nodes) ? impact.nodes.length : 0;
  const depth = (impact && impact.depth) || 0;
  const chainStatus = (prov && prov.chainStatus) || (prov && prov.error ? 'ERROR' : 'UNKNOWN');
  const hasRationale = !!(d.rationale && String(d.rationale).trim());
  // Q1（§7.1 字面口径）：维度供给 ≥5/7 才 pass。快照缺失或篡改 → 无证据，判 warn（不拿 rationale 顶替）
  const snapshotUsable = !!(snap && snap.tampered !== true && typeof snap.supplied_dims === 'number');
  const suppliedDims = snapshotUsable ? snap.supplied_dims : null;
  const q1 = suppliedDims !== null && suppliedDims >= Q1_MIN_SUPPLIED_DIMS ? 'pass' : 'warn';
  // Q2（§7.1）：链完整 OK **且覆盖上下文操作**。空链（entries=0）不可自称 OK——
  //   verifyChain 对空集天然返回 OK，此前导致「零溯源条目仍判 pass」的假绿，故显式要求
  //   entries>0 且至少一条 entry_type='context_supply'（S7 操作级留痕）。
  const provEntries = (prov && Array.isArray(prov.entries)) ? prov.entries : [];
  // T3（2026-09-03）：事件入链后 provenance 混入 `event:*` 生命周期条目。Q2 问的是「能否追溯到源头」，
  //   源头 = context_supply 等**证据**条目；事件是决策自身元数据，计入会把「有几条真实证据」稀释成
  //   「有多少条流水」。故溯源口径收窄为证据条目（NOT LIKE 'event:%'），事件量另以 event_entries 暴露。
  //   判定结果不变：supplyEntries>0 已蕴含 evidenceEntries>0，收窄只影响计数与文案精度，不改变 pass/warn。
  const evidenceEntries = provEntries.filter((e) => e && !String(e.entry_type || '').startsWith('event:'));
  const eventEntries = provEntries.length - evidenceEntries.length;
  const supplyEntries = evidenceEntries.filter((e) => e && e.entry_type === 'context_supply');
  const q2 = chainStatus === 'TAMPERED'
    ? 'fail'
    : (chainStatus === 'OK' && evidenceEntries.length > 0 && supplyEntries.length > 0 ? 'pass' : 'warn');
  const q3 = conflicts.length === 0 ? (entitiesScanned > 0 ? 'pass' : 'warn') : 'warn';
  // Q4：看下游影响——能否观测到该决策的下游传导链
  // 影响计算失败→fail；有下游节点→pass；孤立/叶子决策无下游可观测→warn（合法但需关注）
  const impactError = (impact && impact.error) ? String(impact.error) : null;
  const q4 = impactError ? 'fail' : (downstreamCount > 0 ? 'pass' : 'warn');
  const statuses = { Q1: q1, Q2: q2, Q3: q3, Q4: q4 };
  const score = Object.values(statuses).filter((s) => s === 'pass').length;
  return {
    decision_id: id,
    health: { score, total: 4, statuses, needs_review_count: conflicts.length },
    questions: {
      Q1: { key: 'direct_cause', question: '能否解释直接原因', status: q1,
        upstream_count: upstreamCount, has_rationale: hasRationale,
        supplied_dims: suppliedDims, min_supplied_dims: Q1_MIN_SUPPLIED_DIMS,
        answer: q1 === 'pass'
          ? `上下文维度供给 ${suppliedDims}/7 达标（门槛 ≥${Q1_MIN_SUPPLIED_DIMS}/7）`
          : (suppliedDims === null
            ? '无可用上下文快照（维度供给无证据）'
            : `上下文维度供给仅 ${suppliedDims}/7，未达门槛 ${Q1_MIN_SUPPLIED_DIMS}/7`) },
      Q2: { key: 'source_trace', question: '能否追溯到源头', status: q2,
        chain_status: chainStatus, entries: evidenceEntries.length,
        event_entries: eventEntries, context_supply_entries: supplyEntries.length,
        answer: q2 === 'pass'
          ? `PROV-O 链完整且覆盖上下文操作（${evidenceEntries.length} 条证据条目 / ${supplyEntries.length} 条 context_supply${eventEntries ? `；另有 ${eventEntries} 条事件条目` : ''}）`
          : (chainStatus === 'TAMPERED'
            ? '溯源链被篡改'
            : (evidenceEntries.length === 0
              ? '无溯源条目（空链不可自称 OK），上下文供给未留痕'
              : `溯源条目 ${evidenceEntries.length} 条但缺 context_supply 覆盖（${supplyEntries.length} 条）`)) },
      Q3: { key: 'conflict_facts', question: '能否发现冲突事实', status: q3,
        entities_scanned: entitiesScanned, unresolved_count: conflicts.length, conflicts,
        answer: q3 === 'pass' ? '无未裁决冲突' : `发现 ${conflicts.length} 条未裁决冲突` },
      Q4: { key: 'downstream_impact', question: '能否看下游影响', status: q4,
        downstream_count: downstreamCount, depth,
        answer: q4 === 'pass'
          ? `下游 ${downstreamCount} 个节点 / 最大 ${depth} 跳,影响链可观测`
          : (q4 === 'fail' ? `下游影响计算失败:${impactError}` : '无下游节点(孤立/叶子决策),影响面不可观测,需关注') },
    },
  };
}

// 平台级可审计性 SLA 聚合：扫近期决策逐项评分，聚合出可审计性百分比与四问分布
// 响应形状（window/scored/full/with_conflict/tampered/auditability_pct/per_status/decisions）与
// 原 /api/monitor/auditability 端点完全一致（2016-08-31 抽取，测试契约 auditability-sla.test.js 3/3 锚定）
//
// 2026-09-02 性能修复（根因：逐条串行 computeAudit4q 每条含多条图/溯源重查询，
//   单条偶发慢查询（可达 15s+）会拖垮整批导致接口 30s 超时、Layer0 可审计性卡永远「加载中…」）：
//   ① 串行 → 有界并发并行（AGG_MAX_CONCURRENCY，默认 8），50 条从 ~5s 降到 ~3s；
//   ② 单条 computeAudit4q 套超时护栏（AGG_PER_DECISION_TIMEOUT_MS，默认 3000），
//      单条慢查询超时即跳过该条（不计入 scored），不再挂死整批。
//   两项均为 env 可调，默认值已兼顾稳态性能与 degraded 防护。
const AGG_MAX_CONCURRENCY = Math.max(1, Number(process.env.AUDIT_AGG_CONCURRENCY || 8));
const AGG_PER_DECISION_TIMEOUT_MS = Math.max(500, Number(process.env.AUDIT_PER_DECISION_TIMEOUT_MS || 3000));

// 单条 Promise 超时护栏：超时即 reject，由调用方按 skip 处理（底层 pg 查询仍会在连接上跑完并释放，不泄漏）
function withTimeout(promise, ms, tag) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout:' + tag)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// 有界并发并行执行 worker，返回与 items 等长的 results（保持顺序）
async function runBounded(items, concurrency, worker) {
  const results = new Array(items.length);
  let idx = 0;
  async function drain() {
    while (idx < items.length) {
      const cur = idx++;
      results[cur] = await worker(items[cur], cur);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => drain()));
  return results;
}

export async function aggregateAuditability({ limit = 50 } = {}) {
  const windowSize = Math.min(Math.max(Number(limit), 1), 200);
  const rows = (await query(
    // BG-08：时间基准统一为 COALESCE(decided_at, created_at)，与叙事时间线/L2 检索同源
    `SELECT decision_id FROM crm.decision ORDER BY ${DECISION_TIME_BASIS} DESC LIMIT $1`,
    [windowSize]
  )).rows;
  const perStatus = {
    Q1: { pass: 0, warn: 0, fail: 0 }, Q2: { pass: 0, warn: 0, fail: 0 },
    Q3: { pass: 0, warn: 0, fail: 0 }, Q4: { pass: 0, warn: 0, fail: 0 },
  };
  let full = 0, withConflict = 0, tampered = 0, scoreSum = 0;
  const decisions = [];
  const computed = await runBounded(rows, AGG_MAX_CONCURRENCY, async ({ decision_id }) => {
    try {
      const r = await withTimeout(computeAudit4q(decision_id), AGG_PER_DECISION_TIMEOUT_MS, decision_id);
      return { decision_id, r };
    } catch {
      return { decision_id, r: null }; // 超时/异常 → 跳过该条（不计入 scored，诚实暴露未评，不掩盖为绿）
    }
  });
  for (const { decision_id, r } of computed) {
    if (!r) continue;
    for (const q of ['Q1', 'Q2', 'Q3', 'Q4']) perStatus[q][r.questions[q].status]++;
    if (r.health.score === 4) full++;
    if (r.health.needs_review_count > 0) withConflict++;
    if (r.questions.Q2.status === 'fail') tampered++;
    scoreSum += r.health.score;
    decisions.push({ decision_id, score: r.health.score, statuses: r.health.statuses });
  }
  const scored = decisions.length;
  // 空窗口降级：无决策时 pct 为 null（不报错），与既有端点一致
  const auditability_pct = scored ? Math.round((scoreSum / scored / 4) * 100) : null;
  return {
    window: windowSize, scored, full, with_conflict: withConflict, tampered,
    auditability_pct, per_status: perStatus, decisions,
  };
}