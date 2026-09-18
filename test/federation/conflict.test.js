// test/federation/conflict.test.js — 冲突检测（G3 窜货/撞单 + G6 归属，1:N 聚合）
import { describe, it, expect } from 'vitest';
import { detectTerritoryConflict } from '../../src/federation/conflict.js';

const FED = {
  vendor_tenant: 'acme-mfg',
  dealers: [
    { dealer_tenant: 'acme-mfg-dl-01', status: 'active' },
    { dealer_tenant: 'acme-mfg-dl-02', status: 'active' },
  ],
};
const getFederation = async () => FED;

function fixtureParticles(rows) {
  return async () => rows;
}

describe('detectTerritoryConflict', () => {
  it('同 territory 跨经销商 → 记冲突（自动仲裁替代人工报备）', async () => {
    const added = [];
    const rec = await detectTerritoryConflict(
      {
        vendorTenant: 'acme-mfg',
        newProject: { dealer_tenant: 'acme-mfg-dl-01', territory: '华东-苏州', slug: 'p-new', ref: 'MFG_PROJECT#p-new' },
        decisionId: 'D9',
      },
      {
        getFederation,
        listParticles: fixtureParticles([
          { tenant_id: 'acme-mfg-dl-02', type: 'MFG_PROJECT', slug: 'p-old', payload: { territory: '华东-苏州', state: 'reported' } },
        ]),
        addConflict: async (x) => { added.push(x); return { ...x.conflict, status: 'open' }; },
      },
    );
    expect(rec).toBeTruthy();
    expect(rec.dealer_a).toBe('acme-mfg-dl-01');
    expect(rec.dealer_b).toBe('acme-mfg-dl-02');
    expect(rec.territory).toBe('华东-苏州');
    expect(added).toHaveLength(1);
  });

  it('异 territory → 不记冲突', async () => {
    const rec = await detectTerritoryConflict(
      { vendorTenant: 'acme-mfg', newProject: { dealer_tenant: 'acme-mfg-dl-01', territory: '华北', slug: 'p-new' }, decisionId: 'D9' },
      {
        getFederation,
        listParticles: fixtureParticles([{ tenant_id: 'acme-mfg-dl-02', type: 'MFG_PROJECT', slug: 'p-old', payload: { territory: '华东-苏州', state: 'reported' } }]),
        addConflict: async () => { throw new Error('不应调用'); },
      },
    );
    expect(rec).toBeNull();
  });

  it('仅一个经销商（无其他方比对）→ 不记冲突', async () => {
    const rec = await detectTerritoryConflict(
      { vendorTenant: 'acme-mfg', newProject: { dealer_tenant: 'acme-mfg-dl-01', territory: '华东', slug: 'p-new' }, decisionId: 'D9' },
      {
        getFederation: async () => ({ vendor_tenant: 'acme-mfg', dealers: [{ dealer_tenant: 'acme-mfg-dl-01', status: 'active' }] }),
        listParticles: fixtureParticles([]),
        addConflict: async () => { throw new Error('不应调用'); },
      },
    );
    expect(rec).toBeNull();
  });

  it('已丢单（state=lost）不参与冲突', async () => {
    const rec = await detectTerritoryConflict(
      { vendorTenant: 'acme-mfg', newProject: { dealer_tenant: 'acme-mfg-dl-01', territory: '华东', slug: 'p-new' }, decisionId: 'D9' },
      {
        getFederation,
        listParticles: fixtureParticles([{ tenant_id: 'acme-mfg-dl-02', type: 'MFG_PROJECT', slug: 'p-old', payload: { territory: '华东', state: 'lost' } }]),
        addConflict: async () => { throw new Error('不应调用'); },
      },
    );
    expect(rec).toBeNull();
  });
});
