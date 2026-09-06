// src/ontology/ageSync.js — 写时镜像编排（事实源在表，AGE 只读镜像查询面）
// 设计输入：docs/superpowers/specs/2026-08-26-age-semantica-program-design.md P1
// 纪律：本模块只把 crm.* 表的写后状态 MERGE 进 crm_decision_network 图；
//       AGE 不可用（_available=false）时原语自行短路返回，不抛、不阻断主写。
import { addParticleVertex, addDecision, addEdge } from '../decision/ageGraph.js';
import { query } from '../db.js';

// 受控谓词 → AGE 关系名（与 hooks.js 受控边对齐）
const EDGE_MAP = {
  owned_by: 'owned_by', part_of: 'part_of', belongs_to: 'belongs_to',
  has_quotation: 'has_quotation', has_contract: 'has_contract',
  key_contact: 'key_contact', relationship_strength: 'relationship_strength',
  auto_weak: 'auto_weak',
};

// 镜像单个粒子 + 其受控边
export async function syncParticle(entity) {
  if (!entity?.id) return { ok: false, skipped: 'no-id' };
  await addParticleVertex(entity.type, String(entity.id), entity.title || '').catch(() => {});
  const edges = await query(
    `SELECT edge_type, target_type, target_id FROM crm.edges WHERE source_id=$1`,
    [String(entity.id)]
  );
  for (const e of edges.rows) {
    if (!EDGE_MAP[e.edge_type]) continue; // 仅镜像受控谓词边
    await addEdge(e.edge_type, { id: String(entity.id), label: entity.type },
      { id: String(e.target_id), label: e.target_type }).catch(() => {});
  }
  return { ok: true };
}

// 镜像单条边（瞬时同步，供 createEdge 后调用）
export async function syncEdge(edge) {
  if (!EDGE_MAP[edge.edge_type]) return { ok: false, skipped: 'unmapped' };
  return addEdge(edge.edge_type,
    { id: String(edge.source_id), label: edge.source_type },
    { id: String(edge.target_id), label: edge.target_type });
}

// 镜像决策顶点（并同步 PROV-O 来源顶点 + was_derived_from 边）
export async function syncDecision(d) {
  await addDecision(d);
  // P3 PROV-O：来源顶点 + 溯源边（若已 capture provenance 来源；无则不建）
  const src = await query(
    `SELECT source FROM crm.decision_provenance WHERE decision_id=$1 LIMIT 1`, [String(d.decision_id)]
  ).catch(() => ({ rows: [] }));
  if (src.rows[0]?.source) {
    await addParticleVertex('SOURCE', `${d.decision_id}:${src.rows[0].source}`, src.rows[0].source).catch(() => {});
    await addEdge('was_derived_from', { id: String(d.decision_id), label: 'Decision' },
      { id: `${d.decision_id}:${src.rows[0].source}`, label: 'SOURCE' }).catch(() => {});
  }
  return { ok: true };
}

// ensureAll / createEdge / createDecision 统一旁路入口（决策表写权威不变）
export async function ensureAgeSync(entity) {
  try {
    if (entity && 'decision_id' in entity && entity.scenario_id) {
      await syncDecision(entity);
    } else if (entity && entity.type) {
      await syncParticle(entity);
    } else if (entity && entity.edge_type && entity.source_id) {
      await syncEdge(entity);
    }
  } catch (e) {
    // ageGraph 内部已 emit + recordFailure；此处仅吞掉保主写
  }
}
