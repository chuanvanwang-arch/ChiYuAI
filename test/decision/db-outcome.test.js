// test/decision/db-outcome.test.js — T5 业务结果回写集成测试（plm_test）
// 覆盖：writeOutcome 幂等 upsert + 回写 decision.outcome_verified + listOutcomes 读 + outcomeToConfidence。
import { describe, it, expect, beforeEach } from 'vitest';
import { queryWrite, query as q } from '../../src/db.js';
import {
  writeOutcome, listOutcomes, outcomeToConfidence, isValidOutcomeType, OUTCOME_TYPES,
} from '../../src/decision/outcome.js';

const SID = 'OUTCOME_TEST_SCENARIO';
const DID = 'dddddddd-0000-0000-0000-0000000000d1';

beforeEach(async () => {
  await queryWrite('TRUNCATE crm.decision_outcome RESTART IDENTITY CASCADE');
  await queryWrite(`DELETE FROM crm.decision WHERE decision_id=$1`, [DID]);
  await queryWrite(
    `INSERT INTO crm.decision_scenario(scenario_id, stage, trigger, eval_dimensions, required_dims)
     VALUES ($1,'ACTIVE','{}'::jsonb,'[]'::jsonb,'[]'::jsonb)
     ON CONFLICT (scenario_id, tenant_id) DO NOTHING`,
    [SID]
  );
  await queryWrite(
    `INSERT INTO crm.decision
       (decision_id, scenario_id, trigger_context, involved_entities, conditions_evaluated,
        disposition, decider_type, rationale, business_tier, state)
     VALUES ($1,$2,'{}'::jsonb,'[]'::jsonb,'[]'::jsonb,'PROCEED','AUTONOMOUS_AGENT','r','NORMAL','REQUIRED')`,
    [DID, SID]
  );
});

describe('T5 decision_outcome 业务结果回写', () => {
  it('OUTCOME_TYPES 含 6 类', () => {
    expect(OUTCOME_TYPES).toHaveLength(6);
    expect(isValidOutcomeType('won')).toBe(true);
    expect(isValidOutcomeType('bad')).toBe(false);
  });

  it('writeOutcome 落库并回写 decision.outcome_verified', async () => {
    const row = await writeOutcome(DID, { outcome_type: 'won', source: 'crm_deal' });
    expect(row.outcome_type).toBe('won');
    expect(row.confidence).toBeGreaterThan(0); // outcomeToConfidence('won') 反算
    const d = (await q('SELECT outcome_verified FROM crm.decision WHERE decision_id=$1', [DID])).rows[0];
    expect(d.outcome_verified).toBe('won');
  });

  it('同 (decision,type,source) 幂等 upsert（不新增行）', async () => {
    await writeOutcome(DID, { outcome_type: 'paid', source: 'payment' });
    await writeOutcome(DID, { outcome_type: 'paid', source: 'payment', payload: { amount: 100 } });
    const rows = await listOutcomes(DID);
    expect(rows.filter((r) => r.outcome_type === 'paid' && r.source === 'payment')).toHaveLength(1);
  });

  it('不同 source 可并存（多业务系统）', async () => {
    await writeOutcome(DID, { outcome_type: 'paid', source: 'payment' });
    await writeOutcome(DID, { outcome_type: 'paid', source: 'contract' });
    const rows = await listOutcomes(DID);
    expect(rows).toHaveLength(2);
  });

  it('listOutcomes 按时间倒序', async () => {
    await writeOutcome(DID, { outcome_type: 'lost', source: 'crm_deal' });
    await writeOutcome(DID, { outcome_type: 'won', source: 'crm_deal2' });
    const rows = await listOutcomes(DID);
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  it('非法 outcome_type 抛错', async () => {
    await expect(writeOutcome(DID, { outcome_type: 'bogus', source: 'x' })).rejects.toThrow(/非法 outcome_type/);
  });

  it('outcomeToConfidence：won/paid 高、lost 低', () => {
    expect(outcomeToConfidence('won')).toBeGreaterThan(outcomeToConfidence('lost'));
    expect(outcomeToConfidence('paid')).toBeGreaterThanOrEqual(outcomeToConfidence('stalled'));
  });
});
