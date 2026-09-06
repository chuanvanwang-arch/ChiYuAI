// test/e2e/rbac-tenant-isolation.e2e.test.js — F1/F2 端到端：闸经真实 HTTP 传输验证
// F1: ten_admin 跨租户写粒子被 enforceScope 拒绝（HTTP → 403）
// F2: ten_admin 跨租户/系统级记忆推广被 gateAccept 拒绝（HTTP → 403）
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { enforceScope } from '../../src/context/scope.js';
import { gateAccept } from '../../src/http/propagationRoutes.js';
import { loadProfile, seedProfiles } from '../../src/context/roleProfiles.js';
import { queryWrite } from '../../src/db.js';

const okMe = (role, tenantId) => ({ ok: true, role, tenantId, username: `${role}-u`, id: `${role}-id` });

let pT1, pT2, server, base;
beforeAll(async () => {
  await seedProfiles();
  const a = await queryWrite(`INSERT INTO crm.particles (tenant_id,type,slug,title,state,payload) VALUES ($1,'CRM_DEAL','e2e-so1','e1','ACTIVE','{}') RETURNING *`, ['T1']);
  const b = await queryWrite(`INSERT INTO crm.particles (tenant_id,type,slug,title,state,payload) VALUES ($1,'CRM_DEAL','e2e-so2','e2','ACTIVE','{}') RETURNING *`, ['T2']);
  pT1 = a.rows[0]; pT2 = b.rows[0];

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.me = okMe(req.headers['x-role'], req.headers['x-tenant']); next(); });
  // F1: 模拟 data-particle-update 写通道第1闸（与 executor.dispatch 同款 enforceScope）
  app.post('/api/test/particle-update', async (req, res) => {
    const profile = await loadProfile(req.me.role);
    const v = await enforceScope({ name: 'data-particle-update' }, { actor: req.me.username, tenantId: req.me.tenantId }, { id: req.body.id }, profile);
    if (!v.ok) return res.status(403).json(v);
    res.json({ ok: true });
  });
  // F2: 模拟传播中枢 accept 的 gateAccept（与 propagationRoutes 同款）
  app.post('/api/test/propagation-accept', (req, res) => {
    const v = gateAccept(req.me, req.body);
    if (!v.ok) return res.status(v.status).json({ error: v.error });
    res.json({ ok: true });
  });
  server = app.listen(0, '127.0.0.1', () => {});
  await new Promise((res) => server.on('listening', res));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  server.close();
  await queryWrite(`DELETE FROM crm.particles WHERE slug IN ('e2e-so1','e2e-so2')`);
});

describe('F1 ten_admin 跨租户写 (E2E)', () => {
  it('T6.1 ten_admin 改他租户粒子 → 403 scope_violation', async () => {
    const r = await fetch(`${base}/api/test/particle-update`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-role': 'ten_admin', 'x-tenant': 'T1' },
      body: JSON.stringify({ id: pT2.id }),
    });
    expect(r.status).toBe(403);
    const j = await r.json();
    expect(j.gate).toBe('scope_violation');
  });
  it('T6.1b ten_admin 改本租户粒子 → 200', async () => {
    const r = await fetch(`${base}/api/test/particle-update`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-role': 'ten_admin', 'x-tenant': 'T1' },
      body: JSON.stringify({ id: pT1.id }),
    });
    expect(r.status).toBe(200);
  });
});

describe('F2 ten_admin 跨租户推广 (E2E)', () => {
  it('T6.2 ten_admin 上行至 system → 403', async () => {
    const r = await fetch(`${base}/api/test/propagation-accept`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-role': 'ten_admin', 'x-tenant': 'T1' },
      body: JSON.stringify({ kind: 'memory_promote', tenantId: 'system', memoryId: 'm1', ref: 'x' }),
    });
    expect(r.status).toBe(403);
  });
  it('T6.2b sysadmin 上行至 system → 200', async () => {
    const r = await fetch(`${base}/api/test/propagation-accept`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-role': 'sysadmin', 'x-tenant': 'T1' },
      body: JSON.stringify({ kind: 'memory_promote', tenantId: 'system', memoryId: 'm1', ref: 'x' }),
    });
    expect(r.status).toBe(200);
  });
});
