// test/enrichment-metrics-e2e.test.js — P0-3b 富集指标端点（真实 DB + 事件域聚合）
// 设计 docs/2026-09-15-anysite-borrowing-analysis.md §3 P0-3
// 直连 crm_native_test；走 createApp + issueToken（复用 leadPoolPage 范式）
// 抗假绿：rate 分母 = 事件条数（calls），hits = 非 existing 新落池数
import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../src/http/server.js';
import { query, queryWrite } from '../src/db.js';
import { issueToken } from '../src/http/auth.js';

const app = createApp();

beforeEach(async () => {
  await query(`TRUNCATE particles, edges, events CASCADE`);
});

describe('GET /api/enrichment-metrics', () => {
  it('无事件 → rate 0 / calls 0 / hits 0（不虚造）', async () => {
    const tok = issueToken({ username: 'e1', role: 'sales', tenantId: 'tE' });
    const r = await (await app.fetch('/api/enrichment-metrics', { headers: { authorization: `Bearer ${tok}` } })).json();
    expect(r.calls).toBe(0);
    expect(r.hits).toBe(0);
    expect(r.rate).toBe(0);
    expect(r.cost).toBe(0);
  });

  it('跨租户隔离：只聚合本租户 enrichment 事件', async () => {
    // tA 写入 4 条（3 hit / 1 miss），tB 写入 2 条（1 hit）
    await queryWrite(
      `INSERT INTO events (domain, type, payload) VALUES
       ('enrichment','enrichment-attempt','{"tenant_id":"tA","provider":"prospecting-session","cost":2,"calls":4,"hits":3}'::jsonb),
       ('enrichment','enrichment-attempt','{"tenant_id":"tB","provider":"prospecting-session","cost":1,"calls":2,"hits":1}'::jsonb)`
    );
    const tokA = issueToken({ username: 'eA', role: 'sales', tenantId: 'tA' });
    const tokB = issueToken({ username: 'eB', role: 'sales', tenantId: 'tB' });
    const jA = await (await app.fetch('/api/enrichment-metrics', { headers: { authorization: `Bearer ${tokA}` } })).json();
    expect(jA.calls).toBe(4);
    expect(jA.hits).toBe(3);
    expect(jA.rate).toBe(0.75);
    const jB = await (await app.fetch('/api/enrichment-metrics', { headers: { authorization: `Bearer ${tokB}` } })).json();
    expect(jB.calls).toBe(2);
    expect(jB.rate).toBe(0.5);
  });

  it('未登录 → 401', async () => {
    const r = await app.fetch('/api/enrichment-metrics', {});
    expect(r.status).toBe(401);
  });
});
