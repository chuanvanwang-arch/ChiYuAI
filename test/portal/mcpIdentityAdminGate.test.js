// test/portal/mcpIdentityAdminGate.test.js — T1 集成（stub deps，验证角色闸放行/拦截）
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { createMcpIdentityRouter } from '../../src/portal/mcpIdentity.js';

const okMe = (role) => ({ ok: true, role, tenantId: 'system', username: `${role}-u`, id: `${role}-id` });

function mkApp(role) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.me = okMe(role); next(); });
  const deps = {
    resolveMe: (req) => req.me,
    list: async () => ({ rows: [], roles: [] }),
    create: async () => ({ row: { id: 'x' }, token_plaintext: 'tok' }),
    put: async () => ({ row: { id: 'x' } }),
    produceDecision: async () => ({ decisionId: null, ok: true }),
  };
  app.use(createMcpIdentityRouter(deps));
  return app;
}

let server, base;
beforeAll(() => new Promise((res) => { server = mkApp('sales').listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; res(); }); }));
afterAll(() => server.close());

describe('T1 管理通道角色闸', () => {
  it('sales GET /api/mcp-identities → 403', async () => {
    const r = await fetch(`${base}/api/mcp-identities`, { headers: { 'x-role': 'sales' } });
    expect(r.status).toBe(403);
  });
  it('sales POST /api/mcp-identities → 403', async () => {
    const r = await fetch(`${base}/api/mcp-identities`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-role': 'sales' }, body: '{}' });
    expect(r.status).toBe(403);
  });
  it('sales PUT /api/mcp-identities/:id → 403（提权链第③步被阻断）', async () => {
    const r = await fetch(`${base}/api/mcp-identities/x`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-role': 'sales' }, body: '{"role_tag":"sysadmin"}' });
    expect(r.status).toBe(403);
  });
  it('admin PUT /api/mcp-identities/:id → 200', async () => {
    const adminApp = mkApp('admin');
    const s2 = adminApp.listen(0, '127.0.0.1');
    await new Promise((res) => s2.once('listening', res));
    const port = s2.address().port;
    const r = await fetch(`http://127.0.0.1:${port}/api/mcp-identities/x`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-role': 'admin' }, body: '{"actor":"a"}' });
    expect(r.status).toBe(200);
    s2.close();
  });
  it('未登录 → 401', async () => {
    const app = express(); app.use(express.json());
    app.use((req, res, next) => { req.me = { ok: false, error: 'missing' }; next(); });
    app.use(createMcpIdentityRouter({ resolveMe: (req) => req.me, list: async () => ({ rows: [], roles: [] }) }));
    const s = app.listen(0, '127.0.0.1'); await new Promise((res) => s.once('listening', res));
    const r = await fetch(`http://127.0.0.1:${s.address().port}/api/mcp-identities`);
    expect(r.status).toBe(401);
    s.close();
  });
});
