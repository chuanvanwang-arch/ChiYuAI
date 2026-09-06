// test/kanban/createTask.test.js — createTask decisionId 关联（校准 P0 链路）
// 设计依据：docs/2026-08-28-decision-quality-calibration-design.md §3（决策 → 待办 → 人工处置）
import { describe, it, expect, beforeEach } from 'vitest';
import { query } from '../../src/db.js';
import { createTask, getTask } from '../../src/kanban/kanban.js';
import { createDecision } from '../../src/decision/decisionRepo.js';

beforeEach(async () => {
  await query('TRUNCATE crm.tasks, crm.decision RESTART IDENTITY CASCADE');
});

describe('createTask decisionId', () => {
  it('传入 decisionId → 落库且可按 decision_id 反查', async () => {
    const d = await createDecision({
      scenario_id: 'LEAD_FOLLOW_UP', trigger_context: {}, involved_entities: [],
      conditions_evaluated: [], disposition: 'ESCALATE', decider_type: 'HUMAN',
      rationale: '升级待审批', business_tier: 'LEAD', state: 'HUMAN',
    });
    const t = await createTask({
      step: 'decision-review', title: '决策审批', actionName: 'decision-disposition',
      payload: { type: 'CRM_DEAL' }, decisionId: d.decision_id,
    });
    expect(t.decision_id).toBe(d.decision_id);

    const rows = (await query('SELECT id FROM crm.tasks WHERE decision_id=$1', [d.decision_id])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(t.id);
  });

  it('不传 decisionId → 列为 null（向后兼容既有调用方）', async () => {
    const t = await createTask({ step: 's1', title: 't', actionName: 'a' });
    expect(t.decision_id).toBeNull();
    expect((await getTask(t.id)).decision_id).toBeNull();
  });
});