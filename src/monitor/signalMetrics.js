// src/monitor/signalMetrics.js — 信号链路观测聚合（T20）
// 设计输入：docs/2026-09-15-final-design-coexistence-and-proactive.md §T20
// 指标：delivery_success_rate / avg_latency_ms / conflict / execution_volume（按 tenant_id 隔离）
// 负向判据：delivery_silent（无投递行但渠道为 on）/ gen_silent（hits>0 而新增 signal=0）
// 降级追溯：getDowngradeEvents（paused 凭证 + rejected 执行）
// 纪律：全部查询带 tenant_id（租户隔离）；无投递尝试时 success_rate=null（防假绿）；零 DELETE
import { query } from '../db.js';
import { createAlert } from '../alerts/alertStore.js';
import { emit } from '../events/bus.js';

const DEFAULT_CHANNELS = ['inbox', 'email', 'im', 'webhook'];

// getSignalMetrics({ tenantId, since }) — 全部聚合带 tenant_id（租户隔离）
export async function getSignalMetrics({ tenantId, since }) {
  const sinceTs = since instanceof Date ? since : new Date(since);
  const { rows: [d] } = await query(
    `SELECT
       COUNT(*) FILTER (WHERE status='sent') AS sent,
       COUNT(*) FILTER (WHERE status='failed') AS failed,
       COUNT(*) FILTER (WHERE status='skipped') AS skipped,
       COUNT(*) AS total,
       AVG(EXTRACT(EPOCH FROM (delivered_at - created_at)) * 1000)
         FILTER (WHERE status='sent' AND delivered_at IS NOT NULL) AS avg_latency_ms
     FROM crm.signal_delivery WHERE tenant_id=$1 AND created_at >= $2`,
    [tenantId, sinceTs]
  );
  const delivery = d || { sent: 0, failed: 0, skipped: 0, total: 0, avg_latency_ms: null };
  const sent = Number(delivery.sent || 0);
  const failed = Number(delivery.failed || 0);
  const attempted = sent + failed;
  const success_rate = attempted > 0 ? sent / attempted : null; // 无尝试→null（防假绿）

  const { rows: ch } = await query(
    `SELECT channel,
       COUNT(*) FILTER (WHERE status='sent') AS sent,
       COUNT(*) FILTER (WHERE status='failed') AS failed,
       COUNT(*) FILTER (WHERE status='skipped') AS skipped,
       COUNT(*) AS total
     FROM crm.signal_delivery WHERE tenant_id=$1 AND created_at >= $2 GROUP BY channel`,
    [tenantId, sinceTs]
  );
  const by_channel = (ch || []).map(r => ({
    channel: r.channel,
    sent: Number(r.sent || 0), failed: Number(r.failed || 0),
    skipped: Number(r.skipped || 0), total: Number(r.total || 0),
  }));

  const { rows: [ex] } = await query(
    `SELECT COUNT(*) AS execution_volume FROM crm.grant_execution WHERE tenant_id=$1 AND created_at >= $2`,
    [tenantId, sinceTs]
  );
  const { rows: [sg] } = await query(
    `SELECT COUNT(*) AS signal_count FROM crm.signal WHERE tenant_id=$1 AND created_at >= $2`,
    [tenantId, sinceTs]
  );
  return {
    tenant_id: tenantId,
    since: sinceTs.toISOString(),
    delivery_success_rate: success_rate,
    avg_latency_ms: delivery.avg_latency_ms != null ? Number(delivery.avg_latency_ms) : null,
    conflict: failed + Number(delivery.skipped || 0),     // failed+skipped 视为投递侧冲突/损失
    execution_volume: Number(ex?.execution_volume || 0),
    signal_count: Number(sg?.signal_count || 0),
    delivery: { sent, failed, skipped: Number(delivery.skipped || 0), total: Number(delivery.total || 0) },
    by_channel,
  };
}

// detectNegativePredicates({ tenantId, since, enabledChannels=DEFAULT_CHANNELS })
// → [{type:'delivery_silent',channel,tenant_id}] | [{type:'gen_silent',tenant_id,fired}]
// 判据 A：无投递行但渠道为 on（enabledChannels 视为 on）
// 判据 B：hits>0 而新增 signal=0（event-trigger 命中但无内部信号生成 = 摄取→信号桥静默）
export async function detectNegativePredicates({ tenantId, since, enabledChannels = DEFAULT_CHANNELS }) {
  const sinceTs = since instanceof Date ? since : new Date(since);
  const { rows: [sg] } = await query(
    `SELECT COUNT(*) AS c FROM crm.signal WHERE tenant_id=$1 AND created_at >= $2`,
    [tenantId, sinceTs]
  );
  const signalCount = Number(sg?.c || 0);
  const alerts = [];
  if (signalCount > 0) {
    const { rows: ch } = await query(
      `SELECT channel, COUNT(*) AS c FROM crm.signal_delivery
       WHERE tenant_id=$1 AND created_at >= $2 GROUP BY channel`,
      [tenantId, sinceTs]
    );
    const delivered = new Set((ch || []).map(r => r.channel));
    for (const name of enabledChannels) {
      if (!delivered.has(name)) alerts.push({ type: 'delivery_silent', channel: name, tenant_id: tenantId });
    }
  }
  const { rows: [fired] } = await query(
    `SELECT COUNT(*) AS c FROM crm.signal
     WHERE tenant_id=$1 AND source='event-trigger' AND created_at >= $2`,
    [tenantId, sinceTs]
  );
  const firedCount = Number(fired?.c || 0);
  if (firedCount > 0) {
    const { rows: [landed] } = await query(
      `SELECT COUNT(*) AS c FROM crm.signal
       WHERE tenant_id=$1 AND source IN ('rule-scan','agent-research','external') AND created_at >= $2`,
      [tenantId, sinceTs]
    );
    if (Number(landed?.c || 0) === 0) alerts.push({ type: 'gen_silent', tenant_id: tenantId, fired: firedCount });
  }
  return alerts;
}

// getDowngradeEvents({ tenantId, since }) — 降级（paused）凭证 + 近期 rejected 执行（追溯链）
export async function getDowngradeEvents({ tenantId, since }) {
  const sinceTs = since instanceof Date ? since : new Date(since);
  const { rows: grants } = await query(
    `SELECT grant_id, tenant_id, title, risk_tier, status, paused_at, paused_reason
     FROM crm.standing_grant
     WHERE tenant_id=$1 AND status='paused' AND (paused_at IS NULL OR paused_at >= $2)
     ORDER BY paused_at DESC NULLS LAST`,
    [tenantId, sinceTs]
  );
  const { rows: execs } = await query(
    `SELECT execution_id, grant_id, hitl_verdict, rejected_at
     FROM crm.grant_execution
     WHERE tenant_id=$1 AND hitl_verdict='rejected' AND created_at >= $2
     ORDER BY created_at DESC`,
    [tenantId, sinceTs]
  );
  return {
    paused_grants: (grants || []).map(r => ({
      ...r, paused_at: r.paused_at ? new Date(r.paused_at).toISOString() : null,
    })),
    rejected_executions: (execs || []).map(r => ({ ...r })),
  };
}

// createSignalObservabilitySweep({ windowHours }) — 定时巡检：逐租户跑负向判据，命中即 createAlert + emit trace
// 供 scheduler/timers.js 定时器⑯调用（VITEST 护栏由调用方负责）；单租户失败不静默（emit trace）
export function createSignalObservabilitySweep({ windowHours = 24 } = {}) {
  return {
    async sweepOnce() {
      const { rows } = await query(`SELECT DISTINCT tenant_id FROM crm.signal WHERE tenant_id <> 'system'`);
      const since = new Date(Date.now() - windowHours * 3600 * 1000);
      let fired = 0;
      for (const { tenant_id } of rows) {
        try {
          const alerts = await detectNegativePredicates({ tenantId: tenant_id, since });
          for (const a of alerts) {
            createAlert({
              kind: 'signal-observability', severity: 'high', target_role: 'ops', tenant_id,
              payload: { predicate: a.type, channel: a.channel || null, fired: a.fired || null },
            });
            emit('trace', 'signal-observability-alert', { tenant_id, ...a });
            fired++;
          }
        } catch (e) {
          emit('trace', 'signal-observability-scan-failed', { tenant_id, error: String(e?.message || e) });
        }
      }
      return { fired, tenants: rows.length };
    },
  };
}
