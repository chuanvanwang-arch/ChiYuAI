// src/decision/closure.js — T-D6 单决策三图闭环聚合（K/M/J 区 + crossLoopMap D1-D5 + provenance）
// 设计：docs/2026-08-30-decision-drillthrough-design.md §3 / dev-plan T-D6。
// 单一事实源：K=involved_entities→particles + meta_attr 约束；M=decision 行 + decision_relation 7 边 + 记忆；
//   J=decision 判定 + decision_outcome + calibration_patch。跨环映射 D1-D5 标 exists + 载体。
// 复用既有模块（getDecision / listTypedEdges / listOutcomes / computeEdgeCompliance），不重复造轮子。
import { query } from '../db.js';
import { getDecision } from './decisionRepo.js';
import { listTypedEdges } from './relation.js';
import { splitEdgesByCaliber, edgeCaliberCount } from './edgeSource.js'; // T0(BG-04) 边来源双口径
import { listOutcomes } from './outcome.js';
import { computeEdgeCompliance } from '../monitor/attribution.js';

// K 区：involved_entities → particles 解析 + meta_attr 写时约束新鲜度
async function buildKZone(decision) {
  const entities = Array.isArray(decision.involved_entities) ? decision.involved_entities : [];
  const ids = entities.map((e) => e.id).filter(Boolean);
  let particles = [];
  if (ids.length) {
    const r = await query(
      `SELECT id, type, title, state, payload, updated_at FROM crm.particles WHERE id = ANY($1::uuid[])`,
      [ids]
    );
    particles = r.rows;
  }
  const types = [...new Set(particles.map((p) => p.type))];
  let constraints = [];
  if (types.length) {
    const r = await query(
      `SELECT particle_type, attr_slug, title, required, enabled, source_refresh_sla
       FROM crm.meta_attr WHERE particle_type = ANY($1::text[])`,
      [types]
    );
    constraints = r.rows;
  }
  return { entities, particles, constraints };
}

// M 区：decision 行（attribution/conditions/policy_version）+ 记忆 + 7 边 + edge_compliance
// T29-b：应连边 = 服务场景 required_dims 的边并集（7×7 交叉校验语义）——从决策场景读必填维
async function buildMZone(decision) {
  const edges = await listTypedEdges(decision.decision_id, { direction: 'both' });
  // T0(BG-04)：边合规与存在性判定仅认运行时真实边，演示/种子边不计入分母（避免假绿）。
  const { runtime, demo } = splitEdgesByCaliber(edges);
  const relTypes = runtime.map((e) => e.rel_type);
  let reqDims = [];
  try {
    const sRes = await query(`SELECT required_dims FROM crm.decision_scenario WHERE scenario_id=$1 AND (tenant_id=$2 OR tenant_id='system') ORDER BY (tenant_id=$2) DESC LIMIT 1`, [decision.scenario_id, decision.tenant_id || 'system']);
    reqDims = sRes.rows[0]?.required_dims || [];
    if (!Array.isArray(reqDims)) reqDims = [];
  } catch { reqDims = []; }
  const edge_compliance = computeEdgeCompliance(relTypes, { requiredDims: reqDims });
  const mem = await query(
    `SELECT id, kind, payload, created_at FROM crm.memory_log WHERE topic=$1 ORDER BY created_at DESC LIMIT 50`,
    [`decision:${decision.decision_id}`]
  );
  return {
    decision_id: decision.decision_id,
    scenario_id: decision.scenario_id,
    disposition: decision.disposition,
    human_disposition: decision.human_disposition,
    confidence: decision.confidence,
    confidence_source: decision.confidence_source,
    effective_policy_version: decision.effective_policy_version,
    conditions_evaluated: decision.conditions_evaluated,
    rationale: decision.rationale,
    attribution: decision.attribution,
    edges,
    // 双口径：运行时边驱动真实判定；演示边保留供前端虚线展示，不入分母。
    edge_caliber: edgeCaliberCount(edges),
    edge_compliance,
    memory: mem.rows,
  };
}

// J 区：判定 + 业务结果 + 校准处方（D3 写回）
async function buildJZone(decision) {
  const outcomes = await listOutcomes(decision.decision_id);
  const cal = await query(
    `SELECT patch_id, knob, target, from_value, to_value, status, decision_id, created_at
     FROM crm.calibration_patch WHERE decision_id=$1 ORDER BY created_at DESC LIMIT 50`,
    [decision.decision_id]
  );
  return {
    decision_id: decision.decision_id,
    disposition: decision.disposition,
    state: decision.state,
    confidence: decision.confidence,
    rationale: decision.rationale,
    outcome_verified: decision.outcome_verified,
    feedback: decision.feedback,
    root_cause: decision.root_cause,
    outcomes,
    calibration_patches: cal.rows,
  };
}

// D1-D5 跨环映射存在性 + 载体（D5 仅判 K↔M 写时约束是否生效，不深究值）
function buildCrossLoopMap({ k, m, j }) {
  return {
    D1: { exists: Array.isArray(k.entities) && k.entities.length > 0, carrier: 'decision.involved_entities → particles' },
    D2: { exists: (m.edge_caliber?.runtime ?? 0) > 0, carrier: 'decision_relation（M 边表，运行时边）' },
    D3: { exists: Array.isArray(j.calibration_patches) && j.calibration_patches.length > 0, carrier: 'calibration_patch（经第0闸写回 K/M）' },
    D4: { exists: Array.isArray(j.outcomes) && j.outcomes.length > 0, carrier: 'decision_outcome（J2 反馈）' },
    D5: { exists: Array.isArray(k.constraints) && k.constraints.length > 0, carrier: 'meta_attr.required / source_refresh_sla' },
  };
}

// 单决策三图闭环聚合（核心入口，供 GET /api/decision/:id/closure）
export async function getDecisionClosure(decisionId) {
  const decision = await getDecision(decisionId);
  if (!decision) return null;
  const k = await buildKZone(decision);
  const m = await buildMZone(decision);
  const j = await buildJZone(decision);
  const crossLoopMap = buildCrossLoopMap({ k, m, j });
  const prov = await query(
    `SELECT entry_type, source, payload, created_at FROM crm.decision_provenance WHERE decision_id=$1 ORDER BY created_at ASC`,
    [decisionId]
  );
  return { decision_id: decisionId, k, m, j, crossLoopMap, provenance: prov.rows };
}
