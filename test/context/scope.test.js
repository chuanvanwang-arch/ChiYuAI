// test/context/scope.test.js — F1 enforceScope tenant 分支（DB 支撑：真实粒子 tenant_id 解析）
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { enforceScope } from '../../src/context/scope.js';
import { queryWrite } from '../../src/db.js';

const TENANT_PROFILE = { data_scope: { model: 'tenant' } };
const ALL_PROFILE = { data_scope: { model: 'all' } };

describe('enforceScope tenant 分支 (F1)', () => {
  let pOwn, pOther;
  beforeAll(async () => {
    const a = await queryWrite(`INSERT INTO crm.particles (tenant_id,type,slug,title,state,payload) VALUES ($1,'CRM_DEAL','rbac-so1','so1','ACTIVE','{}') RETURNING *`, ['T1']);
    const b = await queryWrite(`INSERT INTO crm.particles (tenant_id,type,slug,title,state,payload) VALUES ($1,'CRM_DEAL','rbac-so2','so2','ACTIVE','{}') RETURNING *`, ['T2']);
    pOwn = a.rows[0]; pOther = b.rows[0];
  });
  afterAll(async () => {
    await queryWrite(`DELETE FROM crm.particles WHERE slug IN ('rbac-so1','rbac-so2')`);
  });

  it('T1.1 ten_admin 改本租户粒子 ok', async () => {
    const r = await enforceScope({ name: 'data-particle-update' }, { actor: 'u1', tenantId: 'T1' }, { id: pOwn.id }, TENANT_PROFILE);
    expect(r.ok).toBe(true);
  });

  it('T1.2 ten_admin 改他租户粒子 scope_violation', async () => {
    const r = await enforceScope({ name: 'data-particle-update' }, { actor: 'u1', tenantId: 'T1' }, { id: pOther.id }, TENANT_PROFILE);
    expect(r.ok).toBe(false);
    expect(r.gate).toBe('scope_violation');
  });

  it('T1.3 无 id（列表类）交 scopePredicate → ok', async () => {
    const r = await enforceScope({ name: 'data-particle-read' }, { actor: 'u1', tenantId: 'T1' }, {}, TENANT_PROFILE);
    expect(r.ok).toBe(true);
  });

  it('T1.4 sysadmin(model=all) 不受影响', async () => {
    const r = await enforceScope({ name: 'data-particle-update' }, { actor: 'a1', tenantId: 'T1' }, { id: 'pX' }, ALL_PROFILE);
    expect(r.ok).toBe(true);
  });
});
