import { describe, it, expect, beforeEach } from 'vitest';
import { query } from '../src/db.js';
import { ensureGraph, addDecision, addEdge } from '../src/decision/ageGraph.js';
import { createDecision } from '../src/decision/decisionRepo.js';
import { traceDecision, getImpact, getInsights } from '../src/decision/decisionTrace.js';

beforeEach(async () => {
  await query('TRUNCATE crm.decision, crm.decision_precedent_rel, crm.decision_event, crm.memory_log RESTART IDENTITY CASCADE');
  const g = await ensureGraph();
  expect(g.ok).toBe(true);
});

describe('traceDecision（因果链）', () => {
  it('upstream 多跳 + 因果距离 + 置信度衰减（近者更可信）', async () => {
    await addDecision({ decision_id: 'd1', scenario_id: 'LEAD_FOLLOW_UP', disposition: 'REJECT', business_tier: 'HIGH', state: 'AUTONOMOUS', rationale: 'r' });
    await addDecision({ decision_id: 'd2', scenario_id: 'LEAD_FOLLOW_UP', disposition: 'REJECT', business_tier: 'HIGH', state: 'AUTONOMOUS', rationale: 'r' });
    await addDecision({ decision_id: 'd3', scenario_id: 'LOSS_REVIEW', disposition: 'REJECT', business_tier: 'HIGH', state: 'AUTONOMOUS', rationale: 'r' });
    await addEdge('OVERRIDES', 'd3', 'd2', {});
    await addEdge('OVERRIDES', 'd2', 'd1', {});
    const chain = await traceDecision('d3', { direction: 'upstream', maxDepth: 3 });
    expect(chain.length).toBeGreaterThanOrEqual(2);
    const d2 = chain.find((n) => n.decision_id === 'd2');
    const d1 = chain.find((n) => n.decision_id === 'd1');
    expect(d2.distance).toBeLessThanOrEqual(d1.distance);
    expect(d2.confidence).toBeGreaterThan(d1.confidence);
    expect(d2.relation).toBe('UPSTREAM');
  });

  it('downstream（导致了什么）可答', async () => {
    await addDecision({ decision_id: 'd1', scenario_id: 'LEAD_FOLLOW_UP', disposition: 'REJECT', business_tier: 'HIGH', state: 'AUTONOMOUS', rationale: 'r' });
    await addDecision({ decision_id: 'd2', scenario_id: 'LOSS_REVIEW', disposition: 'REJECT', business_tier: 'HIGH', state: 'AUTONOMOUS', rationale: 'r' });
    await addEdge('OVERRIDES', 'd2', 'd1', {});
    const chain = await traceDecision('d1', { direction: 'downstream', maxDepth: 3 });
    expect(chain.map((n) => n.decision_id)).toContain('d2');
  });
});

describe('getImpact（影响地图）', () => {
  it('下游节点 + 边 + 深度', async () => {
    await addDecision({ decision_id: 'd1', scenario_id: 'QUOTE_PRICING', disposition: 'APPROVE', business_tier: 'NORMAL', state: 'AUTONOMOUS', rationale: 'r' });
    await addDecision({ decision_id: 'd2', scenario_id: 'QUOTE_PRICING', disposition: 'APPROVE', business_tier: 'NORMAL', state: 'AUTONOMOUS', rationale: 'r' });
    await addEdge('CAUSED', 'd1', 'd2', {});
    const imp = await getImpact('d1', { maxDepth: 3 });
    expect(imp.root).toBe('d1');
    expect(imp.nodes.map((n) => n.decision_id)).toContain('d2');
    expect(Array.isArray(imp.edges)).toBe(true);
    expect(imp.depth).toBeGreaterThanOrEqual(1);
  });
});

describe('getInsights（洞察统计）', () => {
  it('聚合七闸门：per-scenario 自主/升级/逆转统计', async () => {
    await createDecision({ scenario_id: 'SIGN_RISK', trigger_context: {}, conditions_evaluated: [], disposition: 'ESCALATE', decider_type: 'AUTONOMOUS_AGENT', rationale: 'r', business_tier: 'HIGH', state: 'ESCALATED' });
    const ins = await getInsights({ scenario_id: 'SIGN_RISK' });
    expect(ins.scenario_id).toBe('SIGN_RISK');
    expect(ins.totals.escalated).toBeGreaterThanOrEqual(1);
    expect(ins.totals.total).toBeGreaterThanOrEqual(1);
    expect(ins.reversal_rate).toBeGreaterThanOrEqual(0);
  });
});
