// test/calibration/disposition.test.js — 人工处置回写（校准 P0：被调量采集点）
// 设计依据：docs/2026-08-28-decision-quality-calibration-design.md §3
// 铁律（代码级核实）：confirmDecision/reverseDecision（decisionRepo.js:195/:214）全仓 0 调用方，
//   导致 state='CONFIRMED'/'REVERSED' 恒不产生、reversal_rate 恒为 0。本模块是被调量的唯一采集点。
import { describe, it, expect, beforeEach } from 'vitest';
import { query } from '../../src/db.js';
import { createDecision } from '../../src/decision/decisionRepo.js';
import { recordHumanDisposition, DISPOSABLE_STATES } from '../../src/decision/disposition.js';

beforeEach(async () => {
  await query('TRUNCATE crm.decision, crm.decision_precedent_rel, crm.decision_event RESTART IDENTITY CASCADE');
});

async function seed() {
  return createDecision({
    scenario_id: 'LEAD_FOLLOW_UP',
    trigger_context: { name: '校准测试商机' },
    involved_entities: [],
    conditions_evaluated: [],
    disposition: 'APPROVE',
    decider_type: 'AUTONOMOUS_AGENT',
    rationale: '测试用决策',
    business_tier: 'LEAD',
    state: 'AUTONOMOUS',
  });
}

describe('recordHumanDisposition', () => {
  it('人工处置与建议一致 → CONFIRMED 且 human_disposition 落库', async () => {
    const d = await seed();
    const r = await recordHumanDisposition(d.decision_id, {
      disposition: 'APPROVE', by_id: 'alice', by_role: 'sales',
    });
    expect(r.ok).toBe(true);
    expect(r.overridden).toBe(false);
    expect(r.next_state).toBe('CONFIRMED');
    const row = (await query('SELECT * FROM crm.decision WHERE decision_id=$1', [d.decision_id])).rows[0];
    expect(row.human_disposition).toBe('APPROVE');
    expect(row.human_decider_id).toBe('alice');
    expect(row.human_decided_at).toBeTruthy();
    expect(row.state).toBe('CONFIRMED');
    expect(row.outcome).not.toBe('REVERSED');
    // 决策来源溯源凭据不得被覆写：P1 的 autonomy_override_rate 靠它筛自主样本
    expect(row.decider_type).toBe('AUTONOMOUS_AGENT');
    expect(row.decider_id).toBe(d.decider_id);
  });

  it('人工改判（与建议不等）→ REVERSED + outcome=REVERSED + 审计落链', async () => {
    const d = await seed();
    const r = await recordHumanDisposition(d.decision_id, {
      disposition: 'REJECT', by_id: 'bob', by_role: 'manager', note: '预算不符',
    });
    expect(r.ok).toBe(true);
    expect(r.overridden).toBe(true);
    expect(r.next_state).toBe('REVERSED');
    const row = (await query('SELECT outcome FROM crm.decision WHERE decision_id=$1', [d.decision_id])).rows[0];
    expect(row.outcome).toBe('REVERSED');
    const audit = (await query(
      `SELECT * FROM crm.audit_event WHERE decision_id=$1 AND action='human-disposition'`, [d.decision_id])).rows[0];
    expect(audit).toBeTruthy();
    expect(audit.payload.from_disposition).toBe('APPROVE');
    expect(audit.payload.to_disposition).toBe('REJECT');
    expect(audit.payload.overridden).toBe(true);
    expect(audit.payload.note).toBe('预算不符');
  });

  it('未知 decision_id → 404；已终结状态 → 409', async () => {
    const notFound = await recordHumanDisposition('00000000-0000-0000-0000-000000000000', { disposition: 'APPROVE' });
    expect(notFound.ok).toBe(false);
    expect(notFound.status).toBe(404);

    const d = await seed();
    await recordHumanDisposition(d.decision_id, { disposition: 'REJECT' });
    const again = await recordHumanDisposition(d.decision_id, { disposition: 'APPROVE' });
    expect(again.ok).toBe(false);
    expect(again.status).toBe(409);
  });

  it('缺 disposition → 抛错；DISPOSABLE_STATES 不含已终结态', () => {
    expect(DISPOSABLE_STATES.has('AUTONOMOUS')).toBe(true);
    expect(DISPOSABLE_STATES.has('HUMAN')).toBe(true);
    expect(DISPOSABLE_STATES.has('CONFIRMED')).toBe(false);
    expect(DISPOSABLE_STATES.has('REVERSED')).toBe(false);
  });
});