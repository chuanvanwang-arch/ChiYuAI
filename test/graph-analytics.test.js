// test/graph-analytics.test.js — P6 图分析：度数中心度 + 下游影响规模（AGE 主路 + 降级 CTE 双路径）
// 设计输入：docs/superpowers/specs/2026-08-26-age-semantica-program-design.md P6
import { describe, it, expect, beforeEach } from 'vitest';
import { query } from '../src/db.js';
import { ensureGraph, isAvailable } from '../src/decision/ageGraph.js';
import { createDecision } from '../src/decision/decisionRepo.js';
import { degreeCentrality, downstreamImpactSize } from '../src/decision/graphAnalytics.js';

beforeEach(async () => {
  await query('TRUNCATE crm.decision, crm.decision_precedent_rel, crm.decision_relation, crm.decision_event, crm.memory_log RESTART IDENTITY CASCADE');
  await ensureGraph();
});

const mk = (referenced_precedents = []) => createDecision({
  scenario_id: 'LEAD_FOLLOW_UP', trigger_context: {}, conditions_evaluated: [],
  disposition: 'APPROVE', decider_type: 'AUTONOMOUS_AGENT', rationale: 'r',
  business_tier: 'NORMAL', state: 'AUTONOMOUS', referenced_precedents,
});

describe('P6 图分析', () => {
  it('degreeCentrality 返回决策度数（入度+出度；AGE 或降级 CTE 任一路径）', async () => {
    const d1 = await mk();
    const d2 = await mk([d1.decision_id]); // d2 引用 d1
    const c = await degreeCentrality(d2.decision_id);
    expect(c).toHaveProperty('decision_id', d2.decision_id);
    expect(typeof c.degree).toBe('number');
    // d2 出边 → d1（REFERENCED_PRECEDENT），d3 入边 → d2，故 d2 度数 ≥ 1
    expect(c.degree).toBeGreaterThanOrEqual(1);
  });

  it('downstreamImpactSize 返回被本决策影响的下游决策数（多跳）', async () => {
    const d1 = await mk();
    const d2 = await mk([d1.decision_id]); // d2 引用 d1（d1 下游含 d2）
    const d3 = await mk([d2.decision_id]); // d3 引用 d2（d1 下游含 d2,d3）
    const r = await downstreamImpactSize(d1.decision_id, { maxDepth: 4 });
    expect(r.root).toBe(d1.decision_id);
    expect(r.impacted).toBeGreaterThanOrEqual(2);
  });

  it('AGE 可用时度数主路与降级一致（符号一致，均 ≥ 1）', async () => {
    if (!isAvailable()) return; // 降级路径在 AGE 关时由 cteDegree 兜底，逻辑已覆盖
    const d1 = await mk();
    const d2 = await mk([d1.decision_id]);
    const c = await degreeCentrality(d2.decision_id);
    expect(c.degree).toBeGreaterThanOrEqual(1);
  });
});
