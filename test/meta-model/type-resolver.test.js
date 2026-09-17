// test/meta-model/type-resolver.test.js
// P2(G1): resolvePrototype 双源解析（代码基线 ∪ 租户 tenant-profile）+ 培训租户 seed 端到端示例。
import { describe, it, expect } from 'vitest';
import { resolvePrototype, isConfigurablePrototype } from '../../src/particles/particleModel.js';
import { seedTrainingProfile } from '../../db/seed/tenant-profile-training.js';
import { TRAINING_TENANT } from '../fixtures/testTenantIds.js';

describe('resolvePrototype dual-source', () => {
  it('CRM types resolve from code baseline (no tenant)', async () => {
    const def = await resolvePrototype('CRM_DEAL', 'crm');
    expect(def.source).toBe('code');
    expect(def.type).toBe('CRM_DEAL');
  });

  it('training type resolves from tenant-profile config', async () => {
    await seedTrainingProfile(TRAINING_TENANT);
    const def = await resolvePrototype('TRAINING_PROJECT', TRAINING_TENANT);
    expect(def.source).toBe('config');
    expect(def.flow).toContain('quoted');
  });

  it('training type invisible in crm tenant (isolation)', async () => {
    const def = await resolvePrototype('TRAINING_PROJECT', 'crm');
    expect(def).toBeNull();
  });

  it('isConfigurablePrototype distinguishes baseline vs custom', () => {
    expect(isConfigurablePrototype('CRM_DEAL')).toBe(false);
    expect(isConfigurablePrototype('TRAINING_PROJECT')).toBe(true);
  });
});

describe('training tenant-profile seed (P2/T10)', () => {
  it('seeds 6 prototypes under training tenant', async () => {
    await seedTrainingProfile(TRAINING_TENANT);
    const p = await resolvePrototype('TRAINING_PROJECT', TRAINING_TENANT);
    expect(p.flow).toContain('quoted');
    expect(await resolvePrototype('TRAINING_PROJECT', 'crm')).toBeNull(); // 隔离
    // 6 个 prototype 全部可解析
    for (const t of ['TRAINING_CLIENT', 'TRAINER', 'TRAINING_PROVIDER', 'TRAINING_PROJECT', 'TRAINING_CONTRACT', 'TRAINING_SETTLEMENT']) {
      expect(await resolvePrototype(t, TRAINING_TENANT)).not.toBeNull();
    }
  });
});
