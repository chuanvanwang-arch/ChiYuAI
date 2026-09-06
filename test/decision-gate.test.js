// test/decision-gate.test.js — 写通道第 0 闸（决策事件主轴：无 decision_id 不写）
import { describe, it, expect, beforeAll } from 'vitest';
import { seedActions } from '../src/action/seed-actions.js';
import { actionExecutor } from '../src/action/executor.js';
import { createParticle } from '../src/particles/particleRepo.js';
import { query } from '../src/db.js';

beforeAll(() => seedActions());

describe('写通道第 0 闸', () => {
  it('写操作无 decision_id 且非 bootstrap 非 autoDecision → 拒绝（gate=decision_required）', async () => {
    const r = await actionExecutor.dispatch(
      'data-particle-create', { type: 'CRM_KNOWLEDGE', payload: { term: 't', content: 'c' } }, { actor: 'sales' }
    );
    expect(r.ok).toBe(false);
    expect(r.gate).toBe('decision_required');
  });

  it('bootstrap 旁路（系统引导/种子）→ 通过', async () => {
    const r = await actionExecutor.dispatch(
      'data-particle-create', { type: 'CRM_KNOWLEDGE', payload: { term: 't', content: 'c' } }, { actor: 'sys', bootstrap: true }
    );
    expect(r.ok).toBe(true);
  });

  it('携带 decision_id → 通过（写与决策绑定）', async () => {
    // 2026-09-03 QA 缺陷修复：原用例用假 UUID '00000000-...' 直接透传 → particles.decision_id
    //   FK 引用 crm.decision，假 UUID 撞 FK（decision_id 恒落失败）。改为先 INSERT 真实 decision
    //   行（决策表最小列集），再取真实 UUID 透传，使断言真正落在「写与决策绑定」被测行为上。
    const d = await query(
      `INSERT INTO crm.decision (scenario_id, trigger_context, involved_entities, conditions_evaluated, disposition, decider_type, rationale, business_tier, state)
       VALUES ('OPP_QUALIFY', '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, 'APPROVE', 'HUMAN', 'test', 'LOW', 'CONFIRMED')
       RETURNING decision_id`
    );
    const decisionId = d.rows[0].decision_id;
    const r = await actionExecutor.dispatch(
      'data-particle-create', { type: 'CRM_KNOWLEDGE', payload: { term: 't', content: 'c' } },
      { actor: 'sales', decision_id: decisionId }
    );
    expect(r.ok).toBe(true);
  });

  it('autoDecision Action（crm-deal-advance）自动 mint decision → 通过（无决策不写=引擎拍板）', async () => {
    // 基线同步（2026-09-01）：第3.5闸 S1→S2 为 hard 闸，要求 needs 事实 ≥ gate.s1_s2_min_need_facts
    // （executor.js:182-189）。原用例 payload 仅 {name, stage} → 恒被拦于业务闸，测不到决策闸语义。
    // 此处补足需求事实（3 项 ≥ 任意阈值），使断言真正落在「autoDecision 自动 mint」这一被测行为上。
    const deal = await createParticle(
      'CRM_DEAL',
      { name: 'G', stage: 'lead', needs: { product: 'P1', qty: 10, spec: '标准配置' } },
      { tenantId: 'system' }
    );
    const r = await actionExecutor.dispatch(
      'crm-deal-advance', { deal_id: deal.id, to_stage: 'S2', transitionedBecause: '推进商机阶段' }, { actor: 'sales', tenantId: 'system' }
    );
    // 2026-09-06 闸门修复：第1.7闸对缺 tenantId 的执行上下文 fail-closed（原按 system 静默放行），
    // 本用例须显式带 tenantId，否则测不到「autoDecision 自动 mint」而先被权益闸拦下。
    // 可诊断性（2026-09-02）：原断言仅 expect(r.ok).toBe(true)，批量跑偶发红时只报
    // 「expected false to be true」，不吐 gate/error → 无法区分「哪一道闸拦的」与「异常抛的」。
    // dispatch 的失败出口有 8 种（executor.js:30/42/54/65/73/80/87/104）+ 1 个 catch-all（:167），
    // 把它们打进断言消息，串扰复现时可一眼定位根因。不改变被测行为。
    expect(r.ok, `dispatch 失败 → gate=${r.gate || '(无，即 catch-all 异常)'} error=${r.error || ''}`).toBe(true);
    expect(r.data.decision_id).toBeTruthy();
    // 2026-09-02 反假执行加固：决策必须真正落库到粒子 payload（此前仅内存对象 → DB 恒 null 断链）。
    // 断言从「返回体有 decision_id」强化到「DB 中 last_decision_id == 返回的 decision_id」。
    const { getParticle } = await import('../src/particles/particleRepo.js');
    const persisted = await getParticle(deal.id);
    expect(persisted.payload.last_decision_id).toBe(r.data.decision_id);
  });
});
