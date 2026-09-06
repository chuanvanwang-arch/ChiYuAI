import { describe, it, expect, beforeEach } from 'vitest';
import { query, queryWrite } from '../../src/db.js';
import { handleBusinessEvent } from '../../src/decision/outcomeIngester.js';
import { getGateOutcome } from '../../src/monitor/monitorStore.js';

// isolation-audit:ignore crm.decision —— 本文件的 decision 全由 mkDecision 裸 INSERT
//   （固定 UUID，不经 createDecision，故不产生 decision_event 等 FK 子行）；唯一会写的子表
//   decision_outcome 已在下方 TRUNCATE，且顺序在 DELETE 主表之前。scenario 为私有
//   TEST_J2_L2_OUTCOME，不会被上游业务代码触碰。
// 使用唯一 scenario，避免与并行运行、或历史遗留的 LEAD_FOLLOW_UP 决策行互相污染（隔离铁律）。
const SCN = 'TEST_J2_L2_OUTCOME';
const D1 = 'd1111111-1111-1111-1111-1111111111d1';
const D2 = 'd2222222-2222-2222-2222-2222222222d2';
const D3 = 'd3333333-3333-3333-3333-3333333333d3';

async function mkDecision(id, { human_disposition = null, outcome_verified = null, state = 'AUTONOMOUS' } = {}) {
  await queryWrite(
    `INSERT INTO crm.decision
      (decision_id, scenario_id, trigger_context, involved_entities, conditions_evaluated, disposition, decider_type, rationale, business_tier, state, human_disposition, outcome_verified)
     VALUES ($1,'${SCN}','{}'::jsonb,'[]'::jsonb,'[]'::jsonb,'PROCEED','AUTONOMOUS_AGENT','r','NORMAL',$2,$3,$4)
     ON CONFLICT (decision_id) DO UPDATE SET human_disposition=EXCLUDED.human_disposition, outcome_verified=EXCLUDED.outcome_verified, state=EXCLUDED.state`,
    [id, state, human_disposition, outcome_verified]
  );
}

describe('T16 outcomeIngester + getGateOutcome', () => {
  beforeEach(async () => {
    await queryWrite('TRUNCATE crm.decision_outcome RESTART IDENTITY CASCADE');
    await queryWrite('TRUNCATE crm.outcome_event_map RESTART IDENTITY CASCADE');
    await queryWrite('DELETE FROM crm.decision WHERE scenario_id=$1', [SCN]);
    await queryWrite('DELETE FROM crm.decision_scenario WHERE scenario_id=$1', [SCN]);
    // 自给自足的隔离 scenario（FK 指向 crm.decision_scenario），避免与并行/历史 LEAD_FOLLOW_UP 行互相污染
    await queryWrite(
      `INSERT INTO crm.decision_scenario (scenario_id, stage, trigger, eval_dimensions)
       VALUES ($1,'TEST_STAGE','{}'::jsonb,'[]'::jsonb) ON CONFLICT (scenario_id, tenant_id) DO NOTHING`, [SCN]);
  });

  it('业务事件命中 outcome_event_map → 写 decision_outcome + 回写 outcome_verified', async () => {
    await mkDecision(D1);
    await queryWrite(
      `INSERT INTO crm.outcome_event_map (event_type, outcome_type, scenario_id, matcher, enabled)
       VALUES ('crm.opportunity.won','won',$1,'{"decision_id_field":"decision_id"}'::jsonb,true)`, [SCN]);
    const res = await handleBusinessEvent('crm', 'opportunity.won', { decision_id: D1, amount: 1000 });
    expect(res.length).toBe(1);
    const d = (await query('SELECT outcome_verified FROM crm.decision WHERE decision_id=$1', [D1])).rows[0];
    expect(d.outcome_verified).toBe('won');
    const oc = (await query('SELECT source, outcome_type FROM crm.decision_outcome WHERE decision_id=$1', [D1])).rows;
    expect(oc.length).toBe(1);
    expect(oc[0].source).toBe('event:crm.opportunity.won');
  });

  it('无匹配规则 → 不产生 outcome（事件分发不被阻断）', async () => {
    await mkDecision(D1);
    const res = await handleBusinessEvent('crm', 'lead-picked', { decision_id: D1 });
    expect(res.length).toBe(0);
    const oc = (await query('SELECT 1 FROM crm.decision_outcome WHERE decision_id=$1', [D1])).rows;
    expect(oc.length).toBe(0);
  });

  it('getGateOutcome 聚合双率 + 隐性错误簇', async () => {
    await mkDecision(D1, { human_disposition: 'CONFIRMED', outcome_verified: 'won' });
    await mkDecision(D2, { human_disposition: 'CONFIRMED', outcome_verified: 'lost' }); // 隐性错误簇：采纳但业务失败
    await mkDecision(D3, { human_disposition: 'OVERRIDDEN', outcome_verified: 'lost' }); // 被推翻，非隐性
    const g = await getGateOutcome(SCN);
    expect(g.total).toBe(3);
    expect(g.decision_pass_rate).toBe(66.7);
    expect(g.business_success_rate).toBe(33.3);
    expect(g.hidden_error_cluster.length).toBe(1);
    expect(g.hidden_error_cluster[0].decision_id).toBe(D2);
  });

  it('getGateOutcome 支持 window_days 时间窗', async () => {
    await mkDecision(D1, { human_disposition: 'CONFIRMED', outcome_verified: 'won' });
    const g = await getGateOutcome(SCN, { window_days: 30 });
    expect(g.total).toBe(1);
    expect(g.business_success_rate).toBe(100);
  });
});
