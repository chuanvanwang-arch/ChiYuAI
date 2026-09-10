// test/decision/r7-precedent-lock.test.js
import { createDecision, searchPrecedents, confirmDecision } from '../../src/decision/decisionRepo.js';
import { query, queryWrite } from '../../src/db.js';
import { describe, it, expect, afterEach } from 'vitest';

const SID = 'LEAD_FOLLOW_UP'; // 种子场景，含维度，confirmed 可正常入池
const CTX = { customer: 'normal', project: 'pilot', conditions: { B: true } };
const COND = [{ cond: 'B', met: true }];

afterEach(async () => {
  await queryWrite(
    `TRUNCATE crm.decision_event, crm.decision_precedent_rel, crm.decision_provenance,
              crm.memory_log, crm.decision RESTART IDENTITY CASCADE`
  );
});

describe('R7 先例自锁', () => {
  it('T2: HUMAN 决策经 confirmDecision 后进入先例池（确认前不在、确认后在）', async () => {
    const d = await createDecision({
      scenario_id: SID, trigger_context: CTX, conditions_evaluated: COND,
      disposition: 'APPROVE', business_tier: 'LEAD', state: 'HUMAN',
    });
    // 确认前：HUMAN 决策不在先例池
    let precs = await searchPrecedents(SID, {
      trigger_context: CTX, conditions_evaluated: COND, business_tier: 'LEAD', disposition: null,
    }, { k: 5 });
    expect(precs.find((p) => p.decision_id === d.decision_id)).toBeFalsy();

    // HITL 确认 → CONFIRMED
    const c = await confirmDecision(d.decision_id, { by_role: 'manager' });
    expect(c.state).toBe('CONFIRMED');

    // 确认后：进入先例池
    precs = await searchPrecedents(SID, {
      trigger_context: CTX, conditions_evaluated: COND, business_tier: 'LEAD', disposition: null,
    }, { k: 5 });
    const hit = precs.find((p) => p.decision_id === d.decision_id);
    expect(hit).toBeTruthy();
    expect(hit.similarity).toBeGreaterThan(0.45); // C4 结构相似度（与决策.test.js:114 同口径）
  });

  it('T3: HUMAN 态决策永不被先例池召回（仅 CONFIRMED/AUTONOMOUS 入池）', async () => {
    // 同 scenario 放一个已确认先例 + 一个 HUMAN 决策
    await createDecision({
      scenario_id: SID, trigger_context: CTX, conditions_evaluated: COND,
      disposition: 'APPROVE', business_tier: 'LEAD', state: 'CONFIRMED',
    });
    const h = await createDecision({
      scenario_id: SID, trigger_context: CTX, conditions_evaluated: COND,
      disposition: 'ESCALATE', business_tier: 'LEAD', state: 'HUMAN',
    });
    const precs = await searchPrecedents(SID, {
      trigger_context: CTX, conditions_evaluated: COND, business_tier: 'LEAD', disposition: null,
    }, { k: 5 });
    // HUMAN 决策绝不应作为候选先例出现
    expect(precs.find((p) => p.decision_id === h.decision_id)).toBeFalsy();
    // HUMAN 决策也绝不应作为 precedent_id 出现在 decision_precedent_rel
    const rel = (await query(
      'SELECT count(*)::int n FROM crm.decision_precedent_rel WHERE precedent_id=$1',
      [h.decision_id]
    )).rows[0].n;
    expect(rel).toBe(0);
  });
});
