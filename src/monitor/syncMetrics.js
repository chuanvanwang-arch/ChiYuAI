// src/monitor/syncMetrics.js — 同步可观测聚合（T07）
// 设计输入：docs/2026-09-15-final-design-coexistence-and-proactive.md §T07
// 指标：lag（距上次 run 时长）/ success_rate / conflict（conflicted 计数）/ writeback（L3 回写信号）
// 隔离：按 tenant_id 过滤；失败轮次计入 degraded/failed 且不静默
export async function getSyncMetrics({ pool, tenantId = '*' } = {}) {
  const { rows } = await pool.query(
    `SELECT tenant_id, provider, external_object, last_status, last_run_at, last_counts, token_cost
     FROM crm.sync_cursor
     WHERE ($1 = '*' OR tenant_id = $1)
     ORDER BY last_run_at DESC NULLS LAST`,
    [tenantId],
  );
  const now = Date.now();
  const items = (rows || []).map(r => {
    const counts = r.last_counts || {};
    return {
      tenant_id: r.tenant_id, provider: r.provider, object: r.external_object,
      status: r.last_status,
      lag_ms: r.last_run_at ? now - new Date(r.last_run_at).getTime() : null,
      read: counts.read ?? 0, created: counts.created ?? 0,
      updated: counts.updated ?? 0, skipped: counts.skipped ?? 0,
      conflicted: counts.conflicted ?? 0, token_cost: Number(r.token_cost || 0),
    };
  });
  const total = items.length || 1;
  const okCount = items.filter(i => i.status === 'ok').length;
  const lagList = items.filter(i => i.lag_ms != null).map(i => i.lag_ms);
  return {
    rows: items,
    lag: lagList.length ? lagList.reduce((a, b) => a + b, 0) / lagList.length : 0,
    success_rate: okCount / total,
    conflict: items.reduce((a, b) => a + b.conflicted, 0),
    writeback: 0, // L3 回写未启用时恒 0（T04 落地后接真值）
    degraded: items.filter(i => i.status === 'degraded' || i.status === 'failed').length,
  };
}
