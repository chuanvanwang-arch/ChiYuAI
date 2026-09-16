// src/sync/exportGate.js — 运行时**顺序**闸门（设计 §0.4 / §3.4 的落地形式）
//
// ⚠ 与 src/sync/gate.js 的边界（**不得混淆、不得合并**）：
//   gate.js        = 接入**评审**闸门（人工审批类：first-connect / mapping-change /
//                    trust-elevate / enable-writeback，判定依赖 reviewGate.hasApproval）
//   exportGate.js  = 运行时**顺序**闸门（自动健康度判定：出口是否健康 → 决定回写与自治能否启用）
//   两者失败原因不同（「人工未审批」vs「出口不健康」），合并会让二者无法区分。
//
// 立论（设计 §0.4）：原设计 §14.2 用「排期纪律」保证「先出口、后回写」——排期是人的承诺，不是机制。
//   本闸门把它变成**运行时前置条件**：出口判据①不成立 → 回写/自治一律阻断。
//
// 三判据（设计 §3.4）：
//   ① crm.signal_delivery 窗口内存在 status='sent' 行
//   ② 渠道集合来自 config_store['signal-delivery']（非硬编码）
//   ③ 无「配置为 on 但零投递行」的渠道（复用 §3.3/Q1-4 修正后的判据 A）
//
// 铁律：**fail-closed** —— 任一判据为假或判定抛错，一律 blocked（绝不放行）。
import { query as realQuery } from '../db.js';
import { readConfig as realReadConfig } from '../config/configStore.js';
import { emit as realEmit } from '../events/bus.js';

export const DEFAULT_WINDOW_HOURS = 24;

// 判据 A 的告警类型（判据 B `gen_silent` 属生成侧静默，**不**参与出口健康度——
//   混入会让"信号生成侧故障"误关掉回写，属误归因）
const EXPORT_PREDICATE = 'delivery_silent';

export function createExportGate({ query = realQuery, readConfig = realReadConfig, detectFn = null, emit = realEmit } = {}) {
  // detectNegativePredicates 懒加载（避免与 signalMetrics 的循环依赖；测试注入 detectFn 时零 IO）
  async function resolveDetect() {
    if (detectFn) return detectFn;
    const mod = await import('../monitor/signalMetrics.js');
    return mod.detectNegativePredicates;
  }

  async function isExportHealthy({ tenantId = 'system', windowHours = DEFAULT_WINDOW_HOURS } = {}) {
    const since = new Date(Date.now() - windowHours * 3600 * 1000);
    const checks = { sent_exists: false, channels_from_config: false, no_silent_channel: false };

    // ① 窗口内存在 status='sent' 行（用 created_at 作窗口谓词：delivered_at 可为 NULL）
    const { rows: [d] } = await query(
      `SELECT COUNT(*) AS c FROM crm.signal_delivery
       WHERE tenant_id=$1 AND status='sent' AND created_at >= $2`,
      [tenantId, since]
    );
    checks.sent_exists = Number(d?.c || 0) > 0;

    // ② 渠道集合来自 config_store（读不到 / 全 off → 视为未配置，绝不用硬编码默认值兜底）
    const row = await readConfig('signal-delivery', { tenantId });
    const cfg = row?.value || null;
    const enabled = cfg && cfg.channels && typeof cfg.channels === 'object'
      ? Object.entries(cfg.channels).filter(([, v]) => v === 'on' || v === true).map(([k]) => k)
      : [];
    checks.channels_from_config = enabled.length > 0;

    // ③ 无「配置为 on 但零投递行」的渠道（复用 Q1-4 修正后的判据 A；不传 enabledChannels → 它自己读配置）
    const detect = await resolveDetect();
    const alerts = await detect({ tenantId, since });
    checks.no_silent_channel = !(alerts || []).some((a) => a.type === EXPORT_PREDICATE);

    const healthy = checks.sent_exists && checks.channels_from_config && checks.no_silent_channel;
    return {
      healthy,
      tenant_id: tenantId,
      window_hours: windowHours,
      checks,
      reason: healthy ? 'ok' : Object.entries(checks).filter(([, v]) => !v).map(([k]) => k).join(','),
    };
  }

  // guard：供接入点使用的 fail-closed 包装。抛错一律 blocked（**绝不**因异常而放行）。
  // emit 可在调用处覆盖（默认用工厂注入的 emit）——便于调用方把自己的 trace 汇接进来。
  async function guard({ tenantId = 'system', action = 'unknown', windowHours = DEFAULT_WINDOW_HOURS, emit: emitOverride = null } = {}) {
    const doEmit = emitOverride || emit;
    try {
      const r = await isExportHealthy({ tenantId, windowHours });
      if (r.healthy) return { allowed: true, gate: r };
      doEmit('trace', 'export-gate-blocked', {
        tenant_id: tenantId, action, reason: r.reason, checks: r.checks,
      });
      return { allowed: false, error: 'blocked_by_export_gate', reason: r.reason, gate: r };
    } catch (e) {
      // 闸门自身故障必须可见（不静默），且**一律视为 blocked**
      doEmit('trace', 'export-gate-error', { tenant_id: tenantId, action, error: String(e?.message || e) });
      return { allowed: false, error: 'blocked_by_export_gate', reason: `gate_error:${String(e?.message || e)}` };
    }
  }

  return { isExportHealthy, guard };
}
