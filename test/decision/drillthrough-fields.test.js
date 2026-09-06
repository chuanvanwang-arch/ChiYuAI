// test/decision/drillthrough-fields.test.js — T-D1 字段全落库（TDD 红→绿）
// 验证：createDecision 物化 confidence（computeConfidence 反算）+ root_cause/feedback/feedback_link 落库。
// 用专属场景 DRILLTHRU_TEST（required_dims=[]）隔离"维度守卫"关注点，专测字段落库/反算。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDecision } from '../../src/decision/decisionRepo.js';
import { query } from '../../src/db.js';

// 专属场景隔离「维度守卫」关注点，专测字段落库/反算。
// 注意：plm_test 已累积 8 个测试残留场景（FEEDBACK_TEST_SCEN/GRAPH_EDGES_SCENARIO/OUTCOME_TEST_SCENARIO/
// REL_TEST_SCENARIO/TEST_J2_L2_OUTCOME/TRACE_DBG_SCEN/TRACE_TEST_SCENARIO_V1 等），致 decision.test.js
// 断言「场景数=11」失败（实为 19）——既有测试隔离债，本文件必须自清理，不再加剧污染。
const SCEN = 'DRILLTHRU_TEST';

beforeEach(async () => {
  await query('TRUNCATE crm.decision, crm.decision_provenance, crm.decision_relation, crm.decision_outcome RESTART IDENTITY CASCADE');
  await query(
    `INSERT INTO crm.decision_scenario (scenario_id, stage, description, trigger, methodology_ids, eval_dimensions, default_tier, autonomous_allowed, required_dims)
     VALUES ($1,'sales','穿透追溯测试','{}'::jsonb, ARRAY[]::TEXT[], '[]'::jsonb, 'NORMAL', TRUE, '[]'::jsonb)
     ON CONFLICT (scenario_id, tenant_id) DO UPDATE SET required_dims='[]'::jsonb, eval_dimensions='[]'::jsonb`,
    [SCEN]
  );
});

afterEach(async () => {
  // 顺序要紧：decision 经 decision_scenario_id_fkey 引用场景 → 先清决策（CASCADE 带走依赖），再删场景
  await query('TRUNCATE crm.decision, crm.decision_provenance, crm.decision_relation, crm.decision_outcome RESTART IDENTITY CASCADE');
  await query(`DELETE FROM crm.decision_scenario WHERE scenario_id=$1`, [SCEN]);
});

describe('T-D1 决策字段全落库', () => {
  it('createDecision 物化 confidence（反算）与 root_cause/feedback/feedback_link', async () => {
    // feedback_link 为 UUID 软引用（schema.sql:168）：指向承载该反馈的关联决策
    const precursor = await createDecision({
      scenario_id: SCEN, disposition: 'APPROVED',
      trigger_context: { dim: 'B' }, involved_entities: [], conditions_evaluated: [{ name: 'x', met: true }], rationale: '前序',
    });
    const d = await createDecision({
      scenario_id: SCEN, disposition: 'APPROVED',
      trigger_context: { dim: 'B' }, involved_entities: [], conditions_evaluated: [{ name: 'x', met: true }],
      rationale: 'r', outcome_verified: 'won',
      feedback: { note: '客户确认', source: 'manual' }, feedback_link: precursor.decision_id,
      root_cause: { type: 'PRICE' },
    });
    expect(typeof d.confidence).toBe('number');
    expect(d.confidence).toBeCloseTo(0.9);                 // computeConfidence: won→0.9
    expect(d.confidence_source).toBe('computed');
    expect(d.root_cause).toMatchObject({ type: 'PRICE' });
    expect(d.feedback).toMatchObject({ note: '客户确认' });  // feedback 为 JSONB（schema.sql:537）
    expect(d.feedback_link).toBe(precursor.decision_id);
  });

  it('置信度缺业务信号时回退 0.6（不脑补）', async () => {
    const d = await createDecision({
      scenario_id: SCEN, disposition: 'APPROVED',
      trigger_context: { dim: 'B' }, involved_entities: [], conditions_evaluated: [{ name: 'x', met: true }], rationale: 'r',
    });
    expect(d.confidence).toBeCloseTo(0.6);
  });

  it('守卫默认 warn：上下文空缺不阻断主写（兼容既有调用方）', async () => {
    const d = await createDecision({
      scenario_id: SCEN, disposition: 'APPROVED',
      trigger_context: {}, involved_entities: [], conditions_evaluated: [], rationale: 'r',
    });
    expect(d.decision_id).toBeTruthy();
  });
});
