// test/knowledge-integration.test.js — 租户级 Knowledge（P0-②）T5 前后端集成冒烟
// 依据：docs/superpowers/plans/2026-09-03-tenant-knowledge.md（T5：knowledge-config.html 管理页 + /api/knowledge 读写路由）
// 复用 account-360-integration 范式：createApp + issueToken + DB 条件跳过；无 DB 时仅跑静态页 200 用例
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createApp } from '../src/http/server.js';
import { issueToken } from '../src/http/auth.js';
import { query } from '../src/db.js';

const app = createApp();
const sysTok = issueToken({ username: 'admin', role: 'admin', display_name: 'Admin', tenantId: 'system' });
const auth = { Authorization: 'Bearer ' + sysTok };
const TERM = 'IT-TERM';

let dbOk = false;
try { await query('SELECT 1'); dbOk = true; } catch { dbOk = false; }
const db = (name, fn) => (dbOk ? it(name, fn) : it.skip(name, fn));

beforeAll(async () => {
  if (!dbOk) return;
  await query(`DELETE FROM crm.particles WHERE type='CRM_KNOWLEDGE' AND payload->>'term'=$1`, [TERM]);
});
afterAll(async () => {
  if (!dbOk) return;
  await query(`DELETE FROM crm.particles WHERE type='CRM_KNOWLEDGE' AND payload->>'term'=$1`, [TERM]);
});

// T5 静态页（无 DB 也跑）
it('GET /knowledge-config.html 返回 200 html', async () => {
  const res = await app.fetch('/knowledge-config.html');
  expect(res.status).toBe(200);
});

// T5 GET /api/knowledge 鉴权（无 token → 401，无 DB 也跑）
it('GET /api/knowledge 无 token 返回 401', async () => {
  const res = await app.fetch('/api/knowledge');
  expect(res.status).toBe(401);
});

// T5 GET /api/knowledge?kind= 过滤清单（DB）
db('GET /api/knowledge?kind=icp 返回 kind 过滤清单', async () => {
  await query(`INSERT INTO crm.particles (id, tenant_id, type, slug, title, state, payload)
    VALUES (gen_random_uuid(), 'system', 'CRM_KNOWLEDGE', 'it-term', 'IT-TERM', 'registered',
      '{"term":"IT-TERM","kind":"icp","content":"c","source":"manual","confidence":1}'::jsonb)`);
  const res = await app.fetch('/api/knowledge?kind=icp', { headers: auth });
  const j = await res.json();
  expect(res.status).toBe(200);
  expect(Array.isArray(j.rows)).toBe(true);
  expect(j.rows.some((r) => r.payload?.term === 'IT-TERM')).toBe(true);
});

// T5 POST /api/knowledge 非白名单角色 → 403（DB）
db('POST /api/knowledge 非知识角色（sales）返回 403', async () => {
  const salesTok = issueToken({ username: 'alice', role: 'sales', display_name: 'Alice', tenantId: 'system' });
  const res = await app.fetch('/api/knowledge', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + salesTok, 'Content-Type': 'application/json' },
    body: JSON.stringify({ term: 'X', kind: 'icp', content: 'c' }),
  });
  expect(res.status).toBe(403);
});