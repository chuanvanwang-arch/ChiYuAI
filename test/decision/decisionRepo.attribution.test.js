// test/decision/decisionRepo.attribution.test.js
import { createDecision } from '../../src/decision/decisionRepo.js';
import { queryWrite, query } from '../../src/db.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const sid = 'ATTR_TEST_SCENARIO';
describe('createDecision attribution', () => {
  // 本测试为自测创建自定义 scenario（required_dims 场景）——afterEach 清理，
  // 避免污染其他文件对 decision_scenario 种子数量（10）的断言。
  // 先清本测试创建的决策行（scenario_id FK），再删场景，对齐 decision.test.js TRUNCATE 纪律。
  // 清理：createDecision 会写 decision_event/memory_log/precedent_rel/provenance/audit 等（FK 引用 decision）。
  // 用 TRUNCATE 多表 CASCADE 统一清（对齐 decision.test.js 纪律），再删自建 scenario，防 FK 冲突与种子污染。
  afterEach(async () => {
    await queryWrite(
      `TRUNCATE crm.decision_event, crm.decision_precedent_rel, crm.decision_provenance,
                crm.memory_log, crm.decision RESTART IDENTITY CASCADE`
    );
    await queryWrite(`DELETE FROM crm.decision_scenario WHERE scenario_id=$1`, [sid]);
  });
  beforeEach(async () => {
    await queryWrite(
      `INSERT INTO crm.decision_scenario(scenario_id, stage, trigger, eval_dimensions, required_dims)
       VALUES ($1, 'ACTIVE', '{}'::jsonb, '[]'::jsonb, $2::jsonb)
       ON CONFLICT (scenario_id, tenant_id) DO UPDATE SET required_dims=$2::jsonb`,
      [sid, JSON.stringify([{ dim: 'identity', on_missing: 'warn' }, { dim: 'time', on_missing: 'block' }])]
    );
  });
  it('rejects write when block-required dimension missing (T3 interception)', async () => {
    // time 为 on_missing='block'，缺失 → createDecision 应抛 missing_context 拒写
    await expect(
      createDecision({
        scenario_id: sid,
        trigger_context: { identity: 'acme' }, // time 缺失
        involved_entities: [],
        conditions_evaluated: [],
        disposition: 'PROCEED',
        rationale: 'r',
        business_tier: 'NORMAL',
        state: 'REQUIRED',
      })
    ).rejects.toThrow(/missing_context/);
  });
  it('materializes attribution when block dim present (warn missing still marks but allows)', async () => {
    // time(block) 提供；identity(warn) 缺失 → 应建成功且标 input_missing（warn 不阻断）
    const d = await createDecision({
      scenario_id: sid,
      trigger_context: { time: 'Q3' }, // identity 缺失（warn）
      involved_entities: [],
      conditions_evaluated: [{ cond: 'identity_x' }],
      disposition: 'PROCEED',
      rationale: 'r',
      business_tier: 'NORMAL',
      state: 'REQUIRED',
    });
    expect(d.attribution.required_fill.missing).toEqual(['identity']);
    expect(d.attribution.category).toBe('input_missing');
  });
  it('all required present -> ok', async () => {
    const d = await createDecision({
      scenario_id: sid,
      trigger_context: { identity: 'acme', time: 'Q3' },
      involved_entities: [],
      conditions_evaluated: [],
      disposition: 'PROCEED',
      rationale: 'r',
      business_tier: 'NORMAL',
      state: 'REQUIRED',
    });
    expect(d.attribution.required_fill.missing).toEqual([]);
    expect(d.attribution.category).toBe('ok');
  });
});
