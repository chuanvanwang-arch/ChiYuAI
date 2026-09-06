// src/decision/relation.js — 决策边权威层（T2，G1）
// 单一事实源：PG crm.decision_relation 为权威；AGE 仅镜像（降级时仍可读全 7 类边）。
// 写：linkDecisions() 双写 AGE + PG；读：listTypedEdges()/getTypedEdges() 走 PG。
import { queryWrite, query as defaultQuery } from '../db.js';
import { primaryDimension, loadEdgeDimensionSpecFromConfig } from './edgeDimensionSpec.js';
import { DEMO_EDGE_SOURCES } from './edgeSource.js'; // T0(BG-04) 边来源口径隔离
import { mirrorEdge } from './edgeWrite.js';         // T2(BG-06) 边写降级留痕单一入口
import { emit } from '../events/bus.js';
import { recordFailure } from '../monitor/monitorStore.js';

// T32：模块级懒加载缓存——首写边时读一次 config_store['seven-dim'].edge_bindings，
//   之后复用（config 变更经七维页签写后需重启才生效；热更新为后续增强项）。
//   fail-safe：配置缺失/校验失败→回退默认 spec，绝不阻断写边（铁律：边写是业务主路径）。
let edgeSpecCache = null;
export async function loadEdgeSpecOnce({ query: q = defaultQuery } = {}) {
  if (edgeSpecCache) return edgeSpecCache;
  try {
    // 租户化（T5，P1）：关系边是决策图谱的治理面，边规范读 system 基线（平台基线语义）。
    //   方案 A 刻意保留裸 SQL + 注入式 {query} 契约（兼容既有注入测试）；
    //   租户覆盖走 configRouter 写 (tenant,key)，本缓存仅读 system——
    //   租户敏感时由调用方显式调 invalidateEdgeSpecCache() 失效（既有函数，T32 职责扩展）。
    const r = await q(`SELECT value FROM crm.config_store WHERE key=$1`, ['seven-dim']); // 兼容注入式 q 的签名
    const cfg = r?.rows?.[0]?.value || null;
    const loaded = loadEdgeDimensionSpecFromConfig(cfg);
    edgeSpecCache = { spec: loaded.spec, loaded: loaded.loaded, errors: loaded.errors, tenantId: 'system' };
  } catch (e) {
    edgeSpecCache = { spec: null, loaded: false, errors: [e?.message], tenantId: 'system' }; // fail-safe → 默认
  }
  return edgeSpecCache;
}
export function invalidateEdgeSpecCache() {
  edgeSpecCache = null;
}

export const REL_TYPES = ['DECIDED_ON', 'REFERENCED_PRECEDENT', 'DERIVED_FROM_EXCEPTION', 'ESTABLISHES_FRAME', 'OVERRIDES', 'CAUSED', 'INFLUENCED'];

export function isValidRelType(t) {
  return REL_TYPES.includes(t);
}

// 单写入口：双写 AGE（镜像）+ PG（权威）。serves_dimension 缺省取 edgeDimensionSpec 主维度。
// T32：edgeSpecOverride 可注入已加载的 spec（测试/调用方显式传）；不传则用模块级缓存（配置覆盖生效）。
export async function linkDecisions(fromId, toId, relType, { servesDimension = null, props = {}, source = 'engine', edgeSpecOverride = null, toLabel = null } = {}) {
  if (!isValidRelType(relType)) throw new Error(`非法 rel_type: ${relType}`);
  if (!fromId || !toId) throw new Error('linkDecisions 需要 from_id/to_id');
  const spec = edgeSpecOverride || edgeSpecCache?.spec;
  const sd = servesDimension || primaryDimension(relType, spec || undefined);
  // PG 权威写（幂等：同 from/to/type 不重复）
  // T2(BG-06)：权威表写失败同样留痕（边是真丢了，不是降级），留痕后仍抛出由调用方决定
  try {
    await queryWrite(
      `INSERT INTO crm.decision_relation (from_id, to_id, rel_type, serves_dimension, props, source)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (from_id, to_id, rel_type) DO NOTHING`,
      [fromId, toId, relType, sd, JSON.stringify(props), source]
    );
  } catch (e) {
    emit('trace', 'decision-relation-write-failed', {
      from_id: fromId, to_id: toId, rel_type: relType, error: String(e?.message || e),
    });
    recordFailure('decision-relation-write-failed', e);
    throw e;
  }
  // AGE 镜像（降级不阻断主写，但必须留痕——BG-06 原缺陷：不可用时静默 return）
  const mirror = await mirrorEdge(relType, String(fromId), String(toId), props, { decision_id: fromId, toLabel });
  return { fromId, toId, relType, servesDimension: sd, mirror };
}

// 读：PG 权威（AGE 关时仍可查全 7 类边）。direction: 'out'|'in'|'both'
// T0(BG-04)：runtimeOnly=true 时仅返回运行时真实边（排除 source='seed-script' 等演示/种子边），
//   用于存在性判定与边合规分母，杜绝「演示边充真实边」假绿。默认返回全量（含演示边，供前端虚线展示）。
export async function listTypedEdges(entityId, { direction = 'both', runtimeOnly = false, query = defaultQuery } = {}) {
  if (!entityId) return [];
  let where;
  if (direction === 'out') where = 'from_id=$1';
  else if (direction === 'in') where = 'to_id=$1';
  else where = '(from_id=$1 OR to_id=$1)';
  const params = [entityId];
  if (runtimeOnly) {
    // 仅运行时边：显式来源非空且不在演示来源清单内；NULL 来源不计入真实供给（来源必须可追溯）。
    // 双口径权威排除：同时排除 props.demo=true 软标记边（BG-04 Q5：seed 演示边走 props.demo=true 软标记，禁 DELETE）。
    where += ` AND source IS NOT NULL AND source <> ALL($${params.length + 1}::text[]) AND (props->>'demo' IS NULL OR props->>'demo' <> 'true')`;
    params.push(DEMO_EDGE_SOURCES);
  }
  // to_id 已放宽为 TEXT（BG-03 方案 B：异常/粒子 id 可非 UUID）；
  // 两侧列类型不同（from_id=uuid, to_id=text），统一用 ::text 显式比较，兼容 both/out/in 三种方向。
  if (direction === 'out' || direction === 'both') where = where.replace('from_id=$1', 'from_id::text=$1::text');
  if (direction === 'in' || direction === 'both') where = where.replace('to_id=$1', 'to_id::text=$1::text');
  const r = await query(
    `SELECT rel_id, from_id, to_id, rel_type, serves_dimension, props, source, created_at
     FROM crm.decision_relation WHERE ${where} ORDER BY created_at DESC`,
    params
  );
  return r.rows;
}

// 富化 trace 结果为带 rel_type 的 typed 边（供 Cytoscape / 巡检卡）
export function enrichTraceWithRelType(traceNodes, edges) {
  const byId = new Map(traceNodes.map((n) => [String(n.decision_id), n]));
  const typed = (edges || []).map((e) => ({
    from: String(e.from_id),
    to: String(e.to_id),
    rel_type: e.rel_type,
    serves_dimension: e.serves_dimension,
    props: e.props || {},
  }));
  return { nodes: traceNodes, typedEdges: typed, edgeCount: typed.length };
}
