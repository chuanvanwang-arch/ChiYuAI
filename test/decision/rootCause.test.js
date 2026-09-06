// test/decision/rootCause.test.js — 6.1 root_cause/feedback 写回
// 契约：C-DAI 决策问责闭环（归属 decision-retro 智能体；knowledgeScope L1–L3）
// 测试计划 §5.7：rootCauseClassifier 七类归因后写 decision.root_cause JSONB（经 traceRootCause 数据）
// 纪律：分类结果是确定性纯函数；DB 写回不物理删、幂等 UPDATE。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { query, queryWrite } from '../../src/db.js';
import { seedScenario, cleanupScenario } from './_helpers.js';
import { createDecision } from '../../src/decision/decisionRepo.js';
import { classifyRootCause } from '../../src/decision/rootCauseClassifier.js';
import { persistRootCause } from '../../src/decision/rootCauseClassifier.js';
import { setDecisionFeedback } from '../../src/decision/feedback.js';

const SCEN = 'ROOT_CAUSE_SCEN';
const PT = 'ROOT_CAUSE_PARTICLE';

describe('6.1 root_cause/feedback 写回', () => {
  let decisionId;

  beforeEach(async () => {
    await seedScenario(SCEN);
    const r = await createDecision({
      scenario_id: SCEN,
      disposition: 'APPROVED',
      trigger_context: { dim: 'B' },
      involved_entities: [],
      conditions_evaluated: [{ name: 'x', met: true }],
      rationale: 'r',
    });
    decisionId = r.decision_id;
  });

  afterEach(async () => {
    await queryWrite(`DELETE FROM crm.meta_attr WHERE particle_type=$1`, [PT]);
    await cleanupScenario(SCEN);
  });

  it('classifyRootCause 纯函数分类（字段不一致）', () => {
    const c = classifyRootCause({
      feedback: { usable: false, major_deviation: false },
      attribution: {},
      particleChecks: { field_mismatch: true },
    });
    expect(c.code).toBe('FIELD_MISMATCH');
  });

  it('persistRootCause 写回 decision.root_cause JSONB（七类可落）', async () => {
    const classification = classifyRootCause({
      feedback: { usable: false, major_deviation: true },
      attribution: {},
      particleChecks: { field_mismatch: true },
    });
    const r = await persistRootCause(decisionId, classification);
    expect(r.ok).toBe(true);
    const d = (await query(`SELECT root_cause FROM crm.decision WHERE decision_id=$1`, [decisionId])).rows[0];
    expect(d.root_cause).toBeTruthy();
    expect(d.root_cause.code).toBe('FIELD_MISMATCH');
    expect(d.root_cause.severity).toBe('major');
  });

  it('setDecisionFeedback 写回 decision.feedback JSONB', async () => {
    const r = await setDecisionFeedback(decisionId, {
      usable: false,
      major_deviation: true,
      actual_outcome: 'lost',
      deviation_note: '字段缺失导致判断偏差',
      reporter_role: 'sales',
    });
    expect(r.ok).toBe(true);
    const d = (await query(`SELECT feedback FROM crm.decision WHERE decision_id=$1`, [decisionId])).rows[0];
    expect(d.feedback.usable).toBe(false);
    expect(d.feedback.major_deviation).toBe(true);
  });
});