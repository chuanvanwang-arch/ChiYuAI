// test/decision/requirementConditions.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeConfig } from '../../src/config/configStore.js';
import { loadMethodologyEvidence } from '../../src/decision/methodologyEvidence.js';
import { collectRequirementEvidence, collectFollowupRequirement } from '../../src/decision/requirementConditions.js';
import { createDecisionFixture, dropDecisionFixture } from './decisionFixture.js';

const T = 'plan-t5-' + Date.now();
let DEC;
beforeAll(async () => {
  DEC = await createDecisionFixture();
  await writeConfig('requirement-dimensions', {
    levels: ['MUST', 'SHOULD', 'NICE'],
    dimensions: [
      { dim_key: 'REQ_PRICE_BASELINE', label: '报价基线确认', level: 'MUST' },
      { dim_key: 'REQ_TRIAL', label: '试用安排', level: 'NICE' },
    ],
  }, { tenantId: 'system' });
});
afterAll(async () => {
  await dropDecisionFixture(DEC);
  await writeConfig('requirement-dimensions', { dimensions: [] }, { tenantId: T });
});

describe('collectRequirementEvidence', () => {
  it('写入 REQUIREMENT 证据并可回读', async () => {
    await collectRequirementEvidence('deal-t5', [
      { dim_key: 'REQ_PRICE_BASELINE', met: true, evidence_ref: 'doc-1' },
      { dim_key: 'REQ_TRIAL', met: false },
    ], { tenantId: T, assertedBy: 'alice', decisionId: DEC, source: 'manual' });
    const ev = await loadMethodologyEvidence({ subject_id: 'deal-t5', methodology_ids: ['REQUIREMENT'], tenantId: T });
    expect(ev.REQ_PRICE_BASELINE?.met).toBe(true);
    expect(ev.REQ_PRICE_BASELINE?.evidence_ref).toBe('doc-1');
    expect(ev.REQ_TRIAL?.met).toBe(false);
  });
});

describe('collectFollowupRequirement', () => {
  it('SHOULD/NICE 维度可独立采集（非 MUST 不强制）', async () => {
    const out = await collectFollowupRequirement('deal-t5b', [
      { dim_key: 'REQ_TRIAL', met: true, evidence_ref: 't-1' },
    ], { tenantId: T, assertedBy: 'bob', decisionId: DEC, source: 'auto' });
    expect(out.length).toBe(1);
    const ev = await loadMethodologyEvidence({ subject_id: 'deal-t5b', methodology_ids: ['REQUIREMENT'], tenantId: T });
    expect(ev.REQ_TRIAL?.met).toBe(true);
  });
});
