// test/context/scope.sysadmin.test.js — F4 sysadmin 写范围收敛（方案 C）
// 设计：docs/2026-09-06-rbac-f4-design.md §C2/C4
// 覆盖：
//   T1 sysadmin 写业务粒子（CRM_DEAL）→ enforceScope 返回 gate:'scope_violation'
//   T2 sysadmin 写治理类（CRM_PERSON）→ ok:true
//   T3 读路径 scopePredicate 对 sysadmin（data_scope.model='all'）无 clause → 跨租户全量
//   T4 sysadmin data_scope.write_scope 结构断言（C1）
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { enforceScope, scopePredicate, BUSINESS_PARTICLE_TYPES } from '../../src/context/scope.js';
import { seedProfiles, loadProfile } from '../../src/context/roleProfiles.js';
import { queryWrite } from '../../src/db.js';

// sysadmin 收敛后 profile（对应 roleProfiles.js SEED_PROFILES）
const SYSADMIN_PROFILE = {
  data_scope: {
    model: 'all', // 读：跨租户全量
    write_scope: { model: 'governance', exclude_types: BUSINESS_PARTICLE_TYPES },
  },
};

describe('enforceScope governance 写分支 (F4)', () => {
  let pDeal, pPerson;
  beforeAll(async () => {
    const a = await queryWrite(
      `INSERT INTO crm.particles (tenant_id,type,slug,title,state,payload) VALUES ($1,'CRM_DEAL','f4-deal-1','deal1','ACTIVE','{}') RETURNING *`, ['T1']);
    const b = await queryWrite(
      `INSERT INTO crm.particles (tenant_id,type,slug,title,state,payload) VALUES ($1,'CRM_PERSON','f4-person-1','person1','ACTIVE','{}') RETURNING *`, ['T1']);
    pDeal = a.rows[0]; pPerson = b.rows[0];
  });
  afterAll(async () => {
    await queryWrite(`DELETE FROM crm.particles WHERE slug IN ('f4-deal-1','f4-person-1')`);
  });

  it('T1 sysadmin 写业务粒子 CRM_DEAL → scope_violation', async () => {
    const r = await enforceScope(
      { name: 'data-particle-update' },
      { actor: 'sa1', tenantId: 'T1' },
      { id: pDeal.id },
      SYSADMIN_PROFILE
    );
    expect(r.ok).toBe(false);
    expect(r.gate).toBe('scope_violation');
    expect(r.reason).toContain('CRM_DEAL');
  });

  it('T2 sysadmin 写治理类 CRM_PERSON → ok:true', async () => {
    const r = await enforceScope(
      { name: 'data-particle-update' },
      { actor: 'sa1', tenantId: 'T1' },
      { id: pPerson.id },
      SYSADMIN_PROFILE
    );
    expect(r.ok).toBe(true);
  });

  it('T3 读路径 scopePredicate：sysadmin model=all → 无 clause（跨租户全量）', () => {
    const { clause, params } = scopePredicate(SYSADMIN_PROFILE, 'sa1');
    expect(clause).toBe('');
    expect(params).toEqual([]);
  });

  it('T4 write_scope 结构断言（governance + exclude BUSINESS_PARTICLE_TYPES）', () => {
    const ws = SYSADMIN_PROFILE.data_scope.write_scope;
    expect(ws.model).toBe('governance');
    expect(ws.exclude_types).toEqual(BUSINESS_PARTICLE_TYPES);
    expect(BUSINESS_PARTICLE_TYPES.length).toBe(9);
    expect(BUSINESS_PARTICLE_TYPES).not.toContain('CRM_PERSON'); // 治理类必须保留
  });

  it('T5 sysadmin 无 id（列表类写）→ ok（交 scopePredicate，governance 分支 !target 早返回）', async () => {
    const r = await enforceScope({ name: 'data-particle-read' },
      { actor: 'sa1', tenantId: 'T1' }, {}, SYSADMIN_PROFILE);
    expect(r.ok).toBe(true);
  });

  it('T6 C1: 种子 sysadmin(data_scope.write_scope) 已落库且结构正确', async () => {
    await seedProfiles();
    const p = await loadProfile('sysadmin');
    expect(p).not.toBeNull();
    expect(p.data_scope.model).toBe('all'); // 读仍全量
    expect(p.data_scope.write_scope.model).toBe('governance');
    expect(p.data_scope.write_scope.exclude_types).toEqual(BUSINESS_PARTICLE_TYPES);
  });
});
