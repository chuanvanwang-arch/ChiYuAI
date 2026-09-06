// test/http/tokenUsageRoute.test.js — DB-free 单测（supertest 未安装，改用 node 内置 http/express 挂载）
import { describe, it, expect, vi, beforeAll } from 'vitest';
import express from 'express';

// 隔离依赖：billingService 全量导出（含既有 6 个 + 新增 3 个），均返回固定假数据
vi.mock('../../src/billing/billingService.js', () => ({
  computeStatement: vi.fn(async () => ({})),
  issueStatement: vi.fn(async () => ({})),
  flipOverdue: vi.fn(async () => ({})),
  pay: vi.fn(async () => ({})),
  reconcile: vi.fn(async () => ({})),
  exportCsv: vi.fn(async () => ''),
  tokenQuota: vi.fn(async () => ({ plan_id: 'free', included_tokens: 50000, used_total: 10, remaining: 49990, overage_fee: 0, unlimited: false })),
  tokenByAccount: vi.fn(async () => [{ actor: 'alice', username: 'alice', tokens_in: 5, tokens_out: 5, total: 10, share_pct: 100, is_unattributed: false }]),
  tokenByAction: vi.fn(async () => [{ action: 'agent-think', tokens_in: 5, tokens_out: 5, total: 10, share_pct: 100 }]),
}));
// resolveMe 恒返回 admin（ok）
vi.mock('../../src/http/auth.js', () => ({
  resolveMe: vi.fn(() => ({ ok: true, role: 'admin', tenantId: 'system' })),
}));
// applyTenantOverride 由测试控制返回值（'*' 或具体租户）
vi.mock('../../src/http/tenantScope.js', () => ({
  applyTenantOverride: vi.fn(() => '*'),
  scopeTenant: vi.fn(() => '*'),
}));
// query 仅在 scope='*' 分支被调用，返回固定活跃租户列表避免真实 DB
vi.mock('../../src/db.js', () => ({
  query: vi.fn(async () => ({ rows: [{ tenant_id: 'tenantA' }, { tenant_id: 'tenantB' }] })),
}));

const { createBillingRouter } = await import('../../src/http/billingRoutes.js');
const { applyTenantOverride } = await import('../../src/http/tenantScope.js');

const app = express();
app.use(createBillingRouter());

async function call(path, scope) {
  applyTenantOverride.mockReturnValue(scope);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const r = await fetch(base + path, { headers: { Authorization: 'Bearer x' } });
    return { status: r.status, body: await r.json() };
  } finally {
    server.close();
  }
}

describe('GET /api/billing/token-usage', () => {
  it('admin 指定租户返回 quota+byAccount+byAction', async () => {
    const res = await call('/api/billing/token-usage?period=2026-09', 'tenantA');
    expect(res.status).toBe(200);
    expect(res.body.quota).toBeTruthy();
    expect(Array.isArray(res.body.byAccount)).toBe(true);
    expect(Array.isArray(res.body.byAction)).toBe(true);
    expect(res.body.scope).toBe('tenantA');
  });

  it('admin 全量 scope=* 返回 tenants 数组', async () => {
    const res = await call('/api/billing/token-usage?period=2026-09', '*');
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('*');
    expect(Array.isArray(res.body.tenants)).toBe(true);
    expect(res.body.tenants.length).toBe(2);
    expect(res.body.tenants[0]).toHaveProperty('quota');
    expect(res.body.tenants[0]).toHaveProperty('byAccount');
    expect(res.body.tenants[0]).toHaveProperty('byAction');
  });
});
