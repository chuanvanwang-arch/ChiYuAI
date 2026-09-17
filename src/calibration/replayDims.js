// src/calibration/replayDims.js — required_dims 处方量化重放（预估七维拦截率）
// 复用 src/sevenDimensions/engine.js 的 sevenDimensionsCheck（不重造）。
// 耦合声明：makeReplayQuery 拦截引擎读取 required_dims 的 SQL 片段
//   `required_dims FROM decision_scenario`（engine.js:12）；若引擎 SQL 改动需同步此处。
import { query } from '../db.js';
import { sevenDimensionsCheck } from '../sevenDimensions/engine.js';

// 复放用 query：拦截 sevenDimensionsCheck 的 required_dims 读取，返回 toRequiredDims（其余委托真实 query）
function makeReplayQuery(toRequiredDims, realQ) {
  return async (sql, params) => {
    if (/required_dims FROM decision_scenario/.test(sql)) {
      return { rows: [{ required_dims: toRequiredDims }] };
    }
    return realQ(sql, params);
  };
}

// 对窗口内该 scenario 的历史决策 trigger_context，用 toRequiredDims 重算 missing，统计 block 后拦截率
export async function replayDims(scenarioId, toRequiredDims, windowDays = 30, tenantId = 'system') {
  const r = await query(
    `SELECT decision_id, trigger_context FROM crm.decision
     WHERE scenario_id=$1 AND created_at >= now() - ($2::int || ' days')::interval
     ORDER BY created_at DESC`,
    [scenarioId, windowDays]
  );
  const rows = r.rows;
  const total = rows.length;
  let intercepted_before = 0;
  let intercepted_after = 0;
  for (const row of rows) {
    const ctx = row.trigger_context && typeof row.trigger_context === 'object' ? row.trigger_context : {};
    const before = await sevenDimensionsCheck(scenarioId, ctx, { tenantId });
    const after = await sevenDimensionsCheck(scenarioId, ctx, { query: makeReplayQuery(toRequiredDims, query), tenantId });
    if (!before.allowed) intercepted_before += 1;
    if (!after.allowed) intercepted_after += 1;
  }
  const rate = (n) => (total ? n / total : 0);
  return {
    sample_size: total,
    intercepted_before,
    intercepted_after,
    estimated_block_rate: rate(intercepted_after),
    estimated_block_rate_delta: rate(intercepted_after) - rate(intercepted_before),
  };
}
