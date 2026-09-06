// test/decision-causal-edges.test.js — P2 补齐：CAUSED/INFLUENCED/ESTABLISHES_FRAME/DERIVED_FROM_EXCEPTION 四类边写时自动产生
// 设计输入：docs/superpowers/specs/2026-08-26-age-semantica-program-design.md §4.1（七类边补齐）
// 验证：createDecision 传入触发入口 → 经 linkDecisions 双写 PG 权威 decision_relation + AGE 镜像 → 可追溯
import { describe, it, expect, beforeEach } from 'vitest';
import { query } from '../src/db.js';
import { ensureGraph, isAvailable, traceUpstream, traceDownstream, runCypher } from '../src/decision/ageGraph.js';
import { createDecision } from '../src/decision/decisionRepo.js';
import { listTypedEdges } from '../src/decision/relation.js';

beforeEach(async () => {
  await query('TRUNCATE crm.decision, crm.decision_precedent_rel, crm.decision_relation, crm.decision_event, crm.memory_log RESTART IDENTITY CASCADE');
  await ensureGraph();
});

const mk = (over = {}) => createDecision({
  scenario_id: 'LEAD_FOLLOW_UP', trigger_context: {}, conditions_evaluated: [],
  disposition: 'APPROVE', decider_type: 'AUTONOMOUS_AGENT', rationale: 'r',
  business_tier: 'NORMAL', state: 'AUTONOMOUS', ...over,
});

describe('P2 四类因果边写时自动产生', () => {
  it('caused_by / influenced_by → CAUSED/INFLUENCED 边写入 PG 权威 decision_relation', async () => {
    const a = await mk();
    const b = await mk({ caused_by: [a.decision_id], influenced_by: [a.decision_id] });
    const edges = await listTypedEdges(b.decision_id, { direction: 'both' });
    const types = edges.map((e) => e.rel_type);
    expect(types).toContain('CAUSED');
    expect(types).toContain('INFLUENCED');
    const caused = edges.find((e) => e.rel_type === 'CAUSED');
    expect(caused.from_id).toBe(a.decision_id);
    expect(caused.to_id).toBe(b.decision_id);
  });

  it('establishes_frame_for → ESTABLISHES_FRAME 边（本决策→框架目标）', async () => {
    const a = await mk();
    const b = await mk({ establishes_frame_for: [a.decision_id] });
    const edges = await listTypedEdges(b.decision_id, { direction: 'both' });
    const frame = edges.find((e) => e.rel_type === 'ESTABLISHES_FRAME');
    expect(frame).toBeTruthy();
    expect(frame.from_id).toBe(b.decision_id);
    expect(frame.to_id).toBe(a.decision_id);
  });

  it('AGE 可用时 CAUSED/INFLUENCED 可上游回溯、ESTABLISHES_FRAME 可下游回溯', async () => {
    if (!isAvailable()) return; // 降级 CTE 仅覆盖先例链；四类边需 AGE 主路
    const a = await mk();
    const b = await mk({ caused_by: [a.decision_id], influenced_by: [a.decision_id], establishes_frame_for: [a.decision_id] });
    const up = await traceUpstream(b.decision_id, { maxDepth: 2 });
    expect(up.map((n) => n.decision_id)).toContain(a.decision_id);
    const down = await traceDownstream(a.decision_id, { maxDepth: 2 });
    expect(down.map((n) => n.decision_id)).toContain(b.decision_id);
  });

  it('triggered_by_exception → DERIVED_FROM_EXCEPTION 仅 AGE 镜像（决策→异常顶点）', async () => {
    if (!isAvailable()) return;
    const d = await mk({ triggered_by_exception: { id: 'EX-1', name: 'timeout' } });
    const rows = await runCypher(
      `MATCH (n:Decision {decision_id:$id})-[r:DERIVED_FROM_EXCEPTION]->(e:EXCEPTION) RETURN {e:e.entity_id} AS v`,
      { id: String(d.decision_id) });
    expect(rows.length).toBe(1);
    expect(rows[0].e).toBe('EX-1');
  });
});
