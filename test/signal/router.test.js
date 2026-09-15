import { describe, it, expect } from 'vitest';
import { createSignalRouter } from 'file:///D:/system/CRM-ai-native/src/signal/router.js';

describe('signal router（告警→信号映射）', () => {
  it('signalFromAlert 映射告警为信号（source=rule-scan）', () => {
    const router = createSignalRouter({});
    const s = router.signalFromAlert({
      alert_id: 'a1', kind: 'deal_stuck', severity: 'high', target_role: 'sales',
      tenant_id: 't1', payload: { deal: 'd1' },
    });
    expect(s.source).toBe('rule-scan');
    expect(s.kind).toBe('deal_stuck');
    expect(s.severity).toBe('high');
    expect(s.target_role).toBe('sales');
    expect(s.dedup_key).toBe('deal_stuck:d1:hour');
  });

  it('dedup_key 缺粒子时为空（防假绿：无对象则不去重）', () => {
    const router = createSignalRouter({});
    const s = router.signalFromAlert({
      alert_id: 'a2', kind: 'lead_overdue', severity: 'medium', target_role: 'sales',
      tenant_id: 't1', payload: {},
    });
    expect(s.dedup_key).toBeNull();
  });

  it('payload 无对象锚点但传 particle_id 时用 particle_id 生成 dedup', () => {
    const router = createSignalRouter({});
    const s = router.signalFromAlert({
      alert_id: 'a3', kind: 'deal_stuck', severity: 'high', target_role: 'sales',
      tenant_id: 't1', particle_id: 'p9', payload: { subject: 'x' },
    });
    expect(s.dedup_key).toBe('deal_stuck:p9:hour');
  });

  it('evidence 携带 rule_kind 与 decision_id（审计溯源）', () => {
    const router = createSignalRouter({});
    const s = router.signalFromAlert({
      alert_id: 'a4', kind: 'deal_stuck', severity: 'high', target_role: 'sales',
      tenant_id: 't1', payload: { deal: 'd1' }, decision_id: 'dec-1',
    });
    expect(s.evidence.rule_kind).toBe('deal_stuck');
    expect(s.evidence.decision_id).toBe('dec-1');
  });
});
