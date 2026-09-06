// test/scheduler/timers-sales.test.js — sales-daily-scan 定时器注册（TDD 红→绿）
// 设计：docs/2026-08-30-sales-indicator-3class-deep-implementation-design.md §1.2
// 对齐：timers.js 已有 lead-pool-recycle 30min 巡检模式（只读+emit，不写粒子）
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ensureTimers, clearTimers, timerCount } from '../../src/scheduler/timers.js';
import { resetAlertStore, listAlerts } from '../../src/alerts/alertStore.js';
import { resetAlertRegistry } from '../../src/alerts/alertRegistry.js';

beforeEach(() => { resetAlertStore(); resetAlertRegistry(); });
afterEach(() => clearTimers());

describe('timers sales-daily-scan', () => {
  it('ensureTimers 注册 sales-daily-scan（计数 ≥5）', async () => {
    const n = await ensureTimers();
    expect(n).toBeGreaterThanOrEqual(5);
  });

  it('salesDailyScan 命中 -> createAlert 落库（覆盖率缺口链路）', async () => {
    const { salesDailyScan } = await import('../../src/scheduler/salesDailyScan.js');
    const { mergedThresholds } = await import('../../src/sales/salesThresholds.js');
    const { createAlert } = await import('../../src/alerts/alertStore.js');
    const hits = salesDailyScan({
      accounts: [{ id: 'a1', payload: { tier: '目标', visit_notes: [{ at: new Date(Date.now() - 45 * 86400000).toISOString() }] } }],
      deals: [], thresholds: mergedThresholds({}),
    });
    for (const h of hits) {
      createAlert({ kind: h.kind, severity: h.severity, target_role: 'sales', particle_id: h.particle_id, payload: h.metric });
    }
    const alerts = listAlerts();
    expect(alerts.some(a => a.kind === 'coverage_gap')).toBe(true);
  });
});