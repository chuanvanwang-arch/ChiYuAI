import { describe, it, expect } from 'vitest';
import { createEntityResolver } from 'file:///D:/system/CRM-ai-native/src/sync/resolver.js';

function fakePool() {
  const refs = [];
  const particles = [];
  return {
    refs,
    particles,
    query: async (sql, params) => {
      if (sql.includes('SELECT * FROM crm.external_ref')) {
        const hit = refs.find(r => r.tenant_id === params[0] && r.provider === params[1] && r.external_object === params[2] && r.external_id === params[3]);
        return { rows: hit ? [hit] : [] };
      }
      if (sql.includes('INSERT INTO crm.external_ref')) {
        const ref = { id: 'r' + (refs.length + 1), tenant_id: params[0], provider: params[1], external_object: params[2], external_id: params[3], particle_type: params[4], particle_id: params[5], external_deleted_at: null };
        refs.push(ref);
        return { rows: [ref] };
      }
      if (sql.includes('UPDATE crm.external_ref')) {
        // markDeleted: WHERE id=$1, SET external_deleted_at=now() → mock 用真 Date 模拟 DB now()
        const hit = refs.find(r => r.id === params[0]);
        if (hit) Object.assign(hit, { external_deleted_at: new Date(), updated_at: new Date() });
        return { rows: hit ? [hit] : [] };
      }
      if (sql.includes('INSERT INTO crm.particles')) {
        const p = { id: params[0], type: params[1], tenant_id: params[2], payload: params[3] };
        particles.push(p);
        return { rows: [p] };
      }
      if (sql.includes('UPDATE crm.particles')) {
        const p = particles.find(x => x.id === params[0]);
        if (p) p.payload = params[1];
        return { rows: p ? [p] : [] };
      }
      return { rows: [] };
    },
  };
}

describe('entityResolver（幂等对齐 + 软删除）', () => {
  it('同 external_id 二次 upsert 命中既有 particle_id 不新建', async () => {
    const pool = fakePool();
    const r = createEntityResolver({ pool });
    const first = await r.upsert({ tenantId: 't1', provider: 'mock', object: 'AccountObj', externalId: 'acc-1', particleType: 'CRM_ACCOUNT', payload: { name: '客户A' } });
    expect(first.created).toBe(true);
    const second = await r.upsert({ tenantId: 't1', provider: 'mock', object: 'AccountObj', externalId: 'acc-1', particleType: 'CRM_ACCOUNT', payload: { name: '客户A改' } });
    expect(second.created).toBe(false);
    expect(second.updated).toBe(true);
    expect(second.particle_id).toBe(first.particle_id);
    expect(pool.particles.length).toBe(1); // 不新建粒子
  });

  it('external_deleted_at 软标记后原粒子仍存在（零 DELETE）', async () => {
    const pool = fakePool();
    const r = createEntityResolver({ pool });
    await r.upsert({ tenantId: 't1', provider: 'mock', object: 'AccountObj', externalId: 'acc-2', particleType: 'CRM_ACCOUNT', payload: { name: '客户B' } });
    await r.markDeleted({ tenantId: 't1', provider: 'mock', object: 'AccountObj', externalId: 'acc-2' });
    expect(pool.particles.length).toBe(1); // 粒子仍存在
    expect(pool.refs.find(x => x.external_id === 'acc-2').external_deleted_at).toBeTruthy();
  });
});
