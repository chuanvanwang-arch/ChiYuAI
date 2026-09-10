import { collectRequirementEvidence } from '../src/decision/requirementConditions.js';
import { loadMethodologyEvidence } from '../src/decision/methodologyEvidence.js';
import { writeConfig } from '../src/config/configStore.js';

const T = 'debug-' + Date.now();
const DEC = '11111111-1111-1111-1111-111111111111';
await writeConfig('requirement-dimensions', { levels: ['MUST','SHOULD','NICE'], dimensions: [
  { dim_key: 'REQ_PRICE_BASELINE', label: '报价基线确认', level: 'MUST' },
  { dim_key: 'REQ_TRIAL', label: '试用安排', level: 'NICE' },
] }, { tenantId: 'system' });

const out = await collectRequirementEvidence('deal-dbg', [
  { dim_key: 'REQ_PRICE_BASELINE', met: true, evidence_ref: 'doc-1' },
  { dim_key: 'REQ_TRIAL', met: false },
], { tenantId: T, assertedBy: 'alice', decisionId: DEC, source: 'manual' });
console.log('collect out:', JSON.stringify(out, null, 2));

const ev = await loadMethodologyEvidence({ subject_id: 'deal-dbg', methodology_ids: ['REQUIREMENT'], tenantId: T });
console.log('loaded ev:', JSON.stringify(ev, null, 2));
