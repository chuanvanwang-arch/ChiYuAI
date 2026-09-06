// test/meta-model/field-visibility.test.js
// P5(T15): 逐字段可见性按 tenant 生效（permission.deny_tenants 隐藏）。
import { describe, it, expect, beforeEach } from 'vitest';
import { setMetaAttr, listMetaAttr, ensureAdaptiveRegistration } from '../../src/metaAttr/metaAttrRepo.js';
import { queryWrite } from '../../src/db.js';

describe('per-field visibility by tenant (P5/T15)', () => {
  beforeEach(async () => {
    await queryWrite(`DELETE FROM crm.meta_attr WHERE particle_type='CRM_ACCOUNT' AND attr_slug='salary'`);
    await ensureAdaptiveRegistration('CRM_ACCOUNT', { salary: 'currency' }, 'system');
  });

  it('hides attr when permission denies tenant', async () => {
    await setMetaAttr('CRM_ACCOUNT', 'salary', { permission: { deny_tenants: ['acme'] }, enabled: true }, { tenantId: 'system' });
    const rows = await listMetaAttr({ particleType: 'CRM_ACCOUNT', tenantId: 'acme', applyPermission: true });
    expect(rows.find((r) => r.attr_slug === 'salary')).toBeUndefined();
  });

  it('visible when permission does not deny tenant', async () => {
    await setMetaAttr('CRM_ACCOUNT', 'salary', { permission: { deny_tenants: ['acme'] }, enabled: true }, { tenantId: 'system' });
    const rows = await listMetaAttr({ particleType: 'CRM_ACCOUNT', tenantId: 'other', applyPermission: true });
    expect(rows.find((r) => r.attr_slug === 'salary')).toBeDefined();
  });

  it('no filtering when applyPermission false', async () => {
    await setMetaAttr('CRM_ACCOUNT', 'salary', { permission: { deny_tenants: ['acme'] }, enabled: true }, { tenantId: 'system' });
    const rows = await listMetaAttr({ particleType: 'CRM_ACCOUNT', tenantId: 'acme' });
    expect(rows.find((r) => r.attr_slug === 'salary')).toBeDefined();
  });
});
