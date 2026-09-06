// scripts/backfill-age.js — 存量粒子/边/决策 镜像进 AGE（P1 回填；幂等 MERGE，可重跑）
// 运行：node scripts/backfill-age.js
import { query } from '../src/db.js';
import { ensureGraph } from '../src/decision/ageGraph.js';
import { ensureAgeSync } from '../src/ontology/ageSync.js';

async function main() {
  const g = await ensureGraph();
  if (!g.ok) { console.error('[backfill] AGE 不可用，跳过'); process.exit(0); }
  const parts = (await query(`SELECT * FROM crm.particles`)).rows;
  for (const p of parts) await ensureAgeSync(p).catch(() => {});
  const edges = (await query(`SELECT * FROM crm.edges`)).rows;
  for (const e of edges) await ensureAgeSync(e).catch(() => {});
  const decs = (await query(`SELECT * FROM crm.decision`)).rows;
  for (const d of decs) await ensureAgeSync(d).catch(() => {});
  // 决策先例因果边回填（P2）
  const { addEdge } = await import('../src/decision/ageGraph.js');
  const rels = (await query(`SELECT * FROM crm.decision_precedent_rel`)).rows;
  for (const r of rels) {
    await addEdge('REFERENCED_PRECEDENT', String(r.decision_id), String(r.precedent_id),
      { similarity: r.similarity }).catch(() => {});
  }
  // 【P2 补齐】决策↔决策七类边权威回填（decision_relation 为唯一事实源，覆盖 CAUSED/INFLUENCED/ESTABLISHES_FRAME 等全 7 类）
  // 注：DERIVED_FROM_EXCEPTION（决策→异常）不进 decision_relation（异常非 decision），仅 AGE 镜像，无法自 PG 回填。
  const trels = (await query(`SELECT from_id, to_id, rel_type, props FROM crm.decision_relation`)).rows;
  for (const r of trels) {
    await addEdge(r.rel_type, String(r.from_id), String(r.to_id), r.props || {}).catch(() => {});
  }
  console.log(`[backfill] done: particles=${parts.length} edges=${edges.length} decisions=${decs.length} precedent_edges=${rels.length} typed_edges=${trels.length}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
