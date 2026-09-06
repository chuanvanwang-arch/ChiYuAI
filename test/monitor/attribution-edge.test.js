// test/monitor/attribution-edge.test.js — T-D4 attribution 七态 + E1-E7 edge_compliance
// 验证：computeAttribution 返回 category ∈ CATEGORY_STATES；edge_compliance 全列（缺省全 missing，
//   传 decisionId 后查 decision_relation 实存边 → 对应 E present）。纯函数 computeEdgeCompliance 单测。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { computeAttribution, CATEGORY_STATES, computeEdgeCompliance } from '../../src/monitor/attribution.js';
import { createDecision } from '../../src/decision/decisionRepo.js';
import { query } from '../../src/db.js';
import { seedScenario, cleanupScenario, baseDecision } from '../decision/_helpers.js';

const SCEN = 'ATTR_SEVEN_SCEN';
beforeEach(async () => { await seedScenario(SCEN); });
afterEach(async () => { await cleanupScenario(SCEN); });

describe('T-D4 computeAttribution 七态 + edge_compliance', () => {
  it('默认返回 category ∈ CATEGORY_STATES + E1-E7 edge_compliance 全列（缺省全 missing）', async () => {
    const a = await computeAttribution({ scenario_id: SCEN, trigger_context: { dimA: 1 }, query });
    expect(CATEGORY_STATES).toContain(a.category);
    const keys = Object.keys(a.edge_compliance);
    // T29-b：7 类投影 + required_edges/required_missing/known 三元组键
    expect(keys).toHaveLength(10);
    expect(keys).toContain('DECIDED_ON');
    expect(keys).toContain('REFERENCED_PRECEDENT');
    expect(keys).toContain('OVERRIDES');
    expect(keys).toContain('required_edges');
    expect(keys).toContain('required_missing');
    expect(keys).toContain('known');
    // 未传 decisionId → 全部 missing；场景无必填维 → 显式空应连集 = 已知无 E 缺
    expect(a.edge_compliance.REFERENCED_PRECEDENT).toBe('missing');
    expect(a.edge_compliance.required_missing).toEqual([]);
    expect(a.edge_compliance.known).toBe(true);
  });

  it('传 decisionId 后查 decision_relation 实存边 → 对应 E present', async () => {
    const parent = await createDecision(baseDecision(SCEN, { rationale: '先例' }));
    const child = await createDecision(baseDecision(SCEN, { referenced_precedents: [parent.decision_id] }));
    const a = await computeAttribution({ scenario_id: SCEN, trigger_context: { dim: 'B' }, query, decisionId: child.decision_id });
    expect(a.edge_compliance.REFERENCED_PRECEDENT).toBe('present');
  });
});

describe('T-D4 computeEdgeCompliance 纯函数', () => {
  it('空 → 全 missing；含边 → 对应 present、其余 missing；无应连依据 → known=false', () => {
    expect(computeEdgeCompliance([])['DECIDED_ON']).toBe('missing');
    const r = computeEdgeCompliance(['DECIDED_ON']);
    expect(r['DECIDED_ON']).toBe('present');
    expect(r['OVERRIDES']).toBe('missing');
    expect(Object.keys(r)).toHaveLength(10);
    expect(r.known).toBe(false);
    expect(r.required_missing).toEqual([]);
  });

  it('传 requiredDims → 推导应连边（7×7 交叉校验）→ known=true', () => {
    const r = computeEdgeCompliance(['DECIDED_ON'], { requiredDims: ['identity', 'structure'] });
    expect(r.required_edges).toEqual(['DECIDED_ON']); // identity/structure 仅由 DECIDED_ON 服务
    expect(r.required_missing).toEqual([]);
    expect(r.known).toBe(true);
    // 实存空 → 应连未连非空 → E 缺可判
    const r0 = computeEdgeCompliance([], { requiredDims: ['identity', 'structure'] });
    expect(r0.required_missing).toEqual(['DECIDED_ON']);
    expect(r0.known).toBe(true);
  });
});
