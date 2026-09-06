// test/portal/userManagement.gate.test.js — F3 集成：全局 config-level 闸 vs userManagement router 一致性
// 验证：sysadmin 不再被全局闸误拦（id12 level=tenant 修复后可达）；system 级配置仍仅 ADMIN。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { createUserRouter } from '../../src/portal/userManagement.js';
import { createConfigLevelGate } from '../../src/http/middleware/rbac.js';
import { CONFIG_ITEMS } from '../../src/portal/configCenter.js';

const okMe = (role, tenantId) => ({ ok: true, role, tenantId, username: `${role}-u`, id: `${role}-id` });

function mkApp() {
  const app = express();
  app.use((req, res, next) => { req.me = okMe(req.headers['x-role'], req.headers['x-tenant']); next(); });
  const deps = {
    resolveMe: (req) => req.me,
    listUsers: async () => [],
    query: async () => ({ rows: [] }),
    hashPassword: async () => 'hash',
    createUser: async () => ({ user_id: 'x' }),
    updateUser: async () => ({ user_id: 'x' }),
    recordDecisionEvent: async () => ({ event_id: 'e' }),
    batchUpdateUsers: async () => 1,
    validateCreateUser: () => ({ ok: true, normalized: { username: 'u', role: 'sales', password: 'p', display_name: 'n', org_id: null } }),
    validateUserPatch: () => ({ ok: true, normalized: {} }),
    validateBatchUsers: () => ({ ok: true, normalized: { action: 'enable', user_ids: [] } }),
  };
  // 关键：createConfigLevelGate 接受 resolve 覆盖，注入测试身份（绕过 JWT）
  app.use(createConfigLevelGate(CONFIG_ITEMS, { resolve: (req) => req.me }));
  // 注意：createUserRouter 内部已注册完整路径 /api/config/users（与 production routes.js:440 同款根挂载）
  app.use(createUserRouter(deps));
  app.get('/api/config/llm', (req, res) => res.json({ ok: true })); // 位于全局闸之后，system 级
  return app;
}

let server, base;
beforeAll(() => new Promise((res) => { server = mkApp().listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; res(); }); }));
afterAll(() => server.close());

describe('用户管理全局闸 (F3)', () => {
  it('T5.1 sysadmin GET /api/config/users 可达（不再 403）', async () => {
    const r = await fetch(`${base}/api/config/users`, { headers: { 'x-role': 'sysadmin', 'x-tenant': 'T1' } });
    expect(r.status).toBe(200);
  });
  it('T5.2 ten_admin GET /api/config/users 可达（本租户）', async () => {
    const r = await fetch(`${base}/api/config/users`, { headers: { 'x-role': 'ten_admin', 'x-tenant': 'T1' } });
    expect(r.status).toBe(200);
  });
  it('T5.3 sysadmin GET /api/config/llm 仍 403（system 仅 ADMIN）', async () => {
    const r = await fetch(`${base}/api/config/llm`, { headers: { 'x-role': 'sysadmin', 'x-tenant': 'T1' } });
    expect(r.status).toBe(403);
  });
  it('T5.4 admin GET /api/config/llm 可达', async () => {
    const r = await fetch(`${base}/api/config/llm`, { headers: { 'x-role': 'admin', 'x-tenant': 'T1' } });
    expect(r.status).toBe(200);
  });
});
