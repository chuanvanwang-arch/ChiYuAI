// test/provenance-chain.test.js — P3 写时溯源：决策写后落 provenance，SHA-256 链可校验、可导出
import { describe, it, expect, beforeEach } from 'vitest';
import { query } from '../src/db.js';
import { ensureProvenanceSchema, verifyChain, exportAudit } from '../src/decision/provenance.js';
import { createDecision } from '../src/decision/decisionRepo.js';

beforeEach(async () => {
  await query('TRUNCATE crm.decision, crm.decision_provenance, crm.decision_precedent_rel, crm.decision_event, crm.memory_log RESTART IDENTITY CASCADE');
  await ensureProvenanceSchema();
});

describe('P3 溯源链', () => {
  it('决策写后落 provenance，verifyChain=OK，exportAudit 含决策与链状态', async () => {
    const d = await createDecision({
      scenario_id: 'LEAD_FOLLOW_UP', trigger_context: { src: 'agent' },
      conditions_evaluated: [], disposition: 'APPROVE',
      decider_type: 'AUTONOMOUS_AGENT', rationale: 'r', business_tier: 'NORMAL', state: 'AUTONOMOUS',
    });
    const chain = await verifyChain({ decision_id: d.decision_id });
    expect(chain.status).toBe('OK');
    expect(chain.entries).toBeGreaterThanOrEqual(1);

    const audit = await exportAudit({ decision_id: d.decision_id });
    expect(audit.decision_id).toBe(d.decision_id);
    expect(audit.chainStatus).toBe('OK');
    expect(Array.isArray(audit.entries)).toBe(true);
    expect(audit.entries.length).toBeGreaterThanOrEqual(1);
  });
});
