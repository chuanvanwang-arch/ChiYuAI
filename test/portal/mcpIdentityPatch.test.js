// test/portal/mcpIdentityPatch.test.js — T2 真库集成：打掉 L2 假绿（吊销必失败 + 已吊销复活）
import { test, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
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
    VALUES ('sales', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb),
           ('sysadmin', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)
    ON CONFLICT (role_tag) DO NOTHING`);
});
afterAll(async () => {
  await query(`DELETE FROM crm.mcp_identity WHERE actor LIKE 'test-%'`);
});

async function seed(actor) {
  const id = randomUUID();
  await query(
    `INSERT INTO crm.mcp_identity (id, token_hash, actor, role_tag, tenant_id, enabled)
     VALUES ($1, crypt('x', gen_salt('bf')), $2, 'sales', 'system', TRUE)`, [id, actor]);
  return id;
}

test('仅传 revoked_at → 吊销成功，actor/role_tag 不被写 NULL', async () => {
  const id = await seed('revoke-only');
  const res = mockRes();
  await router.handlers.put({ params: { id }, body: { revoked_at: new Date().toISOString() } }, res);
  expect(res._code).toBe(200);
  const row = (await query(`SELECT actor, role_tag, enabled, revoked_at FROM crm.mcp_identity WHERE id=$1`, [id])).rows[0];
  expect(row.actor).toBe('revoke-only');   // 关键：未被改 NULL（旧 bug 会撞 NOT NULL → 400）
  expect(row.role_tag).toBe('sales');
  expect(row.enabled).toBe(false);
  expect(row.revoked_at).toBeTruthy();
});

test('对已吊销行再 PUT → 409，revoked_at 永不被清空', async () => {
  const id = await seed('revoked-then-edit');
  const r1 = mockRes();
  await router.handlers.put({ params: { id }, body: { revoked_at: new Date().toISOString() } }, r1);
  expect(r1._code).toBe(200);
  const r2 = mockRes();
  await router.handlers.put({ params: { id }, body: { actor: 'changed' } }, r2);
  expect(r2._code).toBe(409);
  const row = (await query(`SELECT revoked_at, actor FROM crm.mcp_identity WHERE id=$1`, [id])).rows[0];
  expect(row.revoked_at).toBeTruthy();     // 关键：未被编辑清空
  expect(row.actor).toBe('revoked-then-edit');
});

test('仅传 actor → 其余字段（scopes/expires_at/enabled）保持原值', async () => {
  const id = await seed('keep-fields');
  await query(`UPDATE crm.mcp_identity SET scopes='{"deny_domains":["X"]}'::jsonb, expires_at='2030-01-01'::timestamptz WHERE id=$1`, [id]);
  const res = mockRes();
  await router.handlers.put({ params: { id }, body: { actor: 'renamed' } }, res);
  expect(res._code).toBe(200);
  const row = (await query(`SELECT actor, scopes, expires_at, enabled FROM crm.mcp_identity WHERE id=$1`, [id])).rows[0];
  expect(row.actor).toBe('renamed');
  expect(row.scopes).toEqual({ deny_domains: ['X'] });
  expect(String(row.expires_at)).toContain('2030');
  expect(row.enabled).toBe(true);
});
