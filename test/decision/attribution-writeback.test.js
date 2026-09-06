// test/decision/attribution-writeback.test.js
import { createDecision, writebackHumanDisposition, writebackOutcome } from '../../src/decision/decisionRepo.js';
import { query } from '../../src/db.js';
import { describe, it, expect, afterEach } from 'vitest';

const sid = 'ATTR_WB_SCENARIO';
// 本测试自建场景，afterEach 清理（避免污染种子数量断言）
// createDecision 会写 decision_event/memory_log/precedent_rel/provenance（FK 引用 decision），
// 用 TRUNCATE 多表 CASCADE 统一清（对齐 decision.test.js 纪律），再删自建 scenario，防 FK 冲突
afterEach(async () => {
  await query(
    `TRUNCATE crm.decision_event, crm.decision_precedent_rel, crm.decision_provenance,
              crm.memory_log, crm.decision RESTART IDENTITY CASCADE`
  );
  await query(`DELETE FROM crm.decision_scenario WHERE scenario_id=$1`, [sid]);
});
// 2026-08-30 实现演进适配：applyHumanDisposition 已升级为 classifyRootCause 七态推导
//   （src/monitor/attribution.js:105-147）——required_dims 非空会制造「应连边依据」，
//   全齐决策无实存边 → 判 EDGE_MISSING（正确新行为）。
//   本用例意图「输入齐备 + 无其他可指 → 人工推翻 = 推理偏差」，故场景置空 required_dims
//   （无应连边依据 → hasRealEdgeMissing=false → L+E 全齐 → DATA_QUALITY_PRECEDENT → inference_bias）。
async function seedScenario() {
  await query(
    `INSERT INTO crm.decision_scenario(scenario_id, stage, trigger, eval_dimensions, required_dims)
     VALUES ($1, 'ACTIVE', '{}'::jsonb, '[]'::jsonb, $2::jsonb)
     ON CONFLICT (scenario_id, tenant_id) DO UPDATE SET required_dims=$2::jsonb`,
    [sid, JSON.stringify([])]
  );
}

describe('attribution writeback', () => {
  it('OVERRIDDEN + required filled -> inference_bias', async () => {
    await seedScenario();
    const d = await createDecision({ scenario_id: sid, trigger_context: { identity: 'acme' }, involved_entities: [],
      conditions_evaluated: [], disposition: 'PROCEED', rationale: 'r', business_tier: 'NORMAL', state: 'REQUIRED' });
    await writebackHumanDisposition(d.decision_id, 'OVERRIDDEN');
    const r = await query(`SELECT attribution FROM crm.decision WHERE decision_id=$1`, [d.decision_id]);
    expect(r.rows[0].attribution.category).toBe('inference_bias');
    expect(r.rows[0].attribution.accuracy_signal).toBe('inaccurate');
  });
  it('outcome won -> outcome_verified', async () => {
    await seedScenario();
    const d = await createDecision({ scenario_id: sid, trigger_context: { identity: 'acme' }, involved_entities: [],
      conditions_evaluated: [], disposition: 'PROCEED', rationale: 'r', business_tier: 'NORMAL', state: 'REQUIRED' });
    await writebackOutcome(d.decision_id, 'won');
    const r = await query(`SELECT attribution FROM crm.decision WHERE decision_id=$1`, [d.decision_id]);
    expect(r.rows[0].attribution.outcome_verified).toBe('won');
  });
});
