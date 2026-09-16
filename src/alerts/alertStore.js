// src/alerts/alertStore.js — 告警实例处置状态机（内存 Map，对齐 DB crm.alert 镜像）
// 设计输入：docs/2026-08-25-alert-feedback-loop-design.md §C（crm.alert 表）+ §D（处置状态机）
// 状态机：open ──ack──> acked ──close(原因必填)──> closed；open ──close──> closed；closed 不可再 ack/close（幂等拒绝）
import { randomUUID } from 'node:crypto';
import { emit } from '../events/bus.js';

// 告警实例内存存储（DB crm.alert 镜像；DB 落库留 PG 验收）
const alerts = new Map();

// ===== 落库单一收敛点（B-B3，2026-09-16 主动运行时 S1）=====
// 为什么在 createAlert 内挂 sink、而非逐点调 createAlertWithDb：
//   实测告警产生点共 5 处（alertHook / financeAlertHook / routes 差额预警 / timers 日报扫描 /
//   timers 到访逾期）——逐点改只覆盖 1/N，其余告警永远进不了 crm.signal（销售自动化页看不到 = 部分假绿）；
//   bus 'alert' 域亦不可靠（timers 逾期点只发 alert_id 无 alert 对象、alertEndpoints.create 不发事件）。
//   createAlert 是全部产生点的**唯一**收口 → 一处注册覆盖全部，含将来新增点。
// 纪律：fire-and-forget 不阻塞告警主流程；失败留 trace 不静默（禁裸 catch 铁律）。
let persister = null;
export function setAlertPersister(fn) { persister = typeof fn === 'function' ? fn : null; }
export function getAlertPersister() { return persister; }

// createAlert({kind, severity, l2c_stage, target_role, tenant_id, particle_id, payload, decision_id}) → {ok, alert}
// kind/severity/target_role 必填非法拒绝
export function createAlert({ kind, severity, l2c_stage, target_role, tenant_id, particle_id, payload, decision_id } = {}) {
  if (!kind || !severity || !target_role) {
    return { ok: false, error: 'required_fields_missing' };
  }
  const alert = {
    alert_id: randomUUID(),
    kind,
    severity,          // low/medium/high（§3.10 风险分档）
    l2c_stage: l2c_stage || null,   // 锚点：lead/opportunity/quoted/contracted/ordered/paid
    target_role,       // sales/finance/exec/ops
    tenant_id: tenant_id || 'system', // 2026-09-05 G3：告警归属租户（防跨租户泄漏）
    particle_id: particle_id || null,
    payload: payload || {},
    status: 'open',
    decision_id: decision_id || null,  // 处置决策关联（§6.3 决策网络）
    createdAt: new Date().toISOString(),
    ackedAt: null,
    closedAt: null,
    closedReason: null,
  };
  alerts.set(alert.alert_id, alert);
  // 落库（可用时）：同步 API 不变，DB 写异步进行 —— 调用方零改动即获得持久化
  if (persister) {
    Promise.resolve()
      .then(() => persister(alert))
      .catch((e) => emit('trace', 'alert-persist-failed', { alert_id: alert.alert_id, kind: alert.kind, error: String(e?.message || e) }));
  }
  return { ok: true, alert };
}

// listAlerts({kind, status}) → 过滤清单（不返回内部引用）
export function listAlerts({ kind, status } = {}) {
  return [...alerts.values()].filter(a =>
    (kind ? a.kind === kind : true) &&
    (status ? a.status === status : true),
  ).map(a => ({ ...a }));
}

// ackAlert(alert_id) → open→acked；acked 幂等拒绝；closed 拒绝
export function ackAlert(alertId) {
  const a = alerts.get(alertId);
  if (!a) return { ok: false, error: 'alert_not_found' };
  if (a.status === 'acked') return { ok: false, error: 'already_acked' };
  if (a.status === 'closed') return { ok: false, error: 'already_closed' };
  a.status = 'acked';
  a.ackedAt = new Date().toISOString();
  return { ok: true, alert: { ...a } };
}

// closeAlert(alert_id, {reason}) → open/acked→closed（reason 必填）；closed 幂等拒绝
export function closeAlert(alertId, { reason } = {}) {
  const a = alerts.get(alertId);
  if (!a) return { ok: false, error: 'alert_not_found' };
  if (a.status === 'closed') return { ok: false, error: 'already_closed' };
  if (!reason) return { ok: false, error: 'closed_reason_required' };
  a.status = 'closed';
  a.closedAt = new Date().toISOString();
  a.closedReason = reason;
  return { ok: true, alert: { ...a } };
}

// 幂等解除前置：查某粒子某 kind 的未闭环告警（open/acked 视为在途，扫描不复发；closed 不算）
// 供定时扫描（named-visit-scan）达标自动解除用——已有 open 则不重复建（幂等铁律）
export function findOpenAlertByParticle(particleId, kind) {
  if (!particleId) return null;
  for (const a of alerts.values()) {
    if (a.particle_id === particleId && a.kind === kind && (a.status === 'open' || a.status === 'acked')) {
      return { ...a };
    }
  }
  return null;
}

// 测试/重建用清空
export function resetAlertStore() {
  alerts.clear();
}

// ============ B-B3（2026-09-16 主动运行时 S1）：内存 Map → DB 双写 ============
// 保留既有 createAlert/listAlerts/ackAlert/closeAlert 导出（兼容既有调用方），新增注入版：
//   createAlertWithDb(pool, params) —— 内存落 alert + DB 落 crm.signal（source=rule-scan）
// 防假绿核心：createAlert 返回 ok ≠ 已送达；DB 落库由 crm.signal_delivery 流水验证（见 signal/delivery/）
// ON CONFLICT DO NOTHING：同 alert_id 幂等（巡检重复触发不叠加）
export async function createAlertWithDb(pool, params = {}) {
  const mem = createAlert(params);
  if (!mem.ok) return mem;
  const { rows } = await pool.query(
    `INSERT INTO crm.signal
      (signal_id, tenant_id, source, kind, severity, target_role, owner_id, l2c_stage, particle_id, payload, evidence, dedup_key)
     VALUES ($1,$2,'rule-scan',$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT DO NOTHING RETURNING *`,
    [
      mem.alert.alert_id, params.tenant_id || 'system', params.kind, params.severity,
      params.target_role, params.owner_id || null, params.l2c_stage || null,
      params.particle_id || null, JSON.stringify(params.payload || {}),
      JSON.stringify({ rule_kind: params.kind, decision_id: params.decision_id || null }),
      params.particle_id ? `${params.kind}:${params.particle_id}:hour` : null,
    ],
  );
  return { ok: true, alert: mem.alert, db: rows[0] || null };
}