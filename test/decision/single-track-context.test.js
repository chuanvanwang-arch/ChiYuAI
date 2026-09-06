// test/decision/single-track-context.test.js — F4 消除双轨（2026-09-02）
//
// 缺陷（审计发现）：
//   autonomyEngine.requireDecision 在决策落库**之前**自己检索先例（searchPrecedents，k=5，
//   qvec=hashVector({scenario_id, ctx, cond})）算置信度并据此自主/升级；
//   而 createDecision 在 INSERT **之后**才调 assembleContextV2 重跑一遍 S2
//   （qvec=buildDecisionEmbedding({conditions_evaluated: []})，k=3，minSimilarity=0.6）。
//   两批先例不同源 → 落到 decision_context_snapshot 里归档的上下文 ≠ 真正驱动该决策的上下文。
//   后果：快照是「事后解释」而非「事前驱动」，可审计性失效（Q1/Q4 判据建立在假证据上）。
//
// 单轨契约（本文件锁定，回潮即红）：
//   ① 装配发生在 INSERT 之前（phase='pre'），落库只做 freeze，不再重检索；
//   ② 引擎算置信度用的那批先例 ≡ 快照 S2 归档的那批先例（恒等，不多不少）；
//   ③ 未传 pre_context 的存量调用方零修改仍产出快照，且同样标注 phase='pre'；
//   ④ phase 如实标注：事前装配失败退回事后装配时标 'post'，绝不冒充 'pre'。
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { query } from '../../src/db.js';
import { assembleContextV2, defaultRetrievers } from '../../src/context/assembleContextV2.js';
import { getDecisionContextSnapshot } from '../../src/context/snapshotStore.js';
import { createDecision, confirmDecision } from '../../src/decision/decisionRepo.js';
import { requireDecision } from '../../src/decision/autonomyEngine.js';

// LEAD_FOLLOW_UP 全方法论维度满足（与 test/decision.test.js 同源基线；SKILL 事实源变更后需同步）
const FULL = {
  B: true, A: true, N: true, T: true, M: true, E: true, D1: true, D2: true, I: true, C1: true, C2: true,
  value: true, win_prob: true, competitive_position: true,
};

const PREC_A = 'aaaa0000-0000-0000-0000-000000000001';
const PREC_B = 'aaaa0000-0000-0000-0000-000000000002';

// ─────────────────────────────────────────────────────────────────────────────
// A 组：冻结模式（装配/落库两阶段拆分）—— 纯装配 + 注入桩，仅校验契约不依赖业务数据
// ─────────────────────────────────────────────────────────────────────────────
describe('A. 冻结模式 freeze（事前装配 → 事后落库，不再重检索）', () => {
  it('A1 冻结不再触发任何 retriever（红线：旧实现会重跑 S1–S7 七次）', async () => {
    let s2Calls = 0;
    const rs = {
      ...defaultRetrievers(),
      S2: async () => { s2Calls += 1; return { items: [{ similarity: 0.9, scenario: 'X', disposition: 'APPROVE' }] }; },
    };
    const pre = await assembleContextV2({ actor: 't1', phase: 'pre', persist: false }, rs);
    expect(s2Calls).toBe(1); // 事前装配跑一次

    const frozen = await assembleContextV2({ pre_context: pre, decision_id: null }, rs);
    expect(s2Calls).toBe(1); // ★ 冻结不得再次检索（旧实现此处为 2）
    expect(frozen.frozen).toBe(true);
    expect(frozen.reused_assembly_id).toBe(pre.assembly_id);
    expect(frozen.ops).toEqual(pre.ops);           // 逐字复用，不重算
    expect(frozen.prompt_hash).toBe(pre.prompt_hash);
  });

  it('A2 S2 复用引擎注入的先例（不二次检索），且每条带 decision_id 与 source 可审计', async () => {
    const precs = [
      { decision_id: PREC_A, similarity: 0.91, scenario_id: 'LEAD_FOLLOW_UP', disposition: 'APPROVE' },
      { decision_id: PREC_B, similarity: 0.77, scenario_id: 'LEAD_FOLLOW_UP', disposition: 'ESCALATE' },
    ];
    const r = await assembleContextV2({ actor: 't2', scenario_id: 'LEAD_FOLLOW_UP', precedents: precs, persist: false }, defaultRetrievers());
    const s2 = r.ops.find((o) => o.op === 'S2');
    expect(s2.status).toBe('hit');
    expect(s2.items.map((i) => i.decision_id)).toEqual([PREC_A, PREC_B]);
    expect(s2.items[0].source).toBe(`precedent:${PREC_A}`);
    expect(s2.items[0].similarity).toBe(0.91);
  });

  it('A3 persist:false → 零落库、零 PROV-O（装配与落库解耦，决策未落库不留孤儿快照）', async () => {
    const pre = await assembleContextV2({ actor: 't3', persist: false }, defaultRetrievers());
    expect(pre.persisted).toBe(false);
    const { rows } = await query(
      `SELECT 1 FROM crm.decision_context_snapshot WHERE assembly_id=$1::uuid`, [pre.assembly_id]
    );
    expect(rows).toHaveLength(0);
    const { rows: prov } = await query(
      `SELECT 1 FROM crm.decision_provenance WHERE payload->>'assembly_id'=$1`, [pre.assembly_id]
    ).catch(() => ({ rows: [] })); // 表可能不存在（未跑 ensureProvenanceSchema），此时视为零留痕
    expect(prov).toHaveLength(0);
  });

  it('A4 冻结后快照落库带 phase=pre 且回指决策（可审计：证明是事前驱动而非事后解释）', async () => {
    const sc = (await query(`SELECT scenario_id FROM crm.decision_scenario LIMIT 1`)).rows[0].scenario_id;
    const pre = await assembleContextV2({
      actor: 't4', scenario_id: sc, entities: [{ type: 'CRM_ACCOUNT', id: randomUUID(), name: '冻结测试' }],
      query: '冻结模式验证', persist: false,
    }, defaultRetrievers());

    const d = await createDecision({
      scenario_id: sc,
      trigger_context: { query: '冻结模式验证' },
      involved_entities: [{ type: 'CRM_ACCOUNT', id: randomUUID(), name: '冻结测试' }],
      conditions_evaluated: [{ name: 'bantcc', met: true }],
      effective_policy_version: null,
      disposition: 'PROCEED',
      decider_type: 'agent',
      decider_id: 'freeze-test',
      rationale: 'A4：验证 pre_context 冻结落库',
      business_tier: 'HIGH',
      state: 'PROCESSED',
      tenantId: 'system',
      pre_context: pre,
    });

    const snap = await getDecisionContextSnapshot(d.decision_id);
    expect(snap).toBeTruthy();
    expect(snap.phase).toBe('pre');
    expect(String(snap.assembly_id)).toBe(String(pre.assembly_id)); // 未重新装配
    expect(snap.prompt_hash).toBe(pre.prompt_hash);                 // 内容逐字一致
    expect(String(snap.decision_id)).toBe(String(d.decision_id));   // 回指成功
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B 组：E2E —— 引擎路径与落库路径必须同源
// ─────────────────────────────────────────────────────────────────────────────
describe('B. 单轨 E2E（引擎算的 == 快照归档的）', () => {
  it('B1 存量调用方零修改：不传 pre_context 的 createDecision 仍产出快照，且 phase=pre', async () => {
    const sc = (await query(`SELECT scenario_id FROM crm.decision_scenario LIMIT 1`)).rows[0].scenario_id;
    const d = await createDecision({
      scenario_id: sc,
      trigger_context: { query: '单轨回归验证' },
      involved_entities: [{ type: 'CRM_ACCOUNT', id: randomUUID(), name: '单轨回归' }],
      conditions_evaluated: [{ name: 'bantcc', met: true }],
      effective_policy_version: null,
      disposition: 'PROCEED',
      decider_type: 'agent',
      decider_id: 'single-track-legacy',
      rationale: 'B1：存量调用方零修改仍产出事前快照',
      business_tier: 'NORMAL',
      state: 'PROCESSED',
      tenantId: 'system',
    });
    const snap = await getDecisionContextSnapshot(d.decision_id);
    expect(snap).toBeTruthy();
    expect(snap.phase).toBe('pre'); // ★ 回潮（装配退回 INSERT 之后）即红
  });

  it('B2 引擎路径：快照 S2 归档的先例集合 ≡ 引擎算置信度用的那批先例（核心红线）', async () => {
    const C = { customer: 'normal', project: 'pilot', conditions: FULL };
    // 先造 2 条已确认先例，保证检索非空（否则断言退化为恒真）
    for (const id of ['st-prec-1', 'st-prec-2']) {
      const r = await requireDecision('LEAD_FOLLOW_UP', C, [{ type: 'DEAL', id }]);
      await confirmDecision(r.decision.decision_id, { by_role: 'sales' });
    }
    const r3 = await requireDecision('LEAD_FOLLOW_UP', C, [{ type: 'DEAL', id: 'st-prec-3' }]);
    expect(r3.precedents.length).toBeGreaterThan(0); // 非空校验：断言不退化

    const snap = await getDecisionContextSnapshot(r3.decision.decision_id);
    expect(snap).toBeTruthy();
    expect(snap.phase).toBe('pre');
    const s2 = (snap.ops || []).find((o) => o.op === 'S2');
    expect(s2).toBeTruthy();

    const archived = (s2.items || []).map((i) => String(i.decision_id)).sort();
    const used = r3.precedents.map((p) => String(p.decision_id)).sort();
    expect(archived).toEqual(used); // ★ 双轨时此处必不等（k/阈值/qvec 三处不同源）

    // 引用链同源二次确认：决策行 referenced_precedents 也须是同一批
    const ref = (r3.decision.referenced_precedents || []).map((p) => String(p.precedent_id)).sort();
    expect(ref).toEqual(used);
  });

  it('B3 反假绿：冻结快照的 supplied_dims/prompt_hash 与事前装配逐字一致（重检索必漂移）', async () => {
    const sc = (await query(`SELECT scenario_id FROM crm.decision_scenario LIMIT 1`)).rows[0].scenario_id;
    const pre = await assembleContextV2({
      actor: 't5', scenario_id: sc, entities: [{ type: 'CRM_ACCOUNT', id: randomUUID(), name: '漂移检测' }],
      query: '漂移检测', persist: false,
      precedents: [{ decision_id: PREC_A, similarity: 0.66, scenario_id: sc, disposition: 'APPROVE' }],
    }, defaultRetrievers());

    const d = await createDecision({
      scenario_id: sc,
      trigger_context: { query: '漂移检测' },
      involved_entities: [{ type: 'CRM_ACCOUNT', id: randomUUID(), name: '漂移检测' }],
      conditions_evaluated: [{ name: 'bantcc', met: true }],
      effective_policy_version: null,
      disposition: 'PROCEED',
      decider_type: 'agent',
      decider_id: 'drift-test',
      rationale: 'B3：重检索必漂移',
      business_tier: 'NORMAL',
      state: 'PROCESSED',
      tenantId: 'system',
      pre_context: pre,
    });
    const snap = await getDecisionContextSnapshot(d.decision_id);
    expect(snap.supplied_dims).toBe(pre.supplied_dims);
    expect(snap.prompt_hash).toBe(pre.prompt_hash);
    expect(String(snap.assembly_id)).toBe(String(pre.assembly_id));
  });
});
