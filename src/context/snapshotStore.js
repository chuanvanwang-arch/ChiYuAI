// src/context/snapshotStore.js — 决策上下文供给快照读取 + 平台供给健康聚合（只读，供 Phase4 前台）
// 设计：docs/2026-09-01-decision-accountability-unified-design.md §4.3/§5（快照落库 + 三层一屏 Layer0）
// 双口径防假绿（BG-04）：边计数分离 运行时 / 演示，演示不计入供给健康分母。
import { query } from '../db.js';
import { DEMO_EDGE_SOURCES, isDemoEdgeSource } from '../decision/edgeSource.js';

// 读取某决策最新一次上下文供给快照（装配即审计闭环，文章核心命题「决策依据不能重新生成」）
export async function getDecisionContextSnapshot(decisionId, { q = query } = {}) {
  if (!decisionId) return null;
  const r = await q(
    `SELECT snapshot_id, assembly_id, decision_id, actor, scenario_id, query_text, ops, dim_coverage,
            supplied_dims, degraded, prompt_block, prompt_hash, token_est, cost_ms, phase, created_at
     FROM crm.decision_context_snapshot
     WHERE decision_id=$1 ORDER BY created_at DESC LIMIT 1`,
    [decisionId]
  );
  const row = r.rows[0];
  if (!row) return null;
  // 篡改自检：prompt_block 重新哈希与 prompt_hash 比对
  let tamper = null;
  try {
    const { createHash } = await import('node:crypto');
    const recomputed = createHash('sha256').update(row.prompt_block || '').digest('hex').slice(0, 32);
    tamper = recomputed === row.prompt_hash ? 'OK' : 'TAMPERED';
  } catch { tamper = 'UNKNOWN'; }
  return { ...row, tamper };
}

// 平台级供给健康聚合（Layer0「上下文供给 N/7」单一事实源）
// N/7 来自真实快照的运行时供给（非 seed 假绿）；边双口径来自 decision_relation 全表分离。
export async function getPlatformSupplyHealth({ q = query } = {}) {
  // 1) 各决策最新快照的维覆盖（运行时真实供给）——取每 decision_id 最新一行
  const snap = await q(
    `SELECT decision_id, supplied_dims, dim_coverage, degraded
     FROM crm.decision_context_snapshot
     WHERE decision_id IS NOT NULL
     ORDER BY decision_id, created_at DESC`
  );
  const latest = new Map();
  for (const row of snap.rows) {
    if (!latest.has(row.decision_id)) latest.set(row.decision_id, row);
  }
  const decisionsWithSnapshot = latest.size;
  let suppliedSum = 0;
  let degradedCount = 0;
  const dimUnion = {}; // 维度 → 多少决策供给了该维（分子）
  for (const row of latest.values()) {
    suppliedSum += Number(row.supplied_dims || 0);
    if (row.degraded) degradedCount += 1;
    const dc = row.dim_coverage || {};
    for (const [dim, v] of Object.entries(dc)) {
      if (v && v.supplied) dimUnion[dim] = (dimUnion[dim] || 0) + 1;
    }
  }
  const dimCoverage = Object.fromEntries(
    Object.keys(dimUnion).map((d) => [d, { supplied: dimUnion[d], total: decisionsWithSnapshot }])
  );
  const supplyN7 = decisionsWithSnapshot ? Number((suppliedSum / (decisionsWithSnapshot * 7) * 100).toFixed(1)) : 0;

  // 2) 边双口径（运行时 vs 演示）——全表分离，演示不计入供给健康分母
  const ec = await q(
    `SELECT
       count(*) FILTER (WHERE source IS NOT NULL AND source <> ALL($1::text[])) AS runtime,
       count(*) FILTER (WHERE source IS NULL OR source = ALL($1::text[])) AS demo
     FROM crm.decision_relation`,
    [DEMO_EDGE_SOURCES]
  ).catch(() => ({ rows: [{ runtime: 0, demo: 0 }] }));
  const runtimeCount = Number(ec.rows[0]?.runtime || 0);
  const demoCount = Number(ec.rows[0]?.demo || 0);

  return {
    decisions_with_snapshot: decisionsWithSnapshot,
    supply_n7_pct: supplyN7,
    supplied_dims_total: suppliedSum,
    degraded_count: degradedCount,
    dim_coverage: dimCoverage,
    edge_caliber: { runtime: runtimeCount, demo: demoCount, total: runtimeCount + demoCount },
  };
}

// 给决策清单批量附带 supplied_dims（N/7 列，来自快照，零重算）
// 返回 Map<decision_id, supplied_dims>
export async function getSnapshotSuppliedMap(decisionIds = [], { q = query } = {}) {
  if (!decisionIds.length) return new Map();
  const r = await q(
    `SELECT DISTINCT ON (decision_id) decision_id, supplied_dims
     FROM crm.decision_context_snapshot
     WHERE decision_id = ANY($1::uuid[])
     ORDER BY decision_id, created_at DESC`,
    [decisionIds]
  );
  const m = new Map();
  for (const row of r.rows) m.set(row.decision_id, Number(row.supplied_dims || 0));
  return m;
}

export { isDemoEdgeSource };
