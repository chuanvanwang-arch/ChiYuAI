// test/g4-dispatch-loop.integration.test.js — G4 修复验证
// 验证 4-agent 全自治派发闭环：routeThroughIntake → 注入 contract_task_id → runWithSkill 执行 → decision 事件贯通 + memory_log 回写
// 策略 A（rule 回退集成测试）：用确定性 mock runWithSkillFn 驱动，CI 友好、无 LLM 依赖。
import { describe, it, expect, beforeEach } from 'vitest';
import { query } from '../src/db.js';
import { createTask, getTask } from '../src/kanban/kanban.js';
import { routeThroughIntake, dispatchOneCore } from '../src/kanban/scheduler.js';

beforeEach(async () => {
  await query(`TRUNCATE crm.tasks, crm.decision, crm.decision_event, crm.memory_log CASCADE`);
});

describe('G4 派发闭环集成', () => {
  // 层 1：routeThroughIntake 纯函数四象限（无 DB）
  it('routeThroughIntake 四象限路由正确', () => {
    const normal = routeThroughIntake({ id: 't1', payload: { intent: 'quote', level: 'normal' } });
    expect(normal.targetAgent).toBe('quote-engine');
    expect(normal.gateAgents).toEqual([]);
    expect(normal.payload.dispatchedFrom).toBe('intake-router');
    // D2 修复：契约键改为稳定短键（旧格式 intake:<id>:<level>:<agent> 无法与契约块 JOIN）
    expect(normal.payload.contract_task_id).toBe('ct-quote-calc');
    // D4 修复：主 SKILL 经 payload 注入，供 agentLoop 装载（旧实现恒回落 crm-skill-fallback）
    expect(normal.payload.skill_slug).toBe('method-quote-engine');

    const major = routeThroughIntake({ id: 't2', payload: { intent: 'quote', level: 'major' } });
    expect(major.targetAgent).toBe('quote-engine');
    expect(major.gateAgents).toEqual(['review-gate']); // 重大商机 D 把关

    const followup = routeThroughIntake({ id: 't3', payload: { intent: 'followup', level: 'normal' } });
    expect(followup.targetAgent).toBe('followup-agent');

    const majorFollowup = routeThroughIntake({ id: 't4', payload: { intent: 'followup', level: 'major' } });
    expect(majorFollowup.targetAgent).toBe('followup-agent');
    expect(majorFollowup.gateAgents).toEqual(['review-gate']);
  });

  // 层 2：dispatchOneCore 将 contract_task_id + targetAgent 注入 runWithSkill 的 opts.ctx（修复位置参数错位 bug）
  it('dispatchOneCore 将 contract_task_id 与 targetAgent 正确注入 runWithSkill 的 ctx', async () => {
    const task = await createTask({ step: 'agent', title: 'G4-2', actionName: 'crm-deal-analyze', payload: { intent: 'quote', level: 'major' }, chainId: 'g4' });
    const calls = [];
    // D6 fail-safe 契约（scheduler.js runGateAgents）：gate 角色必须返回 verdict，缺失或非 pass ⇒ 保守 reject。
    // 主执行返回执行产物；review-gate 返回 verdict=pass 才能走到 completeTask（否则任务被 gateBlockTask 置 blocked）。
    const fakeRun = async (t, opts) => {
      calls.push({ t, opts });
      if (opts?.ctx?.actor === 'review-gate') return { verdict: 'pass' };
      return { ok: true, decision_id: 'x' };
    };
    await dispatchOneCore(task, { runWithSkillFn: fakeRun });

    // 主执行：路由目标 + 主 SKILL + 契约键
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const main = calls[0];
    expect(main.opts.ctx.contractTask).toBe('ct-quote-calc');
    expect(main.opts.ctx.actor).toBe('quote-engine'); // 路由目标写入 actor，供 episode 溯源
    expect(main.t.payload.skill_slug).toBe('method-quote-engine');

    // D6：重大商机触发 review-gate 串行把关（此前 gateAgents 算出却从不派发）
    const gateCall = calls.find((c) => c.opts.ctx.actor === 'review-gate');
    expect(gateCall).toBeTruthy();
    expect(gateCall.opts.ctx.contractTask).toBe('ct-review-gate');
    expect(gateCall.t.payload.skill_slug).toBe('method-review-gate');

    const done = await getTask(task.id);
    expect(done.status).toBe('done');
    expect(done.result.gate).toBeTruthy();
    expect(done.result.gate['review-gate'].ok).toBe(true);
  });

  // 层 3：真实闭环（rule 回退）→ agent 经第0闸落 decision + memory_log，并回写 contract_task_id
  it('闭环：agent 写 decision + memory_log 并贯通 contract_task_id', async () => {
    const task = await createTask({ step: 'agent', title: 'G4-3', actionName: 'crm-deal-analyze', payload: { intent: 'quote', level: 'normal' }, chainId: 'g4' });
    const expectedCt = 'ct-quote-calc';

    const { rows: [sc] } = await query(`SELECT scenario_id FROM crm.decision_scenario LIMIT 1`);
    const scenarioId = sc.scenario_id;

    // 模拟 rule 回退 SKILL 执行：第0闸强制 decision_id，并写记忆回写
    const fakeRun = async (t, opts) => {
      const ct = opts.ctx.contractTask;
      const dres = await query(
        `INSERT INTO crm.decision (scenario_id, trigger_context, involved_entities, conditions_evaluated, disposition, decider_type, rationale, business_tier, state)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING decision_id`,
        [scenarioId, JSON.stringify({ contract_task_id: ct }), JSON.stringify({ task: t.id }), JSON.stringify({}), 'APPROVED', 'agent', 'rule-fallback', 'tier1', 'CONFIRMED']
      );
      const decisionId = dres.rows[0].decision_id;
      await query(
        `INSERT INTO crm.memory_log (topic, kind, payload) VALUES ($1,$2,$3)`,
        [`decision:${decisionId}`, 'decision', JSON.stringify({ contract_task_id: ct, decision_id: decisionId })]
      );
      return { ok: true, decision_id: decisionId };
    };

    await dispatchOneCore(task, { runWithSkillFn: fakeRun });

    const done = await getTask(task.id);
    expect(done.status).toBe('done');

    const d = await query(`SELECT decision_id, trigger_context FROM crm.decision WHERE trigger_context::text LIKE $1`, [`%${expectedCt}%`]);
    expect(d.rows.length).toBe(1);
    expect(d.rows[0].trigger_context.contract_task_id).toBe(expectedCt);

    const m = await query(`SELECT payload FROM crm.memory_log WHERE payload::text LIKE $1`, [`%${expectedCt}%`]);
    expect(m.rows.length).toBe(1);
  });
});
