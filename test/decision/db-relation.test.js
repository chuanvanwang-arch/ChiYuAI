// test/decision/db-relation.test.js — T2 决策边权威持久化集成测试（plm_test）
// 覆盖：linkDecisions 双写 PG（幂等）+ listTypedEdges 方向过滤 + serves_dimension 默认 + enrichTraceWithRelType。
import { describe, it, expect, beforeEach } from 'vitest';
import { queryWrite, query as q } from '../../src/db.js';
import {
  linkDecisions, listTypedEdges, enrichTraceWithRelType,
  isValidRelType, REL_TYPES,
} from '../../src/decision/relation.js';
import { primaryDimension } from '../../src/decision/edgeDimensionSpec.js';

const SID = 'REL_TEST_SCENARIO';
const A = 'aaaaaaaa-0000-0000-0000-0000000000a1';
const B = 'bbbbbbbb-0000-0000-0000-0000000000b2';
const C = 'cccccccc-0000-0000-0000-0000000000c3';

beforeEach(async () => {
  await queryWrite('TRUNCATE crm.decision_relation RESTART IDENTITY CASCADE');
  await queryWrite(
    `INSERT INTO crm.decision_scenario(scenario_id, stage, trigger, eval_dimensions, required_dims)
     VALUES ($1,'ACTIVE','{}'::jsonb,'[]'::jsonb,'[]'::jsonb) ON CONFLICT (scenario_id, tenant_id) DO NOTHING`,
    [SID]
  );
  // decision_relation 有 FK → from_id/to_id 必须是真实 decision 行
  for (const id of [A, B, C]) {
    await queryWrite(
      `INSERT INTO crm.decision
         (decision_id, scenario_id, trigger_context, involved_entities, conditions_evaluated,
          disposition, decider_type, rationale, business_tier, state)
       VALUES ($1,$2,'{}'::jsonb,'[]'::jsonb,'[]'::jsonb,'PROCEED','AUTONOMOUS_AGENT','r','NORMAL','REQUIRED')
       ON CONFLICT(decision_id) DO NOTHING`,
      [id, SID]
    );
  }
});

describe('T2 decision_relation 权威表', () => {
  it('isValidRelType / REL_TYPES 含 7 类边', () => {
    expect(REL_TYPES).toHaveLength(7);
    expect(isValidRelType('DECIDED_ON')).toBe(true);
    expect(isValidRelType('NOPE')).toBe(false);
  });

  it('linkDecisions 写入 PG 并默认 serves_dimension = 主维度', async () => {
    const r = await linkDecisions(A, B, 'DECIDED_ON', { source: 'test' });
    expect(r.servesDimension).toBe(primaryDimension('DECIDED_ON'));
    const rows = await listTypedEdges(A, { direction: 'out' });
    expect(rows).toHaveLength(1);
    expect(rows[0].rel_type).toBe('DECIDED_ON');
    expect(rows[0].to_id).toBe(B);
  });

  it('同 from/to/type 幂等（ON CONFLICT DO NOTHING 不重复）', async () => {
    await linkDecisions(A, B, 'REFERENCED_PRECEDENT', {});
    await linkDecisions(A, B, 'REFERENCED_PRECEDENT', { props: { similarity: 0.9 } });
    const rows = await listTypedEdges(A, { direction: 'out' });
    expect(rows).toHaveLength(1);
  });

  it('方向过滤：out / in / both', async () => {
    await linkDecisions(A, B, 'DECIDED_ON', {});
    await linkDecisions(C, A, 'OVERRIDES', {});
    expect((await listTypedEdges(A, { direction: 'out' })).map((e) => e.rel_type)).toEqual(['DECIDED_ON']);
    expect((await listTypedEdges(A, { direction: 'in' })).map((e) => e.rel_type)).toEqual(['OVERRIDES']);
    expect((await listTypedEdges(A, { direction: 'both' }))).toHaveLength(2);
  });

  it('支持 7 类边全部写入（rel_type CHECK 不报错）', async () => {
    for (const t of REL_TYPES) {
      await expect(linkDecisions(A, B, t, {})).resolves.toMatchObject({ relType: t });
    }
  });

  it('非法 rel_type 抛错', async () => {
    await expect(linkDecisions(A, B, 'BOGUS', {})).rejects.toThrow(/非法 rel_type/);
  });

  it('enrichTraceWithRelType 把边富化为 typedEdges', () => {
    const nodes = [{ decision_id: A }, { decision_id: B }];
    const edges = [
      { from_id: A, to_id: B, rel_type: 'DECIDED_ON', serves_dimension: 'identity', props: {} },
    ];
    const out = enrichTraceWithRelType(nodes, edges);
    expect(out.nodes).toBe(nodes);
    expect(out.typedEdges).toHaveLength(1);
    expect(out.typedEdges[0]).toMatchObject({ from: A, to: B, rel_type: 'DECIDED_ON' });
    expect(out.edgeCount).toBe(1);
  });
});
