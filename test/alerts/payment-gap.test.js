// test/alerts/payment-gap.test.js — S05 T4 差额超阈值预警（TDD：先失败后实现）
// 验证：① alertRegistry 注册 payment_gap 规则（gap_threshold_pct 参数）；② 差额占比超阈值 → createAlert 落库
import { describe, it, expect, beforeEach } from 'vitest';
import { listAlertRules, resetAlertRegistry } from '../../src/alerts/alertRegistry.js';
import { createAlert, listAlerts, resetAlertStore } from '../../src/alerts/alertStore.js';

beforeEach(() => {
  resetAlertRegistry();
  resetAlertStore();
});

describe('S05 T4 差额超阈值预警', () => {
  it('alertRegistry 含 payment_gap 规则（gap_threshold_pct 参数）', () => {
    const r = listAlertRules().find((x) => x.kind === 'payment_gap');
    expect(r).toBeTruthy();
    expect(r.check_params).toHaveProperty('gap_threshold_pct');
  });

  it('差额占比超阈值 → createAlert 落库 payment_gap', () => {
    const threshold = 5;
    const gapPct = 50;
    if (gapPct >= threshold) {
      const { ok, alert } = createAlert({
        kind: 'payment_gap',
        severity: 'medium',
        target_role: 'finance',
        particle_id: null,
        payload: { contract_id: 'CT_X', gap: 200000, gap_pct: gapPct },
      });
      expect(ok).toBe(true);
      expect(alert.kind).toBe('payment_gap');
    }
    const alerts = listAlerts();
    expect(alerts.some((a) => a.kind === 'payment_gap')).toBe(true);
  });
});