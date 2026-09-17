// src/signal/router.js — 信号领域适配：告警/事件 → 统一信号
// 设计输入：docs/2026-09-15-final-design-coexistence-and-proactive.md §8.3（信号统一收口）
// 职责：告警对象（alert）→ 信号对象（signal）映射；dedup 键需粒子锚点（无对象则不去重，防假绿）
export function createSignalRouter({ now = () => new Date() } = {}) {
  // 告警 → 信号（source=rule-scan；payload 透传；dedup 键优先用告警自带的稳定键）
  //
  // 2026-09-17 个人隔离修正（两条写路径必须逐字段一致）：
  //   本函数与 createAlertWithDb 的直写 INSERT 会**对同一 signal_id 竞争写入**
  //   （persister 是 fire-and-forget，往往先落库）。若此处与直写路径的取值规则不同，
  //   「谁先落库」就决定了落库行有没有 owner —— 表现为随机 NULL，且不会有任何报错。
  //   故 owner_id / dedup_key 一律**优先取告警对象自带值**（createAlert 已保留），
  //   payload 回退仅作兼容；两条路径归一后内容相同 → 竞争无害。
  function signalFromAlert({ alert_id, kind, severity, l2c_stage, target_role, tenant_id, particle_id, payload, decision_id, owner_id = null, dedup_key = null } = {}) {
    const particleRef = particle_id || payload?.deal || payload?.account || payload?.lead || null;
    return {
      signal_id: alert_id, // 沿用告警 id 保证溯源性
      tenant_id: tenant_id || 'system',
      source: 'rule-scan',
      kind,
      severity,
      target_role,
      owner_id: owner_id || payload?.owner_id || null,
      l2c_stage: l2c_stage || null,
      particle_id: particleRef,
      payload: payload || {},
      evidence: { rule_kind: kind, decision_id: decision_id || null },
      suggestion: {},
      dedup_key: dedup_key || (particleRef ? `${kind}:${particleRef}:hour` : null),
    };
  }
  return { signalFromAlert };
}
