// src/decision/ageGraph.js — C1 AGE 决策网络图（查询面，非写权威）
// 设计输入：docs/superpowers/specs/2026-08-26-semantica-decision-network-monitoring-design.md §4/§5.1-C1
// 对齐 Semantica age_store.py：参数化 Cypher 防注入、label 消毒、事务化；降级递归 CTE（决策表写权威不变）
// 红线：本模块永不替代表 decision / decision_precedent_rel；写时同步失败仅 trace+recordFailure（G3 不静默），主链路不阻断
//
// AGE 1.6.0 实测约定（已通过预检锁定）：
//  - cypher() 第一参 graph_name 必须是字面常量（不可绑定参数）→ 用 '${GRAPH_NAME}'
//  - 查询串用 $$...$$ 美元引号字面量传入（避免 $ 占位与 PG 美元引号解析冲突；值经 build() 内联转义）
//  - 结果用 ag_catalog.agtype_to_json(x.v) 取 JSON（agtype_to_jsonb 在本版本不存在；原始顶点 RETURN 不稳定，故一律 RETURN {map} AS v）
import { pool } from '../db.js';
import { emit } from '../events/bus.js';
import { recordFailure } from '../monitor/monitorStore.js';

export const GRAPH_NAME = 'crm_decision_network';

let _available = false;
export function isAvailable() { return _available; }

// label/键消毒：仅允许 [A-Za-z0-9_]（防 Cypher 注入）
function safeLabel(s) { return String(s).replace(/[^A-Za-z0-9_]/g, '_'); }

// Cypher 字面量转义（值由代码/枚举/UUID 构造，安全；自由文本经单引号转义防注入）
function lit(v) {
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v === null || v === undefined) return 'null';
  return "'" + String(v).replace(/'/g, "\\'") + "'";
}
// 将 $key 占位替换为内联转义字面量（消除 AGE $param 与 PG 美元引号冲突）
function build(tpl, params = {}) {
  return tpl.replace(/\$(\w+)/g, (_, k) => {
    if (!(k in params)) throw new Error('ageGraph: 缺少参数 $' + k);
    return lit(params[k]);
  });
}

// 连接卫生（防连接池污染导致的测试 flaky / 生产快照陈旧）：
//  - 写操作（cypher MERGE）必须在显式事务内提交；原实现仅靠 client.release() 未 COMMIT，
//    会把 OPEN 事务的客户端归还池，后续 pool.query 落到它时看到陈旧快照（决策表回退查到 0 行 → 404）。
//  - search_path 用 SET LOCAL（事务级），随 COMMIT/ROLLBACK 自动还原，不污染池。
async function withAgeClient(fn) {
  const client = await pool.connect();
  try {
    await client.query("LOAD 'age'");
    await client.query('BEGIN');
    await client.query('SET LOCAL search_path TO ag_catalog, crm, public');
    const r = await fn(client);
    await client.query('COMMIT');
    return r;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    _available = false;
    emit('trace', 'age-unavailable', { error: String(e?.message || e) });
    recordFailure('age-unavailable', e);
    throw e;
  } finally {
    client.release();
  }
}

// 幂等启用：CREATE EXTENSION + LOAD + create_graph（查 ag_graph 存在再建）
export async function ensureGraph() {
  try {
    await pool.query('CREATE EXTENSION IF NOT EXISTS age');
    await withAgeClient(async (client) => {
      const g = (await client.query('SELECT count(*)::int n FROM ag_catalog.ag_graph WHERE name=$1', [GRAPH_NAME])).rows[0].n;
      if (!g) await client.query('SELECT ag_catalog.create_graph($1)', [GRAPH_NAME]);
    });
    _available = true;
    return { ok: true, available: true };
  } catch (e) {
    _available = false;
    emit('trace', 'age-unavailable', { error: String(e?.message || e) });
    recordFailure('age-unavailable', e);
    return { ok: false, available: false, error: String(e?.message || e) };
  }
}

// 统一 Cypher 执行：查询串经 build() 内联值，外层 $$ 美元引号；RETURN {map} AS v → agtype_to_json
export async function runCypher(queryText, params = {}) {
  const q = build(queryText, params);
  const sql = `SELECT ag_catalog.agtype_to_json(x.v) AS v FROM ag_catalog.cypher('${GRAPH_NAME}', $$ ${q} $$) AS x(v agtype)`;
  return withAgeClient(async (client) => {
    const res = await client.query(sql);
    return res.rows.map((r) => r.v);
  });
}

// ───────────────────── 顶点/边写（决策表同步后旁路调用）─────────────────────
// 写 Decision 顶点（props 全字段 7 点，不写 embedding 减重）
export async function addDecision(d) {
  if (!_available) return { ok: false, skipped: 'age-unavailable' };
  try {
    await runCypher(
      `MERGE (n:Decision {decision_id:$decision_id})
       SET n.scenario_id=$scenario_id, n.disposition=$disposition,
           n.business_tier=$business_tier, n.state=$state,
           n.rationale=$rationale, n.decided_at=$decided_at
       RETURN {ok:true} AS v`,
      {
        decision_id: String(d.decision_id),
        scenario_id: d.scenario_id || '',
        disposition: d.disposition || '',
        business_tier: d.business_tier || '',
        state: d.state || '',
        rationale: d.rationale || '',
        decided_at: d.decided_at ? String(d.decided_at) : null,
      }
    );
    return { ok: true };
  } catch (e) {
    emit('trace', 'decision-graph-sync-failed', { decision_id: String(d.decision_id), error: String(e?.message || e) });
    recordFailure('decision-graph-sync-failed', e);
    return { ok: false, error: String(e?.message || e) };
  }
}

// 业务粒子顶点（label 消毒；id 形如 DEAL:D1）
export async function addParticleVertex(entityType, id, name = '') {
  if (!_available) return { ok: false, skipped: 'age-unavailable' };
  const label = safeLabel(entityType);
  try {
    await runCypher(
      `MERGE (p:${label} {entity_id:$entity_id}) SET p.name=$name RETURN {ok:true} AS v`,
      { entity_id: String(id), name }
    );
    return { ok: true };
  } catch (e) {
    emit('trace', 'decision-graph-sync-failed', { entity_id: String(id), error: String(e?.message || e) });
    recordFailure('decision-graph-sync-failed', e);
    return { ok: false, error: String(e?.message || e) };
  }
}

// 加边：from/to 可为决策 uuid（字符串）或 {id,label} 粒子；relType 消毒
// 边类型（设计 §4.1）：DECIDED_ON / REFERENCED_PRECEDENT / DERIVED_FROM_EXCEPTION / ESTABLISHES_FRAME / OVERRIDES / CAUSED / INFLUENCED
// toLabel 可选（DERIVED_FROM_EXCEPTION 等 to 端为业务/异常顶点时显式给标签）：
//   裸字符串 + 无 toLabel → :Decision {decision_id}（决策→决策，6 类）；裸字符串 + toLabel → :<Label> {entity_id}（决策→异常，与 addParticleVertex 键一致）
export async function addEdge(relType, from, to, props = {}, { toLabel = null } = {}) {
  if (!_available) return { ok: false, skipped: 'age-unavailable' };
  const rel = safeLabel(relType);
  const fromId = typeof from === 'string' ? String(from) : String(from.id);
  const toId = typeof to === 'string' ? String(to) : String(to.id);
  const fromLabel = typeof from === 'string' ? ':Decision' : ':' + safeLabel(from.label || 'Entity');
  const toLabelSel = toLabel ? ':' + safeLabel(toLabel) : (typeof to === 'string' ? ':Decision' : ':' + safeLabel(to.label || 'Entity'));
  const toKey = toLabel ? 'entity_id' : (typeof to === 'string' ? 'decision_id' : 'entity_id');
  try {
    await runCypher(
      `MERGE (a${fromLabel} {${typeof from === 'string' ? 'decision_id' : 'entity_id'}:$fromId})
       MERGE (b${toLabelSel} {${toKey}:$toId})
       MERGE (a)-[r:${rel} {kind:$kind}]->(b)
       SET r.edge_ts=$edge_ts
       RETURN {ok:true} AS v`,
      { fromId, toId, kind: JSON.stringify(props), edge_ts: new Date().toISOString() }
    );
    return { ok: true };
  } catch (e) {
    emit('trace', 'decision-graph-sync-failed', { rel, error: String(e?.message || e) });
    recordFailure('decision-graph-sync-failed', e);
    return { ok: false, error: String(e?.message || e) };
  }
}

// ───────────────────── 多跳查询（AGE 主路）─────────────────────
// AGE 1.6.0 限制：变长关系模式不支持类型交替(|)与通配(*)，仅支持单类型 [:TYPE*1..N]。
// 故对 4 类决策间因果边逐类型查询后合并（按 node_id 取最小距离）。
const CAUSAL_TYPES = ['OVERRIDES', 'REFERENCED_PRECEDENT', 'CAUSED', 'INFLUENCED', 'ESTABLISHES_FRAME'];

// 上游（为什么）：从 id 出发沿决策→决策边向外（id 是起点，返回末端先例节点）
export async function traceUpstream(id, { maxDepth = 3 } = {}) {
  if (!_available) return ctePrecedents(id, { maxDepth, direction: 'upstream' });
  const depth = Math.max(1, Math.min(6, Number(maxDepth) || 3));
  const idStr = String(id);
  const best = new Map();
  for (const t of CAUSAL_TYPES) {
    const rows = await runCypher(
      `MATCH p=(a:Decision {decision_id:$id})-[:${t}*1..${depth}]->(b:Decision)
       RETURN {node_id:b.decision_id, node_state:b.state, node_disposition:b.disposition, dist:length(p)} AS v`,
      { id: idStr }
    );
    for (const r of rows) {
      const nid = r.node_id;
      const dist = Number(r.dist);
      if (!best.has(nid) || dist < best.get(nid).distance) {
        best.set(nid, { decision_id: nid, state: r.node_state || null, disposition: r.node_disposition || null, distance: dist });
      }
    }
  }
  return [...best.values()].map((n) => ({
    ...n, relation: 'UPSTREAM', confidence: Math.pow(0.9, n.distance),
  }));
}

// 下游（导致了什么）：指向 id 的决策（id 是终点，返回起点后继节点）
export async function traceDownstream(id, { maxDepth = 3 } = {}) {
  if (!_available) return ctePrecedents(id, { maxDepth, direction: 'downstream' });
  const depth = Math.max(1, Math.min(6, Number(maxDepth) || 3));
  const idStr = String(id);
  const best = new Map();
  for (const t of CAUSAL_TYPES) {
    const rows = await runCypher(
      `MATCH p=(a:Decision)-[:${t}*1..${depth}]->(b:Decision {decision_id:$id})
       RETURN {node_id:a.decision_id, node_state:a.state, node_disposition:a.disposition, dist:length(p)} AS v`,
      { id: idStr }
    );
    for (const r of rows) {
      const nid = r.node_id;
      const dist = Number(r.dist);
      if (!best.has(nid) || dist < best.get(nid).distance) {
        best.set(nid, { decision_id: nid, state: r.node_state || null, disposition: r.node_disposition || null, distance: dist });
      }
    }
  }
  return [...best.values()].map((n) => ({
    ...n, relation: 'DOWNSTREAM', confidence: Math.pow(0.9, n.distance),
  }));
}

// 影响地图（下游全节点聚合，C2 复用）
export async function impactMap(id, { maxDepth = 3 } = {}) {
  const nodes = await traceDownstream(id, { maxDepth });
  const edges = nodes.map((n) => ({ from: String(id), to: n.decision_id, depth: n.distance }));
  return {
    root: String(id),
    nodes,
    edges,
    depth: nodes.reduce((m, n) => Math.max(m, n.distance), 0),
  };
}

// ───────────────────── 降级路径：递归 CTE（AGE 不可用时多跳仍可答；决策表写权威）─────────────────────
// decision_precedent_rel 语义：(decision_id) 引用 (precedent_id) 为先例 → 即 decision_id 的上游是 precedent_id
export async function ctePrecedents(id, { maxDepth = 3, direction = 'upstream' } = {}) {
  const depth = Math.max(1, Math.min(6, Number(maxDepth) || 3));
  const idStr = String(id);
  const sql = direction === 'upstream'
    ? `WITH RECURSIVE chain AS (
         SELECT decision_id, precedent_id, similarity, 1 AS depth, ARRAY[decision_id::text] AS path
         FROM crm.decision_precedent_rel WHERE decision_id = $1
         UNION ALL
         SELECT r.decision_id, r.precedent_id, r.similarity, c.depth + 1, c.path || r.decision_id::text
         FROM crm.decision_precedent_rel r JOIN chain c ON r.decision_id = c.precedent_id
         WHERE c.depth < $2 AND NOT (r.precedent_id::text = ANY (c.path))
       )
       SELECT DISTINCT precedent_id AS node_id, similarity, depth
       FROM chain WHERE precedent_id IS NOT NULL`
    : `WITH RECURSIVE chain AS (
         SELECT decision_id, precedent_id, similarity, 1 AS depth, ARRAY[precedent_id::text] AS path
         FROM crm.decision_precedent_rel WHERE precedent_id = $1
         UNION ALL
         SELECT r.decision_id, r.precedent_id, r.similarity, c.depth + 1, c.path || r.precedent_id::text
         FROM crm.decision_precedent_rel r JOIN chain c ON r.precedent_id = c.decision_id
         WHERE c.depth < $2 AND NOT (r.decision_id::text = ANY (c.path))
       )
       SELECT DISTINCT decision_id AS node_id, similarity, depth
       FROM chain WHERE decision_id IS NOT NULL`;
  const r = await pool.query(sql, [idStr, depth]);
  return r.rows
    .filter((row) => String(row.node_id) !== idStr)
    .map((row) => ({
      decision_id: row.node_id,
      relation: direction === 'upstream' ? 'UPSTREAM' : 'DOWNSTREAM',
      distance: Number(row.depth),
      confidence: Math.pow(0.9, Number(row.depth)),
      edge_similarity: row.similarity == null ? null : Number(row.similarity),
    }));
}
