// test/decision/decision-outcome.test.js — T-D3 decision_outcome 落库 + 读取（D4 承载）
// 复用 src/decision/outcome.js 的 writeOutcome/listOutcomes（表已在 seed-test-config 步骤⑪建好）。
// closure 对 D4 的聚合断言在 T-D6 的 decision-closure.test.js 覆盖。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDecision } from '../../src/decision/decisionRepo.js';
import { writeOutcome, listOutcomes } from '../../src/decision/outcome.js';
import { query } from '../../src/db.js';
import { seedScenario, cleanupScenario, baseDecision } from './_helpers.js';

const SCEN = 'DEC_OUTCOME_SCEN';
beforeEach(async () => { await seedScenario(SCEN); });
afterEach(async () => { await cleanupScenario(SCEN); });

describe('T-D3 decision_outcome 落库 + 读取', () => {
  it('writeOutcome 写入 decision_outcome 并回写 decision.outcome_verified', async () => {
    const d = await createDecision(baseDecision(SCEN));
    const row = await writeOutcome(d.decision_id, { outcome_type: 'won', source: 'manual', payload: { amount: 100 } });
    expect(row.outcome_type).toBe('won');
    expect(row.confidence).toBeCloseTo(0.9); // outcomeToConfidence: won→0.9
    const upd = await query('SELECT outcome_verified FROM crm.decision WHERE decision_id=$1', [d.decision_id]);
    expect(upd.rows[0].outcome_verified).toBe('won');
  });

  it('listOutcomes 读取该决策全部业务结果', async () => {
    const d = await createDecision(baseDecision(SCEN));
    await writeOutcome(d.decision_id, { outcome_type: 'won', source: 'manual' });
    await writeOutcome(d.decision_id, { outcome_type: 'paid', source: 'manual' });
    const rows = await listOutcomes(d.decision_id);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.outcome_type).sort()).toEqual(['paid', 'won']);
  });

  it('非法 outcome_type 抛错（单一事实源守卫）', async () => {
    const d = await createDecision(baseDecision(SCEN));
    await expect(writeOutcome(d.decision_id, { outcome_type: 'bogus', source: 'manual' }))
      .rejects.toThrow(/非法 outcome_type/);
  });
});
