// test/decision/decision-relation.test.js — T-D2 decision_relation 权威边表（TDD 红→绿）
// 关键约束（schema.sql:490-501）：from_id/to_id 均 REFERENCES crm.decision(decision_id)
//   → 该表只承载「决策↔决策」边；「决策→粒子」联动由 decision.involved_entities(JSONB) + AGE 边承载。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDecision } from '../../src/decision/decisionRepo.js';
import { query } from '../../src/db.js';
import { seedScenario, cleanupScenario, baseDecision } from './_helpers.js';

const SCEN = 'DRILLTHRU_TEST';

beforeEach(async () => { await seedScenario(SCEN); });
afterEach(async () => { await cleanupScenario(SCEN); });

describe('T-D2 decision_relation 权威边表', () => {
  it('引用先例 → 落 REFERENCED_PRECEDENT 边（serves_dimension=decision_history）', async () => {
    const parent = await createDecision(baseDecision(SCEN, { rationale: '先例' }));
    const child = await createDecision(baseDecision(SCEN, {
      rationale: '子决策', referenced_precedents: [parent.decision_id],
    }));

    const r = await query('SELECT rel_type, serves_dimension, props FROM crm.decision_relation WHERE from_id=$1', [child.decision_id]);
    expect(r.rows.length).toBeGreaterThan(0);
    const prec = r.rows.find((x) => x.rel_type === 'REFERENCED_PRECEDENT');
    expect(prec).toBeTruthy();
    expect(prec.serves_dimension).toBe('decision_history');
  });

  it('边的两端均为决策 ID（外键约束 → 不承载决策→粒子边）', async () => {
    const parent = await createDecision(baseDecision(SCEN));
    await createDecision(baseDecision(SCEN, { referenced_precedents: [parent.decision_id] }));
    const r = await query('SELECT from_id, to_id FROM crm.decision_relation');
    for (const row of r.rows) {
      const inDecision = await query('SELECT 1 FROM crm.decision WHERE decision_id IN ($1,$2)', [row.from_id, row.to_id]);
      expect(inDecision.rows.length).toBe(2); // 两端都必须是已存在的决策
    }
  });

  it('重复写同一边幂等（UNIQUE(from_id,to_id,rel_type) 不报错）', async () => {
    const parent = await createDecision(baseDecision(SCEN));
    const child = await createDecision(baseDecision(SCEN, { referenced_precedents: [parent.decision_id] }));
    const r = await query(
      'SELECT count(*)::int n FROM crm.decision_relation WHERE from_id=$1 AND to_id=$2 AND rel_type=$3',
      [child.decision_id, parent.decision_id, 'REFERENCED_PRECEDENT']
    );
    expect(r.rows[0].n).toBe(1); // 不重复插入
  });
});
