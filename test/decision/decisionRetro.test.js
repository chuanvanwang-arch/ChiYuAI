// test/decision/decisionRetro.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildRequirementRetro, runDailyRetro } from '../../src/decision/decisionRetro.js';
import { assertRequirementEvidence } from '../../src/decision/methodologyEvidence.js';
import { writeConfig } from '../../src/config/configStore.js';
import { createDecisionFixture, dropDecisionFixture } from './decisionFixture.js';

const T = 'plan-t7-' + Date.now();
let DEC;
beforeAll(async () => {
  DEC = await createDecisionFixture();
  await writeConfig('requirement-dimensions', {
    levels: ['MUST', 'SHOULD', 'NICE'],
    dimensions: [
      { dim_key: 'REQ_WRITTEN_APPROVAL', label: '书面批文', level: 'MUST' },
      { dim_key: 'REQ_PRICE_BASELINE', label: '报价基线确认', level: 'MUST' },
    ],
  }, { tenantId: 'system' });
});
afterAll(async () => { await dropDecisionFixture(DEC); });

describe('buildRequirementRetro', () => {
  it('汇总 MUST 未确认 Top3 与红线命中率', () => {
    const r = buildRequirementRetro({
      requirementByDeal: {
        d1: { mustUnconfirmed: ['REQ_WRITTEN_APPROVAL', 'REQ_PRICE_BASELINE'] },
        d2: { mustUnconfirmed: ['REQ_WRITTEN_APPROVAL'] },
      },
      redlineHits: 3, totalAdvices: 10,
    });
    expect(r.mustUnconfirmedTop3[0].dealId).toBe('d1');
    expect(r.mustUnconfirmedTop3.length).toBe(2);
    expect(r.redlineHitRate).toBe(30);
    expect(r.cases.length).toBeGreaterThan(0);
  });
});

describe('runDailyRetro (DB)', () => {
  it('从 REQUIREMENT 证据产出可检索案例', async () => {
    await assertRequirementEvidence({ subject_id: 'deal-t7', dim_key: 'REQ_WRITTEN_APPROVAL', met: false, tenantId: T, decision_id: DEC }).catch(() => {});
    const rep = await runDailyRetro(T);
    expect(Array.isArray(rep.mustUnconfirmedTop3)).toBe(true);
    const hit = rep.mustUnconfirmedTop3.find((d) => d.dealId === 'deal-t7');
    expect(hit?.mustUnconfirmed || []).toContain('REQ_WRITTEN_APPROVAL');
  });
});
