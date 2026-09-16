// T20-6 定时巡检单测：createSignalObservabilitySweep 命中负向判据 → createAlert + emit trace
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { query } from '../../src/db.js';
import { createSignalObservabilitySweep } from '../../src/monitor/signalMetrics.js';
import { listAlerts, resetAlertStore } from '../../src/alerts/alertStore.js';

const T = `t20s-${randomUUID()}`;

beforeAll(async () => {
  resetAlertStore();
  // 有信号但零投递行 → delivery_silent
  // Q1-4（2026-09-16）：判据 A 改为「渠道集合来自 config_store」后，必须显式声明渠道开关
  //   （修正前用硬编码 DEFAULT_CHANNELS 四渠道恒全开）。**只补前置条件，断言未改**。
  await query(
    `INSERT INTO crm.config_store (tenant_id, key, value, updated_by, updated_at)
     VALUES ($1,'signal-delivery',$2::jsonb,'test',now())
     ON CONFLICT (tenant_id, key) DO UPDATE SET value=$2::jsonb, updated_at=now()`,
    [T, JSON.stringify({ channels: { inbox: 'on', email: 'on', im: 'on', webhook: 'on' } })]
  );
  await query(
    `INSERT INTO crm.signal (signal_id, tenant_id, source, kind, severity, target_role, status, created_at)
     VALUES ($1,$2,'rule-scan','budget-drift','high','sales','open',now())`,
    [`sig-${randomUUID()}`, T]
  );
});

afterAll(async () => {
  await query(`DELETE FROM crm.signal WHERE tenant_id=$1`, [T]).catch(() => {});
  await query(`DELETE FROM crm.config_store WHERE tenant_id=$1 AND key='signal-delivery'`, [T]).catch(() => {});
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
