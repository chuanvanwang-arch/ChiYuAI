// test/meta-model/adaptive-tenant.test.js
// P1: ensureAdaptiveRegistration 带 tenantId 登记；listMetaAttr 按 tenant 过滤（零污染）。
import { describe, it, expect, beforeEach } from 'vitest';
import { ensureAdaptiveRegistration, listMetaAttr } from '../../src/metaAttr/metaAttrRepo.js';
import { queryWrite, query } from '../../src/db.js';

describe('P1 meta-model per-tenant isolation', () => {
  beforeEach(async () => {
    await queryWrite(`DELETE FROM crm.meta_attr WHERE tenant_id IN ('acme','other') AND particle_type='CRM_ACCOUNT'`);
  });

  it('ensureAdaptiveRegistration registers under calling tenant', async () => {
    await ensureAdaptiveRegistration('CRM_ACCOUNT', { training_budget: 100 }, 'acme');
    const r = await query(
      `SELECT tenant_id FROM crm.meta_attr WHERE particle_type='CRM_ACCOUNT' AND attr_slug='training_budget' AND tenant_id='acme'`);
    expect(r.rows.length).toBe(1);
    expect(r.rows[0].tenant_id).toBe('acme');
  });

  it('listMetaAttr filters by tenant (no cross-tenant leak)', async () => {
    await ensureAdaptiveRegistration('CRM_ACCOUNT', { training_budget: 100 }, 'acme');
    const otherRows = await listMetaAttr({ particleType: 'CRM_ACCOUNT', tenantId: 'other' });
    expect(otherRows.find((r) => r.attr_slug === 'training_budget')).toBeUndefined();
    const ownRows = await listMetaAttr({ particleType: 'CRM_ACCOUNT', tenantId: 'acme' });
    expect(ownRows.find((r) => r.attr_slug === 'training_budget')).toBeDefined();
  });
});
