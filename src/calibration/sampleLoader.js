// src/calibration/sampleLoader.js — 决策样本加载（HTTP 路由与 MCP 工具共用的单一事实源）
// 设计依据：docs/2026-08-28-decision-quality-calibration-design.md §7 + docs/2026-08-30-j2-j3-comprehensive-design.md L185-L190
// 定位：calibrationRouter 私有 loadDecisions 抽取为共享模块，杜绝「HTTP 端点 SQL」与「MCP 工具 SQL」双份漂移。
// 口径：30 天窗口；JOIN decision_event 补 confidence——F7：confidence 在事件 payload，不在 decision 行。
import { query } from '../db.js';

export async function loadDecisions({ scenario_id = null, window_days = 30, limit = 500 } = {}) {
  const where = ['d.created_at >= now() - ($1 || \' days\')::interval'];
  const params = [String(window_days)];
  if (scenario_id) { params.push(scenario_id); where.push(`d.scenario_id=$${params.length}`); }
  params.push(limit);
  const r = await query(
    `SELECT d.*, e.payload->>'confidence' AS conf
     FROM crm.decision d
     LEFT JOIN LATERAL (
       SELECT payload FROM crm.decision_event
       WHERE decision_id=d.decision_id AND event_type IN ('autonomous','escalated')
       ORDER BY created_at DESC LIMIT 1
     ) e ON true
     WHERE ${where.join(' AND ')}
     ORDER BY d.created_at DESC
     LIMIT $${params.length}`,
    params
  );
  // confidence 字符串 → number（无事件为 null，metrics 内过滤）
  return r.rows.map((row) => ({
    ...row,
    confidence: row.conf == null ? null : Number(row.conf),
    referenced_precedents: Array.isArray(row.referenced_precedents) ? row.referenced_precedents : [],
    conditions_evaluated: Array.isArray(row.conditions_evaluated) ? row.conditions_evaluated : [],
    trigger_context: row.trigger_context && typeof row.trigger_context === 'object' ? row.trigger_context : {},
  }));
}