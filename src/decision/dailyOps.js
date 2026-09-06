// src/decision/dailyOps.js — 整改报告「本日任务执行情况」三源聚合（设计 §16.2 / 计划 Task 11 Step 2）
// 数据源：crm.decision（当日决策）/ crm.tasks（kanban 调度执行）/ crm.agent_sla（智能体健康度快照）。
// 铁律：只读查询、禁 DELETE；窗口为半开区间 [window_start, window_end)。
// 计划缺陷修正（evidence-driven，相对 plan 原文 SQL）：
//   #5 crm.decision 无 autonomy 列 → 自主/升级口径改用 decider_type
//      （'AUTONOMOUS_AGENT'/'HUMAN'，与 src/calibration/metrics.js 官方口径一致，schema.sql 无 autonomy）；
//   #6 crm.tasks.status CHECK 枚举为 ready/running/done/failed/blocked（schema.sql），无 'timeout' 态
//      → 设计 §16.2 槽位 timeout 由 blocked 计数承载（受阻/超期待关注的等价状态）。
import { query } from '../db.js';

// 纯函数：执行结论（失败/受阻 > 0 → 提示关注；否则执行平稳）。入参为聚合原始行（pg 计数为字符串）。
export function buildVerdict(d = {}, t = {}) {
  const failed = +t.failed || 0;
  const blocked = +t.timeout || 0;
  const bad = failed + blocked;
  if (bad > 0) {
    return `执行待关注：${bad} 条 agent 任务失败/受阻（failed=${failed}、blocked=${blocked}）`;
  }
  return '执行平稳，未见失败或受阻任务';
}

/**
 * 聚合窗口内三源运行情况。
 * @param {object|null} pool 可选连接池（提供 query 方法时走 pool，否则走 db.js 全局 query）
 * @param {{window_start: string, window_end: string}} w ISO 时间窗（半开区间）
 * @returns {Promise<{window,decisions,agent_tasks,agent_sla,verdict}>} §16.2 daily_ops 结构
 */
export async function summarizeDailyOps(pool, { window_start, window_end }) {
  const run = (sql, params) => (pool?.query ? pool.query(sql, params) : query(sql, params));

  const dec = await run(
    `SELECT
        COUNT(*) FILTER (WHERE decider_type = 'AUTONOMOUS_AGENT')  AS autonomous,
        COUNT(*) FILTER (WHERE decider_type <> 'AUTONOMOUS_AGENT') AS escalated,
        COUNT(*)                                                    AS total,
        COALESCE(AVG(confidence), 0)                                AS avg_confidence
      FROM crm.decision WHERE decided_at >= $1 AND decided_at < $2`,
    [window_start, window_end]
  );
  const tasks = await run(
    `SELECT
        COUNT(*) FILTER (WHERE status = 'done')    AS completed,
        COUNT(*) FILTER (WHERE status = 'blocked') AS timeout,
        COUNT(*) FILTER (WHERE status = 'failed')  AS failed,
        COUNT(*)                                    AS scheduled
      FROM crm.tasks WHERE updated_at >= $1 AND updated_at < $2`,
    [window_start, window_end]
  );
  const sla = await run(
    `SELECT auditability_pct, tampered_count, q1_pass FROM crm.agent_sla
      WHERE measured_at >= $1 ORDER BY measured_at DESC LIMIT 1`,
    [window_start]
  );

  const d = dec.rows?.[0] || {};
  const t = tasks.rows?.[0] || {};
  const s = sla.rows?.[0] || {};
  return {
    window: `${window_start}~${window_end}`,
    decisions: {
      total: +d.total || 0,
      autonomous: +d.autonomous || 0,
      escalated: +d.escalated || 0,
      avg_confidence: +(+d.avg_confidence || 0).toFixed(2),
    },
    agent_tasks: {
      scheduled: +t.scheduled || 0,
      completed: +t.completed || 0,
      timeout: +t.timeout || 0,
      failed: +t.failed || 0,
    },
    agent_sla: {
      auditability_pct: +(s.auditability_pct || 0),
      tampered: +s.tampered_count || 0,
      q1_pass: +s.q1_pass || 0,
    },
    verdict: buildVerdict(d, t),
  };
}
