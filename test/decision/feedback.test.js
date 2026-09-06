import { describe, it, expect, beforeEach } from 'vitest';
import { query, queryWrite } from '../../src/db.js';
import { deriveAccuracySignal, setDecisionFeedback } from '../../src/decision/feedback.js';

describe('T26 deriveAccuracySignal（纯函数）', () => {
  it('usable=false & major=true → inaccurate', () => {
    expect(deriveAccuracySignal({ usable: false, major_deviation: true })).toBe('inaccurate');
  });
  it('usable=true → accurate', () => {
    expect(deriveAccuracySignal({ usable: true, actual_outcome: 'won' })).toBe('accurate');
  });
  it('信息不足 → pending', () => {
    expect(deriveAccuracySignal({})).toBe('pending');
  });
});

const SCN = 'FEEDBACK_TEST_SCEN';
const D = 'f0000000-0000-0000-0000-0000000000f0';

describe('T26 setDecisionFeedback（DB）', () => {
  beforeEach(async () => {
    await queryWrite('DELETE FROM crm.decision WHERE decision_id=$1', [D]);
    await queryWrite(`INSERT INTO crm.decision_scenario(scenario_id, stage, trigger, eval_dimensions) VALUES ($1,'TRACE','{}'::jsonb,'[]'::jsonb) ON CONFLICT (scenario_id, tenant_id) DO NOTHING`, [SCN]);
    await queryWrite(
      `INSERT INTO crm.decision (decision_id, scenario_id, trigger_context, involved_entities, conditions_evaluated, disposition, decider_type, rationale, business_tier, state)
       VALUES ($1,$2,'{}'::jsonb,'[]'::jsonb,'[]'::jsonb,'PROCEED','AUTONOMOUS_AGENT','r','NORMAL','REQUIRED')`,
      [D, SCN]
    );
  });

  it('回写 decision.feedback 并推导 attribution.accuracy_signal=inaccurate', async () => {
    const r = await setDecisionFeedback(D, { usable: false, major_deviation: true, actual_outcome: 'lost', deviation_note: '客户主数据字段错', reporter_role: 'sales' });
    expect(r.ok).toBe(true);
    expect(r.accuracy_signal).toBe('inaccurate');
    const d = (await query(`SELECT feedback, attribution FROM crm.decision WHERE decision_id=$1`, [D])).rows[0];
    expect(d.feedback.usable).toBe(false);
    expect(d.attribution.accuracy_signal).toBe('inaccurate');
    expect(d.attribution.feedback.major_deviation).toBe(true);
  });

  it('usable=true → accurate，且不回退既有 inaccurate', async () => {
    await setDecisionFeedback(D, { usable: false, major_deviation: true });
    const r = await setDecisionFeedback(D, { usable: true, actual_outcome: 'won' });
    expect(r.accuracy_signal).toBe('accurate');
  });
});
