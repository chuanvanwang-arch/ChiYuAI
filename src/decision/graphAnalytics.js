// src/decision/graphAnalytics.js — P6 图分析：度数中心度 + 下游影响规模
// 设计输入：docs/superpowers/specs/2026-08-26-age-semantica-program-design.md P6
// AGE 主路（Cypher 度数）+ 降级（decision_precedent_rel 递归 CTE 度数），保持与既有降级纪律一致。
import { pool } from '../db.js';
import { isAvailable, runCypher } from './ageGraph.js';

// AGE 主路：度数（AGE 1.6.0 不支持无向 -(r)-，故出/入两向分别计数后求和）
async function cypherDegree(id) {
  const out = await runCypher(
    `MATCH (n:Decision {decision_id:$id})-[r]->(m:Decision) RETURN {deg: count(r)} AS v`,
    { id: String(id) });
  const inc = await runCypher(
    `MATCH (n:Decision {decision_id:$id})<-[r]-(m:Decision) RETURN {deg: count(r)} AS v`,
    { id: String(id) });
  return Number(out[0]?.deg || 0) + Number(inc[0]?.deg || 0);
}

// 降级：decision_precedent_rel 中作为引用方或被引用方的次数
async function cteDegree(id) {
  const r = await pool.query(
    `SELECT count(*)::int deg FROM crm.decision_precedent_rel
     WHERE decision_id=$1 OR precedent_id=$1`, [String(id)]);
  return r.rows[0].deg;
}

// 度数中心度（入度+出度合计）
export async function degreeCentrality(id) {
  const degree = isAvailable() ? await cypherDegree(id) : await cteDegree(id);
  return { decision_id: String(id), degree };
}

// 下游影响规模（被本决策继承/推翻的决策数，按 maxDepth 多跳）
export async function downstreamImpactSize(id, { maxDepth = 4 } = {}) {
  const { traceDownstream } = await import('./ageGraph.js');
  const down = await traceDownstream(id, { maxDepth });
  return { root: String(id), impacted: down.length };
}
