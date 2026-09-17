// src/monitor/signalMetrics.js — 信号链路观测聚合（T20）
// 设计输入：docs/2026-09-15-final-design-coexistence-and-proactive.md §T20
// 指标：delivery_success_rate / avg_latency_ms / conflict / execution_volume（按 tenant_id 隔离）
// 负向判据：delivery_silent（渠道 on 且窗口内**真静默**＝零行）/ delivery_undelivered（渠道 on、
//   有尝试但**零 sent**，带首位原因）/ gen_silent（hits>0 而新增 signal=0）
// 降级追溯：getDowngradeEvents（paused 凭证 + rejected 执行）
// 纪律：全部查询带 tenant_id（租户隔离）；无投递尝试时 success_rate=null（防假绿）；零 DELETE
import { query } from '../db.js';
import { createAlert } from '../alerts/alertStore.js';
import { emit } from '../events/bus.js';
import { readConfig } from '../config/configStore.js';

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

// detectNegativePredicates({ tenantId, since, enabledChannels })
// → [{type:'delivery_silent',channel,tenant_id,sent,attempted}]
//   | [{type:'delivery_undelivered',channel,tenant_id,sent,attempted,top_error,top_error_count}]
//   | [{type:'gen_silent',tenant_id,fired}]
//
// 判据 A（F-6(a) 修正后分两级，详见下方实现处注释）：
//   ① delivery_silent      = 渠道配置为 on 且窗口内**零行**（attempted=0，真静默）；参与 exportGate。
//   ② delivery_undelivered = 渠道配置为 on、有尝试（attempted>0）但 **零 sent**；**不**参与 exportGate。
//   ⚠ Q1-4 修正（2026-09-16，全链集成设计 v1.1 §3.3）：原实现 `enabledChannels = DEFAULT_CHANNELS`
//   （四渠道硬编码全开）且定时器⑯ 调用时未传参 → **面板上「渠道『email』已开启」是判据自己
//   注入的假前提**（一个防假绿的判据自己制造假绿）。现改为从 config_store['signal-delivery'].channels
//   读取真实启用集合；**读不到配置 → 判据 A 不触发并 emit trace**（不退回「全开」）。
//   显式传 enabledChannels 时仍按传入值工作（供纯逻辑单测，保持向后兼容）。
//
// 判据 B（gen_silent）：event-trigger 命中但无内部信号生成 = 摄取→信号桥静默。
//   ⚠ 与渠道配置无关 —— 故本函数**绝不因配置缺失而提前 return**，否则判据 B 会被连带跳过
//   （既有测试 test/monitor/signalMetrics.test.js 不传 enabledChannels 的用例会转红，
//    且真实静默会被漏报）。
export async function detectNegativePredicates({ tenantId, since, enabledChannels = null, readConfigFn = readConfig }) {
  const sinceTs = since instanceof Date ? since : new Date(since);
  const { rows: [sg] } = await query(
    `SELECT COUNT(*) AS c FROM crm.signal WHERE tenant_id=$1 AND created_at >= $2`,
    [tenantId, sinceTs]
  );
  const signalCount = Number(sg?.c || 0);
  const alerts = [];

  // ── 判据 A：渠道集合解析（配置驱动优先，显式参数其次）──
  let channels = enabledChannels;
  if (channels === null) {
    let cfg = null;
    let readFailed = null;
    try {
      const row = await readConfigFn('signal-delivery', { tenantId });
      cfg = row?.value || null;
    } catch (e) {
      readFailed = String(e?.message || e);
    }
    if (readFailed) {
      // ① **读取失败 ≠ 配置缺失**：分别留痕。否则 DB 故障会被误读成「客户还没配」，
      //    把一个真故障降级成一个"待配置项"（本项目最忌讳的误归因）。
      emit('trace', 'signal-observability-config-read-failed', { tenant_id: tenantId, error: readFailed });
      channels = [];
    } else if (!cfg || !cfg.channels || typeof cfg.channels !== 'object') {
      // ② 读到了但配置缺失 → 不判（留痕），**绝不**回退为默认全开（那正是本次修正消除的假前提）
      emit('trace', 'signal-observability-config-missing', { tenant_id: tenantId });
      channels = [];
    } else {
      channels = Object.entries(cfg.channels)
        .filter(([, v]) => v === 'on' || v === true)
        .map(([k]) => k);
    }
  }

  if (signalCount > 0 && channels.length > 0) {
    // ── F-6(a)（2026-09-16 实测修正）：判据粒度由「有没有行」收紧为「有没有**送达**」，并分两级 ──
    // 原判据：`SELECT channel, COUNT(*) … GROUP BY channel` → 只要该渠道**存在任何行**即视为已投递。
    //   缺陷（真实库实测，属**漏报**）：配置为 on 却**全 skipped**（无收件人 / 静默时段 / 超重试）的渠道
    //   被判**健康** —— 一行都没出去。实况：全库 15 个租户 `email=on` 且**零 sent 行**
    //   （system 1603 / acme-demo 1591 / sim-erp 1505 条 skipped），而本判据对 email **一声不响**；
    //   `exportGate` 判据③ 又以「无本告警」当通过 ⇒ 出口健康度被静默污染。
    //
    // 修正分两级（**为什么要分级**：把两者混为一谈会让告警失去可处置性——见下）：
    //   ① `delivery_silent`（**真静默**）：窗口内该渠道**零行**（attempted=0）——投递层毫无动静，
    //      连"为什么没出去"都没有记录。信息完全缺失 ⇒ 参与 `exportGate` 判据③，**可阻断**出口。
    //   ② `delivery_undelivered`（**有归因的未送达**）：有尝试（attempted>0）但零 sent。这不是静默
    //      ——`no_recipient` 等原因是**明确留痕**的（N2/N3 另有判据保证"失败/跳过必带 last_error"）。
    //      它与①的处置动作完全不同（①查链路是否接通；②补收件人/凭据），故**必须分别报**。
    //      ⚠ **刻意不参与** `exportGate`：若把"某渠道配了 on 但没配收件人"也判出口不健康，
    //      则平台上一旦有人把渠道开关打开而尚未配齐收件人，**全部租户的回写/自治都会被阻断**
    //      ⇒ 闸门变成噪音、被绕过（比漏报更坏的失败模式）。此处保持"真静默才阻断"的原语义。
    //   附带回报 `attempted` 与首位原因 `top_error`：让读告警的人无需再查库即可判断处置方向。
    const { rows: ch } = await query(
      `SELECT channel,
              COUNT(*) FILTER (WHERE status='sent')::int AS sent,
              COUNT(*)::int AS attempted
       FROM crm.signal_delivery
       WHERE tenant_id=$1 AND created_at >= $2
       GROUP BY channel`,
      [tenantId, sinceTs]
    );
    const byChannel = new Map((ch || []).map(r => [r.channel, r]));

    // 只为「零 sent」的渠道取首位原因（正常路径下该集合为空 ⇒ 不产生额外查询）
    const zeroSent = channels.filter(name => Number(byChannel.get(name)?.sent || 0) === 0);
    const topReason = new Map();
    if (zeroSent.length > 0) {
      const { rows: errs } = await query(
        `SELECT channel, last_error, COUNT(*)::int AS c
           FROM crm.signal_delivery
          WHERE tenant_id=$1 AND created_at >= $2 AND status <> 'sent' AND last_error IS NOT NULL
          GROUP BY channel, last_error`,
        [tenantId, sinceTs]
      );
      for (const r of errs || []) {
        const cur = topReason.get(r.channel);
        if (!cur || r.c > cur.c) topReason.set(r.channel, r);
      }
    }

    for (const name of zeroSent) {
      const attempted = Number(byChannel.get(name)?.attempted || 0);
      if (attempted === 0) {
        alerts.push({ type: 'delivery_silent', channel: name, tenant_id: tenantId, sent: 0, attempted: 0 });
      } else {
        const top = topReason.get(name) || null;
        alerts.push({
          type: 'delivery_undelivered', channel: name, tenant_id: tenantId,
          sent: 0, attempted,
          top_error: top?.last_error || null,
          top_error_count: Number(top?.c || 0),
        });
      }
    }
  }

  // ── 判据 B：与渠道配置无关，始终执行 ──
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
//
// ⚠ D1 同族遗漏 P-2 修正（2026-09-16）：候选租户集**不得排除平台租户 `system`**。
//   同族断点在 pumpAllTenants（src/signal/dispatcher.js:139）已按设计 §3.1.1 修正，本处为**漏改的第二处**：
//   泵侧已保证「平台级信号必须被泵」，但观测侧此前把平台租户从扫描面剔除 ⇒ 平台级信号被投递、
//   却**永不接受负向判据检查**（delivery_silent / gen_silent 对平台租户恒静默）。
//   即「上一闸修了、下一闸没修」——出口通了、观测瞎了，仍是同一类「平台告警永久静默」。
//   方向说明：平台租户无信号时该分支自然空转（零额外成本）；有信号而渠道已开却零投递时，
//   **正是必须报警的场景**（这正是本轮修复要恢复的可见性），故本处不应保留任何形式的豁免。
export function createSignalObservabilitySweep({ windowHours = 24 } = {}) {
  return {
    async sweepOnce() {
      const { rows } = await query(`SELECT DISTINCT tenant_id FROM crm.signal`);
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
