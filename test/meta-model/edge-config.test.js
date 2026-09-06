// test/meta-model/edge-config.test.js
// P3(G3/G4): 受控谓词 = 基线 ∪ 租户 profile.edgeTypes；createEdge 校验 + cardinality 落库。
import { describe, it, expect, beforeEach } from 'vitest';
import { createEdge } from '../../src/particles/particleRepo.js';
import { isControlledPredicateConfig } from '../../src/particles/particleModel.js';
import { seedTrainingProfile, TRAINING_TENANT } from '../../db/seed/tenant-profile-training.js';
import { queryWrite, query } from '../../src/db.js';

describe('edge predicate config (P3)', () => {
  const A = '11111111-1111-1111-1111-111111111111';
  const C = '22222222-2222-2222-2222-222222222222';
  const P = '33333333-3333-3333-3333-333333333333';
  const Y = '44444444-4444-4444-4444-444444444444';
  beforeEach(async () => {
    await seedTrainingProfile(TRAINING_TENANT);
    await queryWrite(`DELETE FROM crm.edges WHERE tenant_id IN ('acme-training','crm')`);
  });

  it('rejects edge_type not in baseline ∪ tenant profile', async () => {
    await expect(
      createEdge('TRAINER', A, 'illegal_pred', 'TRAINING_PROJECT', Y, {}, TRAINING_TENANT)
    ).rejects.toThrow(/未受控/);
  });

  it('accepts profile-declared edge_type (supplies)', async () => {
    const edge = await createEdge('TRAINING_PROVIDER', P, 'supplies', 'TRAINING_PROJECT', Y, {}, TRAINING_TENANT);
    expect(edge).toBeDefined();
    expect(edge.edge_type).toBe('supplies');
    expect(edge.cardinality).toBe('many');
  });

  it('accepts baseline controlled predicate (crm tenant)', async () => {
    const edge = await createEdge('CRM_ACCOUNT', A, 'key_contact', 'CRM_CONTACT', C, {}, 'crm');
    expect(edge).toBeDefined();
    expect(edge.cardinality).toBe('many');
  });

  it('isControlledPredicateConfig: baseline + config union', async () => {
    expect(await isControlledPredicateConfig('key_contact', 'crm')).toBe(true);
    expect(await isControlledPredicateConfig('supplies', TRAINING_TENANT)).toBe(true);
    expect(await isControlledPredicateConfig('supplies', 'crm')).toBe(false); // 隔离
  });
});
