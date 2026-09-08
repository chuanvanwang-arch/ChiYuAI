// test/portal/mcpIdentityTenant.test.js — T3 真库集成：tenant_id 显式落库
import { test, expect, beforeAll, afterAll } from 'vitest';
import { createMcpIdentityRouter } from '../../src/portal/mcpIdentity.js';
import { query } from '../../src/db.js';

const adminMe = { ok: true, role: 'admin', tenantId: 'system', username: 'admin' };
const router = createMcpIdentityRouter({ resolveMe: async () => adminMe });

function mockRes() {
  let code = 200, body = null;
  return {
    status: (c) => { code = c; return { json: (p) => { body = p; } }; },
    json: (p) => { body = p; },
    get _code() { return code; }, get _body() { return body; },
  };
}

beforeAll(async () => {
  await query(`INSERT INTO crm.role_context_profile (role_tag, seven_elements, data_scope, retrieval_cfg)
    VALUES ('sales', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb) ON CONFLICT (role_tag) DO NOTHING`);
});
afterAll(async () => {
  await query(`DELETE FROM crm.mcp_identity WHERE actor LIKE 'test-tenant-%'`);
});

test('create 带 tenant_id → 落库该租户', async () => {
  const res = mockRes();
  await router.handlers.create({ body: { actor: 'test-tenant-acme', role_tag: 'sales', tenant_id: 'acme-auto' } }, res);
  expect(res._code).toBe(200);
  const row = (await query(`SELECT tenant_id FROM crm.mcp_identity WHERE id=$1`, [res._body.id])).rows[0];
  expect(row.tenant_id).toBe('acme-auto');
});

test('create 不带 tenant_id → 落库 system（平台级接入方）', async () => {
  const res = mockRes();
  await router.handlers.create({ body: { actor: 'test-tenant-system', role_tag: 'sales' } }, res);
  expect(res._code).toBe(200);
  const row = (await query(`SELECT tenant_id FROM crm.mcp_identity WHERE id=$1`, [res._body.id])).rows[0];
  expect(row.tenant_id).toBe('system');
});
