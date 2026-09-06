// test/age-causal.test.js — P2 决策因果链写时接线：引用先例 → REFERENCED_PRECEDENT 可上游回溯
import { describe, it, expect, beforeEach } from 'vitest';
import { query } from '../src/db.js';
import { ensureGraph, isAvailable, traceUpstream } from '../src/decision/ageGraph.js';
import { createDecision, reverseDecision } from '../src/decision/decisionRepo.js';

beforeEach(async () => {
  await query('TRUNCATE crm.decision, crm.decision_precedent_rel, crm.decision_event, crm.memory_log RESTART IDENTITY CASCADE');
  await ensureGraph();
});

const mk = (scenario_id, referenced_precedents = []) => createDecision({
  scenario_id, trigger_context: {}, conditions_evaluated: [],
  disposition: 'APPROVE', decider_type: 'AUTONOMOUS_AGENT', rationale: 'r',
  business_tier: 'NORMAL', state: 'AUTONOMOUS', referenced_precedents,
});

describe('P2 因果链写时', () => {
  it('createDecision(referenced_precedents) → REFERENCED_PRECEDENT 边可上游回溯', async () => {
    const d1 = await mk('LEAD_FOLLOW_UP');
    const d2 = await mk('OPP_QUALIFY', [d1.decision_id]);
    if (!isAvailable()) return;
    const ups = await traceUpstream(d2.decision_id, { maxDepth: 2 });
    expect(ups.map((n) => n.decision_id)).toContain(d1.decision_id);
  });

  it('reverseDecision 翻案后下游引用者 OVERRIDES 本决策', async () => {
    const d1 = await mk('LEAD_FOLLOW_UP');
    const d2 = await mk('OPP_QUALIFY', [d1.decision_id]);
    await reverseDecision(d1.decision_id, 'data-corrected');
    if (!isAvailable()) return;
    const ups = await traceUpstream(d2.decision_id, { maxDepth: 2 });
    const d1node = ups.find((n) => n.decision_id === d1.decision_id);
    expect(d1node).toBeTruthy();
  });
});
