// src/decision/decisionTrace.js — C2 决策追溯（因果链/影响地图/洞察统计）
// 设计输入：spec §5.1-C2 / §6.1；数据源：ageGraph（AGE 主路）+ monitorStore.getGateMetrics（统计聚合，不另起炉灶）
import { traceUpstream, traceDownstream, impactMap } from './ageGraph.js';
import { getGateMetrics } from '../monitor/monitorStore.js';
import { listDecisions } from './decisionRepo.js';

// 因果链：upstream（为什么）或 downstream（导致了什么），附带因果距离 + 置信度衰减（每跳 ×0.9）
export async function traceDecision(id, { direction = 'upstream', maxDepth = 3 } = {}) {
  const fn = direction === 'downstream' ? traceDownstream : traceUpstream;
  return fn(id, { maxDepth });
}

// 影响地图：下游全节点（复用 ageGraph.impactMap 的节点+边+深度结构）
export async function getImpact(id, { maxDepth = 3 } = {}) {
  return impactMap(id, { maxDepth });
}

// 洞察统计：per-scenario 自主/升级/逆转分布（复用 getGateMetrics + decision 表 outcome 聚合）
export async function getInsights({ scenario_id = null } = {}) {
  const totals = await getGateMetrics({ scenario_id: scenario_id || undefined });
  const rows = await listDecisions({ scenario_id: scenario_id || null, limit: 100 });
  const reversed = rows.filter((d) => d.outcome === 'REVERSED').length;
  const confirmed = rows.filter((d) => d.state === 'CONFIRMED').length;
  return {
    scenario_id: scenario_id || null,
    totals,
    reversed,
    confirmed,
    reversal_rate: rows.length ? reversed / rows.length : 0,
  };
}
