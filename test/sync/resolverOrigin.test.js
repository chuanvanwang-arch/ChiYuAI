// test/sync/resolverOrigin.test.js — P0-3（ROX §1.3③ 变更来源判定·防回环）
// 判据：
//   ① 回写成功 markOutbound → external_ref.last_direction='out' + last_hash（写入内容哈希）
//   ② 读回同值（回声）→ upsert 返回 echo:true、created=0、updated=0（不计重复、不触发下游信号）
//   ③ 读回不同值（真实外部变更）→ 正常 updated=true，且 last_direction 复位为 'in'
import { describe, it, expect } from 'vitest';
import { createEntityResolver } from '../../src/sync/resolver.js';

function fakePool() {
  const refs = [];
  const particles = [];
  return {
    refs,
    particles,
    query: async (sql, params) => {
      if (sql.startsWith('SELECT * FROM crm.external_ref')) {
        const hit = refs.find((r) => r.tenant_id === params[0] && r.provider === params[1] && r.external_object === params[2] && r.external_id === params[3]);
        return { rows: hit ? [hit] : [] };
      }
      if (sql.startsWith('INSERT INTO crm.external_ref')) {
        const ref = {
          id: 'r' + (refs.length + 1), tenant_id: params[0], provider: params[1], external_object: params[2],
          external_id: params[3], particle_type: params[4], particle_id: params[5],
          last_direction: 'in', last_hash: params[6], external_deleted_at: null,
        };
        refs.push(ref);
        return { rows: [ref] };
      }
      if (sql.startsWith('UPDATE crm.external_ref')) {
        const hit = refs.find((r) => r.id === params[0]);
        if (!hit) return { rows: [] };
        if (sql.includes("last_direction='out'")) {
          hit.last_direction = 'out'; hit.last_hash = params[1]; hit.outbound_at = new Date(); hit.last_synced_at = new Date();
        } else if (sql.includes("last_direction='in'")) {
          hit.last_direction = 'in'; hit.last_hash = params[1]; hit.last_synced_at = new Date(); hit.external_deleted_at = null;
        } else if (sql.includes('last_synced_at')) {
          hit.last_synced_at = new Date();
        }
        if (sql.includes('external_deleted_at=now()')) hit.external_deleted_at = new Date();
        return { rows: [hit] };
      }
      if (sql.startsWith('INSERT INTO crm.particles')) {
        const p = { id: params[0], type: params[1], tenant_id: params[2], payload: params[3] };
        particles.push(p);
        return { rows: [p] };
      }
      if (sql.startsWith('UPDATE crm.particles')) {
        const p = particles.find((x) => x.id === params[0]);
        if (p) p.payload = params[1];
        return { rows: p ? [p] : [] };
      }
      return { rows: [] };
    },
  };
}

describe('resolver 变更来源判定（P0-3）', () => {
  it('markOutbound → last_direction=out + last_hash（写入内容哈希）', async () => {
    const pool = fakePool();
    const r = createEntityResolver({ pool });
    await r.upsert({ tenantId: 't1', provider: 'mock', object: 'AccountObj', externalId: 'acc-1', particleType: 'CRM_ACCOUNT', payload: { name: '客户A' } });
    const m = await r.markOutbound({ tenantId: 't1', provider: 'mock', object: 'AccountObj', externalId: 'acc-1', fields: { name: '客户A' } });
    expect(m.ok).toBe(true);
    expect(m.direction).toBe('out');
    const ref = pool.refs.find((x) => x.external_id === 'acc-1');
    expect(ref.last_direction).toBe('out');
    expect(ref.last_hash).toBeTruthy();
  });

  it('回声（out 且读回==hash）→ echo:true、created=0、updated=0（防回环，不计重复）', async () => {
    const pool = fakePool();
    const r = createEntityResolver({ pool });
    await r.upsert({ tenantId: 't1', provider: 'mock', object: 'AccountObj', externalId: 'acc-1', particleType: 'CRM_ACCOUNT', payload: { name: '客户A' } });
    await r.markOutbound({ tenantId: 't1', provider: 'mock', object: 'AccountObj', externalId: 'acc-1', fields: { name: '客户A' } });
    // 我方写出的被客户侧读回后再次同步进来 → 同值
    const echo = await r.upsert({ tenantId: 't1', provider: 'mock', object: 'AccountObj', externalId: 'acc-1', particleType: 'CRM_ACCOUNT', payload: { name: '客户A' } });
    expect(echo.echo).toBe(true);
    expect(echo.created).toBe(false);
    expect(echo.updated).toBe(false);
    expect(pool.particles.length).toBe(1); // 未新建、未重复更新粒子
    expect(pool.refs.find((x) => x.external_id === 'acc-1').last_direction).toBe('out'); // 仍 out（回声态保留）
  });

  it('真实外部变更（读回≠hash）→ 正常 updated=true，last_direction 复位 in', async () => {
    const pool = fakePool();
    const r = createEntityResolver({ pool });
    await r.upsert({ tenantId: 't1', provider: 'mock', object: 'AccountObj', externalId: 'acc-1', particleType: 'CRM_ACCOUNT', payload: { name: '客户A' } });
    await r.markOutbound({ tenantId: 't1', provider: 'mock', object: 'AccountObj', externalId: 'acc-1', fields: { name: '客户A' } });
    // 客户侧真实改了名字 → 读回不同值（非回声）
    const real = await r.upsert({ tenantId: 't1', provider: 'mock', object: 'AccountObj', externalId: 'acc-1', particleType: 'CRM_ACCOUNT', payload: { name: '客户A改' } });
    expect(real.echo).toBeFalsy();
    expect(real.created).toBe(false);
    expect(real.updated).toBe(true);
    expect(pool.refs.find((x) => x.external_id === 'acc-1').last_direction).toBe('in'); // 复位 in（真实读入）
  });
});
