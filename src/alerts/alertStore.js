// src/alerts/alertStore.js — 告警实例处置状态机（内存 Map，对齐 DB crm.alert 镜像）
// 设计输入：docs/2026-08-25-alert-feedback-loop-design.md §C（crm.alert 表）+ §D（处置状态机）
// 状态机：open ──ack──> acked ──close(原因必填)──> closed；open ──close──> closed；closed 不可再 ack/close（幂等拒绝）
import { randomUUID } from 'node:crypto';

// 告警实例内存存储（DB crm.alert 镜像；DB 落库留 PG 验收）
const alerts = new Map();

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