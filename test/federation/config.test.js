// test/federation/config.test.js — 联邦关系配置（config_store 封装 + decision_id 第0闸）
import { describe, it, expect } from 'vitest';
import {
  getFederation, createFederation, addDealer, grantSharedView,
  listSharedViews, addConflict, listConflicts, resolveConflict,
} from '../../src/federation/config.js';

function makeStore() {
  const m = new Map();
  const readConfig = async (key, { tenantId = 'system' } = {}) => {
    const r = m.get(`${tenantId}::${key}`);
    return r ? { value: r.value, decision_id: r.decision_id } : null;
  };
  const writeConfig = async (key, value, { tenantId = 'system', decisionId = null } = {}) => {
    m.set(`${tenantId}::${key}`, { value: JSON.parse(JSON.stringify(value)), decision_id: decisionId });
    return { ok: true };
  };
  return { m, readConfig, writeConfig };
}

describe('联邦主记录（tenant-federation + 反向指针）', () => {
  it('createFederation 带 decision_id → 主记录 + 经销商反向指针落库', async () => {
    const s = makeStore();
    const fed = await createFederation(
      { vendorTenant: 'acme-mfg', dealers: [{ dealer_tenant: 'acme-mfg-dl-01' }], decisionId: 'D1' },
      s,
    );
    expect(fed.vendor_tenant).toBe('acme-mfg');
    // vendor 侧主记录
    expect(await getFederation('acme-mfg', s)).toBeTruthy();
    // 经销商反查命中同一联邦（O(1)）
    expect(await getFederation('acme-mfg-dl-01', s)).toMatchObject({ vendor_tenant: 'acme-mfg' });
  });

  it('createFederation 缺 decision_id → 红线拒绝', async () => {
    const s = makeStore();
    await expect(createFederation({ vendorTenant: 'acme-mfg', dealers: [] }, s)).rejects.toThrow(/decision_id/);
  });

  it('addDealer 增量加入并写反向指针；缺 decision_id 拒绝', async () => {
    const s = makeStore();
    await createFederation({ vendorTenant: 'acme-mfg', dealers: [{ dealer_tenant: 'acme-mfg-dl-01' }], decisionId: 'D1' }, s);
    const fed = await addDealer({ vendorTenant: 'acme-mfg', dealerTenant: 'acme-mfg-dl-02', decisionId: 'D2' }, s);
    expect(fed.dealers.map((d) => d.dealer_tenant)).toContain('acme-mfg-dl-02');
    expect(await getFederation('acme-mfg-dl-02', s)).toBeTruthy();
    await expect(addDealer({ vendorTenant: 'acme-mfg', dealerTenant: 'acme-mfg-dl-03' }, s)).rejects.toThrow(/decision_id/);
  });
});

describe('共享视图授权（shared-view-grant）', () => {
  it('grantSharedView push/reflow 双向落库；缺 decision_id 拒绝', async () => {
    const s = makeStore();
    await createFederation({ vendorTenant: 'acme-mfg', dealers: [{ dealer_tenant: 'acme-mfg-dl-01' }], decisionId: 'D1' }, s);
    const g1 = await grantSharedView({ vendorTenant: 'acme-mfg', toTenant: 'acme-mfg-dl-01', direction: 'push', particleTypes: ['CRM_OFFER_POLICY'], decisionId: 'D2' }, s);
    const g2 = await grantSharedView({ vendorTenant: 'acme-mfg', toTenant: 'acme-mfg-dl-01', direction: 'reflow', particleTypes: ['MFG_PROJECT'], decisionId: 'D3' }, s);
    expect(g1.find((g) => g.direction === 'push').from_tenant).toBe('acme-mfg');
    expect(g2.find((g) => g.direction === 'reflow').to_tenant).toBe('acme-mfg');
    expect(await listSharedViews('acme-mfg', s)).toHaveLength(2);
    await expect(grantSharedView({ vendorTenant: 'acme-mfg', toTenant: 'acme-mfg-dl-01', direction: 'push' }, s)).rejects.toThrow(/decision_id/);
  });
});

describe('冲突日志（dealer-conflict-log）', () => {
  it('addConflict 校验必填；resolveConflict 需 decision_id 且可置 resolved', async () => {
    const s = makeStore();
    await createFederation({ vendorTenant: 'acme-mfg', dealers: [{ dealer_tenant: 'acme-mfg-dl-01' }, { dealer_tenant: 'acme-mfg-dl-02' }], decisionId: 'D1' }, s);
    await expect(addConflict({ vendorTenant: 'acme-mfg', conflict: { territory: '华东' } }, s)).rejects.toThrow(/territory\/dealer_a\/dealer_b/);
    const rec = await addConflict({ vendorTenant: 'acme-mfg', conflict: { territory: '华东', dealer_a: 'acme-mfg-dl-01', dealer_b: 'acme-mfg-dl-02' }, decisionId: 'D2' }, s);
    expect(rec.status).toBe('open');
    expect(await listConflicts('acme-mfg', s)).toHaveLength(1);
    const resolved = await resolveConflict({ vendorTenant: 'acme-mfg', detectedAt: rec.detected_at, resolution: '归 dl-01', decisionId: 'D3' }, s);
    expect(resolved.status).toBe('resolved');
    await expect(resolveConflict({ vendorTenant: 'acme-mfg', detectedAt: rec.detected_at, resolution: 'x' }, s)).rejects.toThrow(/decision_id/);
  });
});
