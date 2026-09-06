// test/decision/_helpers.js — 决策测试共享助手（测试隔离，杜绝场景残留污染）
// 背景：plm_test 已累积 7 个残留测试场景（FEEDBACK_TEST_SCEN/GRAPH_EDGES_SCENARIO/OUTCOME_TEST_SCENARIO/
// REL_TEST_SCENARIO/TEST_J2_L2_OUTCOME/TRACE_DBG_SCEN/TRACE_TEST_SCENARIO_V1），
// 致 decision.test.js 断言「场景数=11」失败（实为 18）——既有测试隔离债。
// 纪律：本目录新增测试一律走 seedScenario/cleanupScenario，用完即清，不再加剧污染。
import { query } from '../../src/db.js';

export const DECISION_TABLES =
  'crm.decision, crm.decision_provenance, crm.decision_relation, crm.decision_outcome, crm.decision_precedent_rel';

// 造一个 eval_dimensions/required_dims 均为空的场景（绕过七维拦截，专注被测逻辑）
export async function seedScenario(scenarioId, opts = {}) {
  await query(
    `INSERT INTO crm.decision_scenario
       (scenario_id, stage, description, trigger, methodology_ids, eval_dimensions, default_tier, autonomous_allowed, required_dims)
     VALUES ($1,'sales',$2,'{}'::jsonb, ARRAY[]::TEXT[], '[]'::jsonb, 'NORMAL', TRUE, '[]'::jsonb)
     ON CONFLICT (scenario_id, tenant_id) DO UPDATE SET required_dims='[]'::jsonb, eval_dimensions='[]'::jsonb`,
    [scenarioId, opts.description || '穿透追溯测试场景']
  );
}

// 清决策（CASCADE 带走依赖）后再删场景：decision 经 decision_scenario_id_fkey 引用场景
export async function cleanupScenario(scenarioId) {
  await query(`TRUNCATE ${DECISION_TABLES} RESTART IDENTITY CASCADE`);
  await query(`DELETE FROM crm.decision_scenario WHERE scenario_id=$1`, [scenarioId]);
}

export async function truncateDecisions() {
  await query(`TRUNCATE ${DECISION_TABLES} RESTART IDENTITY CASCADE`);
}

// 最小合法决策入参（trigger_context/conditions_evaluated 非空，满足守卫）
export function baseDecision(scenarioId, extra = {}) {
  return {
    scenario_id: scenarioId,
    disposition: 'APPROVED',
    trigger_context: { dim: 'B' },
    involved_entities: [],
    conditions_evaluated: [{ name: 'x', met: true }],
    rationale: 'r',
    ...extra,
  };
}
