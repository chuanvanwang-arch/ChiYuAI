// test/particles/particleRepo.tenant.test.js — F1 数据层跨租户防御（DB 支撑）
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { updateParticle, createEdge, getParticle } from '../../src/particles/particleRepo.js';
import { queryWrite } from '../../src/db.js';

describe('particleRepo 跨租户防御 (F1)', () => {
  const T1 = 'rbac-t1', T2 = 'rbac-t2';
  let p1, p2;
  beforeAll(async () => {
    // CRM_DEAL.identity=['name'] → identityRecordFor 物化 meta_attr required=true(created_by='seed')，
    // 裸 payload='{}' 会在 updateParticle 的 6.6 写时校验（normalizeFacts）抛 "required 属性缺失: name"。
    // 固件补 name 贴合元模型契约（F1 用例聚焦租户防御，不经 createParticle 全链路）。
    const a = await queryWrite(`INSERT INTO crm.particles (tenant_id,type,slug,title,state,payload) VALUES ($1,'CRM_DEAL','rbac-p1','p1','ACTIVE','{"name":"rbac-p1"}') RETURNING *`, [T1]);
    const b = await queryWrite(`INSERT INTO crm.particles (tenant_id,type,slug,title,state,payload) VALUES ($1,'CRM_DEAL','rbac-p2','p2','ACTIVE','{"name":"rbac-p2"}') RETURNING *`, [T2]);
    p1 = a.rows[0]; p2 = b.rows[0];
  });
  afterAll(async () => {
    await queryWrite(`DELETE FROM crm.edges WHERE source_id = $1 OR source_id = $2`, [p1.id, p2.id]);
    await queryWrite(`DELETE FROM crm.particles WHERE slug IN ('rbac-p1','rbac-p2')`);
  });

  it('T2.1 改本租户粒子正常', async () => {
    const r = await updateParticle(p1.id, { patch: { x: 1 }, tenantId: T1 });
    expect(r.id).toBe(p1.id);
  });

  it('T2.2 改他租户粒子抛 cross_tenant_write_denied', async () => {
    await expect(updateParticle(p2.id, { patch: { x: 1 }, tenantId: T1 })).rejects.toThrow(/cross_tenant_write_denied/);
  });

  it('T2.3 不传 tenantId 向后兼容', async () => {
    const r = await updateParticle(p1.id, { patch: { y: 2 } });
    expect(r.id).toBe(p1.id);
  });

  it('T2.4 system 租户豁免（平台/admin 跨租户写不被误伤）', async () => {
    const r = await updateParticle(p2.id, { patch: { z: 3 }, tenantId: 'system' });
    expect(r.id).toBe(p2.id);
  });

  it('T2.5 createEdge 跨租户源粒子拒绝', async () => {
    await expect(createEdge('CRM_DEAL', p2.id, 'evidenced_by', 'CRM_UNSTRUCTURED_ASSET', 'rbac-asset-x', {}, T1))
      .rejects.toThrow(/cross_tenant_write_denied/);
  });
});
