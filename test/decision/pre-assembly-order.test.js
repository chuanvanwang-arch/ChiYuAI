// test/decision/pre-assembly-order.test.js — F4 调用序护栏（2026-09-02）
//
// 为什么单独一个文件：需要 vi.mock 包裹 assembleContextV2 记录调用序列，
//   而 vi.mock 是文件级提升（hoisted），与 single-track-context.test.js 的真实实现断言互斥。
//
// 锁定的不变量（回潮即红）：
//   createDecision 的**第一次**装配调用发生时，决策行还不存在（input.decision_id 为空）
//   → 证明 7×7 装配真的发生在 INSERT 之前，快照是「事前驱动」而非「事后解释」。
//   若有人把装配退回 INSERT 之后，第一次调用的 decision_id 就有值 → 本文件立刻红。
//
//   第二次调用必须是 freeze：带 pre_context（复用事前结果）+ 带真实 decision_id（落库回指）。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { query } from '../../src/db.js';

const state = vi.hoisted(() => ({ calls: [] }));

vi.mock('../../src/context/assembleContextV2.js', async () => {
  const actual = await vi.importActual('../../src/context/assembleContextV2.js');
  return {
    ...actual,
    assembleContextV2: async (input = {}, retrievers = null) => {
      state.calls.push({
        phase: input.phase ?? null,
        hasPreContext: !!input.pre_context,
        hasDecisionId: !!input.decision_id,
        persist: input.persist !== false,
        hasInjectedPrecedents: Array.isArray(input.precedents),
      });
      return actual.assembleContextV2(input, retrievers);
    },
  };
});

const { createDecision } = await import('../../src/decision/decisionRepo.js');
const { requireDecision } = await import('../../src/decision/autonomyEngine.js');
const { assembleContextV2 } = await import('../../src/context/assembleContextV2.js');

beforeEach(() => { state.calls = []; });

async function mkDecision(extra = {}) {
  const sc = (await query(`SELECT scenario_id FROM crm.decision_scenario LIMIT 1`)).rows[0].scenario_id;
  return createDecision({
    scenario_id: sc,
    trigger_context: { query: '调用序验证' },
    involved_entities: [{ type: 'CRM_ACCOUNT', id: randomUUID(), name: '调用序验证客户' }],
    conditions_evaluated: [{ name: 'bantcc', met: true }],
    effective_policy_version: null,
    disposition: 'PROCEED',
    decider_type: 'agent',
    decider_id: 'order-test',
    rationale: '调用序验证',
    business_tier: 'NORMAL',
    state: 'PROCESSED',
    tenantId: 'system',
    ...extra,
  });
}

describe('装配调用序（事前装配 → 冻结落库）', () => {
  it('O1 未传 pre_context：第一次装配在决策落库之前（decision_id 为空），第二次才是冻结落库', async () => {
    const d = await mkDecision();
    expect(state.calls.length).toBeGreaterThanOrEqual(2);

    // ① 事前装配：无 decision_id（决策尚不存在）+ 不落库
    expect(state.calls[0].hasDecisionId).toBe(false);
    expect(state.calls[0].persist).toBe(false);
    expect(state.calls[0].phase).toBe('pre');

    // ② 冻结落库：复用事前结果 + 回填真实 decision_id
    const freeze = state.calls[state.calls.length - 1];
    expect(freeze.hasPreContext).toBe(true);
    expect(freeze.hasDecisionId).toBe(true);
    expect(freeze.persist).toBe(true);
    expect(d.decision_id).toBeTruthy();
  });

  it('O2 传入 pre_context：零次检索式装配，仅一次冻结（消除双轨的最强形态）', async () => {
    const sc = (await query(`SELECT scenario_id FROM crm.decision_scenario LIMIT 1`)).rows[0].scenario_id;
    const pre = await assembleContextV2({
      actor: 'order-test', scenario_id: sc, query: '调用序验证', persist: false,
    });
    state.calls = []; // 抹掉构造 pre 自身的那次调用
    await mkDecision({ pre_context: pre });

    expect(state.calls).toHaveLength(1);
    expect(state.calls[0].hasPreContext).toBe(true);
    expect(state.calls[0].phase).toBe('pre');
  });

  it('O3 引擎路径：requireDecision 把同一批先例注入事前装配（S2 不再自检索）', async () => {
    const C = { customer: 'normal', project: 'pilot', conditions: { B: true, A: true, N: true, T: true, M: true, E: true, D1: true, D2: true, I: true, C1: true, C2: true, value: true, win_prob: true, competitive_position: true } };
    await requireDecision('LEAD_FOLLOW_UP', C, [{ type: 'DEAL', id: 'order-prec-1' }]);

    const pre = state.calls.find((c) => !c.persist);
    expect(pre).toBeTruthy();
    expect(pre.hasInjectedPrecedents).toBe(true); // ★ 引擎把 precedents 传进来了
    expect(pre.hasDecisionId).toBe(false);
  });
});
