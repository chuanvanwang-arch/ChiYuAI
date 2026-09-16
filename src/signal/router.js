// src/signal/router.js — 信号领域适配：告警/事件 → 统一信号
// 设计输入：docs/2026-09-15-final-design-coexistence-and-proactive.md §8.3（信号统一收口）
// 职责：告警对象（alert）→ 信号对象（signal）映射；dedup 键需粒子锚点（无对象则不去重，防假绿）
export function createSignalRouter({ now = () => new Date() } = {}) {
  // 告警 → 信号（source=rule-scan；payload 透传；dedup 键需粒子锚点）
  function signalFromAlert({ alert_id, kind, severity, l2c_stage, target_role, tenant_id, particle_id, payload, decision_id } = {}) {
    const particleRef = particle_id || payload?.deal || payload?.account || payload?.lead || null;
    return {
      signal_id: alert_id, // 沿用告警 id 保证溯源性
      tenant_id: tenant_id || 'system',
      source: 'rule-scan',
      kind,
      severity,
      target_role,
      owner_id: payload?.owner_id || null,
      l2c_stage: l2c_stage || null,
      particle_id: particleRef,
      payload: payload || {},
      evidence: { rule_kind: kind, decision_id: decision_id || null },
      suggestion: {},
      dedup_key: particleRef ? `${kind}:${particleRef}:hour` : null,
    };
  }
  return { signalFromAlert };
}
