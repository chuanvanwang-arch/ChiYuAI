// test/decision/bg03-writable-entity-edge.test.js — BG-03 方案 B：DECIDED_ON/DERIVED_FROM_EXCEPTION 落权威表
// 验收：to_id 外键放宽后，决策↔实体/异常边可经 linkDecisions 写入 crm.decision_relation 并被 listTypedEdges 查到（运行时口径）。
import { describe, it, expect, beforeEach } from 'vitest';
import { query } from '../../src/db.js';
import { createDecision } from '../../src/decision/decisionRepo.js';
import { listTypedEdges } from '../../src/decision/relation.js';

const ENT = { type: 'CRM_DEAL', id: 'eeee0000-0000-0000-0000-0000000000e1', name: '演示商机E' };
const EX = { id: 'eeee0000-0000-0000-0000-0000000000e2', name: '演示异常E' };

beforeEach(async () => {
  await query('TRUNCATE crm.decision, crm.decision_relation, crm.decision_precedent_rel, crm.decision_event RESTART IDENTITY CASCADE');
});

describe('BG-03 方案 B — 决策↔实体边可写权威表', () => {
  it('createDecision(involved_entities) → DECIDED_ON 落 decision_relation（to_id=实体 UUID）', async () => {
    const d = await createDecision({
      scenario_id: 'LEAD_FOLLOW_UP', trigger_context: {}, conditions_evaluated: [],
      disposition: 'APPROVE', decider_type: 'AUTONOMOUS_AGENT', rationale: 'r',
      business_tier: 'NORMAL', state: 'AUTONOMOUS', involved_entities: [ENT],
    });
    const out = await listTypedEdges(d.decision_id, { direction: 'out', runtimeOnly: true });
    const decided = out.filter((e) => e.rel_type === 'DECIDED_ON');
    expect(decided).toHaveLength(1);
    expect(decided[0].to_id).toBe(ENT.id);
    expect(decided[0].serves_dimension).toBe('identity');
  });

  it('createDecision(triggered_by_exception) → DERIVED_FROM_EXCEPTION 落 decision_relation（to_id=异常 id）', async () => {
    const d = await createDecision({
      scenario_id: 'LEAD_FOLLOW_UP', trigger_context: {}, conditions_evaluated: [],
      disposition: 'APPROVE', decider_type: 'AUTONOMOUS_AGENT', rationale: 'r',
      business_tier: 'NORMAL', state: 'AUTONOMOUS', triggered_by_exception: EX,
    });
    const out = await listTypedEdges(d.decision_id, { direction: 'out', runtimeOnly: true });
    const derived = out.filter((e) => e.rel_type === 'DERIVED_FROM_EXCEPTION');
    expect(derived).toHaveLength(1);
    expect(derived[0].to_id).toBe(EX.id);
    expect(derived[0].serves_dimension).toBe('operational_state');
  });

  it('identity/structure/operational_state 维度依赖边现全部可写 → 装弹自检通过（T4+T5 闭合）', async () => {
    const { checkRequiredDimsWritable } = await import('../../src/decision/writableEdges.js');
    const chk = checkRequiredDimsWritable([
      { dim: 'identity', on_missing: 'block' },
      { dim: 'structure', on_missing: 'block' },
      { dim: 'operational_state', on_missing: 'block' },
    ]);
    expect(chk.ok).toBe(true);
    expect(chk.unwritable).toEqual([]);
  });
});
