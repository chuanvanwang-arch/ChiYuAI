// test/decision/decisionFixture.js
// 测试夹具：在 crm.decision 插一行真实决策（满足 particles.decision_id 外键 + 第0闸 provenance），
// 返回合法 UUID，供证据写操作复用。测试结束后务必 drop。
import { query } from '../../src/db.js';
import { randomUUID } from 'node:crypto';

const SCENARIO = 'PROP_TEST_SCENARIO';

export async function createDecisionFixture() {
  const id = randomUUID();
  await query(
    `INSERT INTO crm.decision
       (decision_id, scenario_id, trigger_context, conditions_evaluated, involved_entities, disposition, decider_type, rationale, business_tier)
     VALUES ($1, $2, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, 'TEST', 'agent', 'test-fixture', 'standard')
     ON CONFLICT (decision_id) DO NOTHING`,
    [id, SCENARIO]
  );
  return id;
}

export async function dropDecisionFixture(id) {
  if (id) await query('DELETE FROM crm.decision WHERE decision_id=$1::uuid', [id]).catch(() => {});
}
