// T20-6 定时巡检单测：createSignalObservabilitySweep 命中负向判据 → createAlert + emit trace
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { query } from '../../src/db.js';
import { createSignalObservabilitySweep } from '../../src/monitor/signalMetrics.js';
import { listAlerts, resetAlertStore } from '../../src/alerts/alertStore.js';

const T = `t20s-${randomUUID()}`;

beforeAll(async () => {
  resetAlertStore();
  // 有信号但零投递行 → delivery_silent（enabled 默认四渠道全报）
  await query(
    `INSERT INTO crm.signal (signal_id, tenant_id, source, kind, severity, target_role, status, created_at)
     VALUES ($1,$2,'rule-scan','budget-drift','high','sales','open',now())`,
    [`sig-${randomUUID()}`, T]
  );
});

afterAll(async () => {
  await query(`DELETE FROM crm.signal WHERE tenant_id=$1`, [T]).catch(() => {});
  resetAlertStore();
});

describe('createSignalObservabilitySweep（T20-6）', () => {
  it('命中 delivery_silent → createAlert(kind=signal-observability)', async () => {
    const sweep = createSignalObservabilitySweep({ windowHours: 1 });
    const r = await sweep.sweepOnce();
    expect(r.tenants).toBeGreaterThanOrEqual(1);
    expect(r.fired).toBeGreaterThanOrEqual(1);
    const alerts = listAlerts({ kind: 'signal-observability' });
    expect(alerts.some(a => a.tenant_id === T)).toBe(true);
    expect(alerts.some(a => a.severity === 'high' && a.target_role === 'ops')).toBe(true);
  });
});
