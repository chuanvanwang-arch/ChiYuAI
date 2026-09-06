// test/calc/formulaEngine.test.js
// P4(T12-T13): 沙箱公式求值 + 租户 profile on_write 自动计算（结算佣金）。
import { describe, it, expect, beforeEach } from 'vitest';
import { evalFormula, runProfileCalculations } from '../../src/calc/formulaEngine.js';
import { createParticle } from '../../src/particles/particleRepo.js';
import { seedTrainingProfile, TRAINING_TENANT } from '../../db/seed/tenant-profile-training.js';
import { queryWrite } from '../../src/db.js';

describe('formulaEngine', () => {
  it('evaluates arithmetic with inputs', () => {
    expect(evalFormula('(revenue - cost) * commission_rate', { revenue: 100, cost: 60, commission_rate: 0.1 })).toBe(4);
  });
  it('neutralizes dangerous globals (sandbox has no process) → fail-safe null', () => {
    // 沙箱不含 process/require，表达式触发 ReferenceError → 捕获返回 null，绝不停进程
    expect(evalFormula('process.exit(1)', {})).toBeNull();
  });
  it('returns null on undefined input (fail-safe)', () => {
    expect(evalFormula('revenue * 2', {})).toBeNull();
  });
});

describe('runProfileCalculations on_write', () => {
  beforeEach(async () => {
    await seedTrainingProfile(TRAINING_TENANT);
    await queryWrite(`DELETE FROM crm.particles WHERE tenant_id='${TRAINING_TENANT}'`);
  });

  it('settlement auto-computes commission on write', async () => {
    const p = await createParticle(
      'TRAINING_SETTLEMENT',
      { slug: 's1', title: '结算1', revenue: 100, cost: 60, commission_rate: 0.1 },
      { tenantId: TRAINING_TENANT }
    );
    expect(p.payload.commission).toBe(4);
  });

  it('runProfileCalculations returns computed payload subset', async () => {
    const out = await runProfileCalculations('TRAINING_SETTLEMENT', { revenue: 200, cost: 100, commission_rate: 0.2 }, TRAINING_TENANT);
    expect(out.commission).toBe(20);
  });

  it('no calculation for crm baseline tenant (isolation)', async () => {
    const out = await runProfileCalculations('CRM_DEAL', { revenue: 100, cost: 60, commission_rate: 0.1 }, 'crm');
    expect(out).toEqual({});
  });
});
