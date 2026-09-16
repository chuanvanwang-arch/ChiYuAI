// test/http/signalMetrics.test.js — T20-4 端到端（真实 express + 真实库，mock 登录身份）
// 覆盖：GET /api/monitor/signal-link 返回 metrics+negative_predicates+downgrades；租户隔离；未登录 401
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { query } from '../../src/db.js';
import { createSignalMetricsRouter } from '../../src/http/signalMetricsRouter.js';

vi.mock('../../src/http/auth.js', () => ({ resolveMe: vi.fn() }));
const { resolveMe } = await import('../../src/http/auth.js');

const T = `t20h-${randomUUID()}`;
const T2 = `t20h2-${randomUUID()}`;
let server = null, baseUrl = '';

const me = (tenantId = T) => resolveMe.mockReturnValue({ ok: true, role: 'admin', tenantId, username: 'tester' });
async function call(path, tenantId = T) {
  me(tenantId);
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

beforeAll(async () => {
  await query(
    `INSERT INTO crm.signal (signal_id, tenant_id, source, kind, severity, target_role, status, created_at)
     VALUES ($1,$2,'rule-scan','budget-drift','high','sales','open',now())`,
    [`sig-${randomUUID()}`, T]
  );
  await query(
    `INSERT INTO crm.signal_delivery (delivery_id, signal_id, tenant_id, channel, status, delivered_at, created_at)
     VALUES ($1,'sig-x',$2,'email','sent',now()+interval '1 second',now())`,
    [`dl-${randomUUID()}`, T]
  );
  const app = express();
  app.use(express.json());
  app.use('/api/monitor', createSignalMetricsRouter());
  await new Promise((rs) => { server = app.listen(0, '127.0.0.1', () => { baseUrl = `http://127.0.0.1:${server.address().port}`; rs(); }); });
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  for (const t of [T, T2]) {
    await query(`DELETE FROM crm.signal_delivery WHERE tenant_id=$1`, [t]).catch(() => {});
    await query(`DELETE FROM crm.signal WHERE tenant_id=$1`, [t]).catch(() => {});
    await query(`DELETE FROM crm.grant_execution WHERE tenant_id=$1`, [t]).catch(() => {});
    await query(`DELETE FROM crm.standing_grant WHERE tenant_id=$1`, [t]).catch(() => {});
  }
});

describe('GET /api/monitor/signal-link（T20-4）', () => {
  it('返回 metrics + negative_predicates + downgrades（per-tenant）', async () => {
    const r = await call('/api/monitor/signal-link');
    expect(r.status).toBe(200);
    expect(r.body.metrics.tenant_id).toBe(T);
    expect(r.body.metrics.delivery_success_rate).toBe(1);   // 1 sent / (1+0)
    expect(Array.isArray(r.body.negative_predicates)).toBe(true);
    expect(r.body.downgrades).toBeTruthy();
    // email 有投递 → 非 delivery_silent；webhook 无投递 → delivery_silent
    const silent = r.body.negative_predicates.filter(x => x.type === 'delivery_silent');
    expect(silent.some(x => x.channel === 'webhook')).toBe(true);
    expect(silent.some(x => x.channel === 'email')).toBe(false);
  });

  it('租户隔离：他租户无数据 → success_rate=null', async () => {
    const r = await call('/api/monitor/signal-link', T2);
    expect(r.status).toBe(200);
    expect(r.body.metrics.tenant_id).toBe(T2);
    expect(r.body.metrics.delivery_success_rate).toBeNull();
  });

  it('未登录 → 401', async () => {
    resolveMe.mockReturnValue({ ok: false, error: 'no-token' });
    const res = await fetch(`${baseUrl}/api/monitor/signal-link`);
    expect(res.status).toBe(401);
  });
});
