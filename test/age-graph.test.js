import { describe, it, expect, beforeEach } from 'vitest';
import { query } from '../src/db.js';
import {
  ensureGraph, addDecision, addParticleVertex, addEdge,
  traceUpstream, traceDownstream, impactMap, isAvailable, ctePrecedents,
} from '../src/decision/ageGraph.js';
import { createDecision } from '../src/decision/decisionRepo.js';

// 隔离：仅清空运行时决策表（保留种子 scenario/methodology/policy/tier 配置）
beforeEach(async () => {
  await query('TRUNCATE crm.decision, crm.decision_precedent_rel, crm.decision_event, crm.memory_log RESTART IDENTITY CASCADE');
  const g = await ensureGraph();
  expect(g.ok).toBe(true);
});

describe('C1 幂等启用', () => {
  it('ensureGraph 幂等：扩展+图就绪，重复调用不报错且图仅一条', async () => {
    const r1 = await ensureGraph();
    const r2 = await ensureGraph();
    expect(r1.ok && r2.ok).toBe(true);
    const n = (await query(`SELECT count(*)::int n FROM ag_catalog.ag_graph WHERE name='crm_decision_network'`)).rows[0].n;
    expect(n).toBe(1);
    expect(isAvailable()).toBe(true);
  });
});

describe('C1 顶点/边写', () => {
  it('addDecision 写 Decision 顶点；addEdge 建立决策间 OVERRIDES 边且可多跳回溯', async () => {
    await addDecision({ decision_id: 'g1', scenario_id: 'LEAD_FOLLOW_UP', disposition: 'HOLD', business_tier: 'LEAD', state: 'AUTONOMOUS', rationale: 'r' });
    await addDecision({ decision_id: 'g2', scenario_id: 'OPP_QUALIFY', disposition: 'APPROVE', business_tier: 'NORMAL', state: 'AUTONOMOUS', rationale: 'r' });
    const r = await addEdge('OVERRIDES', 'g2', 'g1', {});
    expect(r.ok).toBe(true);
    const ups = await traceUpstream('g2', { maxDepth: 2 });
    expect(ups.map((n) => n.decision_id)).toContain('g1');
  });

  it('addParticleVertex + DECIDED_ON 边写不报错（决策↔业务粒子）', async () => {
    await addDecision({ decision_id: 'g1', scenario_id: 'LEAD_FOLLOW_UP', disposition: 'HOLD', business_tier: 'LEAD', state: 'AUTONOMOUS', rationale: 'r' });
    const pv = await addParticleVertex('DEAL', 'D1', 'Deal One');
    expect(pv.ok).toBe(true);
    const r = await addEdge('DECIDED_ON', 'g1', { id: 'D1', label: 'DEAL' }, {});
    expect(r.ok).toBe(true);
  });
});

describe('C1 多跳因果链（upstream 为什么 / downstream 导致了什么）', () => {
  beforeEach(async () => {
    await addDecision({ decision_id: 'd1', scenario_id: 'LEAD_FOLLOW_UP', disposition: 'APPROVE', business_tier: 'NORMAL', state: 'AUTONOMOUS', rationale: 'r' });
    await addDecision({ decision_id: 'd2', scenario_id: 'OPP_QUALIFY', disposition: 'APPROVE', business_tier: 'NORMAL', state: 'AUTONOMOUS', rationale: 'r' });
    await addDecision({ decision_id: 'd3', scenario_id: 'QUOTE_PRICING', disposition: 'APPROVE', business_tier: 'NORMAL', state: 'AUTONOMOUS', rationale: 'r' });
    await addEdge('OVERRIDES', 'd3', 'd2', {}); // d3 引用 d2 为先例
    await addEdge('OVERRIDES', 'd2', 'd1', {}); // d2 引用 d1 为先例
  });

  it('upstream(d3) 含 d2,d1，距离近者置信度更高', async () => {
    const chain = await traceUpstream('d3', { maxDepth: 3 });
    const ids = chain.map((n) => n.decision_id);
    expect(ids).toContain('d2');
    expect(ids).toContain('d1');
    const d2 = chain.find((n) => n.decision_id === 'd2');
    const d1 = chain.find((n) => n.decision_id === 'd1');
    expect(d2.distance).toBeLessThan(d1.distance);
    expect(d2.confidence).toBeGreaterThan(d1.confidence);
    expect(d2.relation).toBe('UPSTREAM');
  });

  it('downstream(d1) 含 d2,d3（被哪些决策继承/推翻）', async () => {
    const down = await traceDownstream('d1', { maxDepth: 3 });
    const ids = down.map((n) => n.decision_id);
    expect(ids).toContain('d2');
    expect(ids).toContain('d3');
  });
});

describe('C1 影响地图', () => {
  it('impactMap(d1) 含根/节点/边/深度', async () => {
    await addDecision({ decision_id: 'd1', scenario_id: 'LEAD_FOLLOW_UP', disposition: 'APPROVE', business_tier: 'NORMAL', state: 'AUTONOMOUS', rationale: 'r' });
    await addDecision({ decision_id: 'd2', scenario_id: 'OPP_QUALIFY', disposition: 'APPROVE', business_tier: 'NORMAL', state: 'AUTONOMOUS', rationale: 'r' });
    await addDecision({ decision_id: 'd3', scenario_id: 'QUOTE_PRICING', disposition: 'APPROVE', business_tier: 'NORMAL', state: 'AUTONOMOUS', rationale: 'r' });
    await addEdge('OVERRIDES', 'd3', 'd2', {});
    await addEdge('OVERRIDES', 'd2', 'd1', {});
    const imp = await impactMap('d1', { maxDepth: 3 });
    expect(imp.root).toBe('d1');
    expect(imp.nodes.map((n) => n.decision_id)).toEqual(expect.arrayContaining(['d2', 'd3']));
    expect(Array.isArray(imp.edges)).toBe(true);
    expect(imp.depth).toBeGreaterThanOrEqual(2);
  });
});

describe('C1 降级递归 CTE（decision_precedent_rel 多跳，AGE 兜底路径）', () => {
  it('ctePrecedents 用真实先例关系递归（上下游双向）', async () => {
    const d1 = await createDecision({ scenario_id: 'LEAD_FOLLOW_UP', trigger_context: {}, conditions_evaluated: [], disposition: 'APPROVE', decider_type: 'AUTONOMOUS_AGENT', rationale: 'r', business_tier: 'NORMAL', state: 'AUTONOMOUS' });
    const d2 = await createDecision({ scenario_id: 'OPP_QUALIFY', trigger_context: {}, conditions_evaluated: [], disposition: 'APPROVE', decider_type: 'AUTONOMOUS_AGENT', rationale: 'r', business_tier: 'NORMAL', state: 'AUTONOMOUS', referenced_precedents: [d1.decision_id] });
    const d3 = await createDecision({ scenario_id: 'QUOTE_PRICING', trigger_context: {}, conditions_evaluated: [], disposition: 'APPROVE', decider_type: 'AUTONOMOUS_AGENT', rationale: 'r', business_tier: 'NORMAL', state: 'AUTONOMOUS', referenced_precedents: [d2.decision_id] });
    const ups = await ctePrecedents(d3.decision_id, { maxDepth: 3, direction: 'upstream' });
    const ids = ups.map((n) => n.decision_id);
    expect(ids).toContain(d2.decision_id);
    expect(ids).toContain(d1.decision_id);
    const down = await ctePrecedents(d1.decision_id, { maxDepth: 3, direction: 'downstream' });
    const dids = down.map((n) => n.decision_id);
    expect(dids).toContain(d2.decision_id);
    expect(dids).toContain(d3.decision_id);
  });
});
