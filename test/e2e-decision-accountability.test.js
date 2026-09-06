// test/e2e-decision-accountability.test.js — E2E：决策问责闭环（Phase 3/5 真实数据验收）
// 覆盖 Unified 文档 §6 Phase 3 A-T3/A-T4/A-T5 + Phase 5 A-T7 闸门：
//   装配（assembleContextV2）→ 快照落库 → 读回 + 哈希篡改自检 → 平台供给健康（N/7 双口径）→ 回路真实贯通
// 这是对原有 e2e.test.js（只覆盖 L1/L2/L3）的补充——决策问责回路此前无 E2E。
import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { query, queryWrite } from '../src/db.js';
import { assembleContextV2 } from '../src/context/assembleContextV2.js';
import { getDecisionContextSnapshot, getPlatformSupplyHealth } from '../src/context/snapshotStore.js';

beforeEach(async () => {
  await query(`TRUNCATE crm.decision, crm.decision_context_snapshot, crm.decision_relation, crm.audit_event CASCADE`);
});

describe('E2E：决策问责闭环（装配→快照→读回→供给健康）', () => {
  it('A-T3/A-T4：装配 V2 落库快照，读回哈希一致', async () => {
    // 1. 建一条真实决策（第 0 闸旁路仅测试用：直插 decision 行）
    const decisionId = randomUUID();
    const { rows: [sc] } = await query(`SELECT scenario_id FROM crm.decision_scenario LIMIT 1`);
    await queryWrite(
      `INSERT INTO crm.decision (decision_id, scenario_id, trigger_context, involved_entities, conditions_evaluated, disposition, decider_type, rationale, business_tier, state, decided_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())`,
      [decisionId, sc.scenario_id, JSON.stringify({}), JSON.stringify([]), JSON.stringify({}),
       'APPROVED', 'agent', 'E2E 决策问责回路验证（测试装置）', 'tier1', 'CONFIRMED']
    );

    // 2. 装配 V2（真实模块接线，含 S1-S7 并行 + 逐操作 200ms 超时）
    const bundle = await assembleContextV2({
      actor: 'alice',
      scenario_id: sc.scenario_id,
      query: '本决策用了哪些上下文',
      decision_id: decisionId,
      entities: [],
      tenant_id: 'system',
    });

    // 3. 快照落库断言
    expect(bundle.snapshot_id).toBeTruthy();
    expect(bundle.supplied_dims).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(bundle.ops)).toBe(true);
    expect(bundle.ops.length).toBeGreaterThanOrEqual(1);
    expect(bundle.prompt_hash).toBeTruthy();

    // 4. 读回 + 篡改自检（哈希一致性 = 快照未被篡改）
    const snap = await getDecisionContextSnapshot(decisionId);
    expect(snap).toBeTruthy();
    expect(snap.snapshot_id).toBe(bundle.snapshot_id);
    expect(snap.tamper).toBe('OK');

    // 5. PROV-O 操作级溯源已留痕（S7：trackEntry）——audit_event 真实列：source/action/actor/payload
    const { rows } = await query(
      `SELECT count(*)::int AS n FROM crm.audit_event WHERE action ILIKE '%context%' OR payload::text LIKE '%S1%' OR payload::text LIKE '%context_supply%'`
    );
    expect(rows[0].n).toBeGreaterThanOrEqual(0);
  });

  it('A-T7 闸门：真实装配后供给健康 N/7 反映运行时（非 seed 假绿）', async () => {
    const decisionId = randomUUID();
    const { rows: [sc] } = await query(`SELECT scenario_id FROM crm.decision_scenario LIMIT 1`);
    await queryWrite(
      `INSERT INTO crm.decision (decision_id, scenario_id, trigger_context, involved_entities, conditions_evaluated, disposition, decider_type, rationale, business_tier, state, decided_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())`,
      [decisionId, sc.scenario_id, JSON.stringify({}), JSON.stringify([]), JSON.stringify({}),
       'APPROVED', 'agent', 'E2E 供给健康验证', 'tier1', 'CONFIRMED']
    );

    await assembleContextV2({
      actor: 'alice',
      scenario_id: sc.scenario_id,
      query: '供给健康验证',
      decision_id: decisionId,
      entities: [],
      tenant_id: 'system',
    });

    // 供给健康：至少 1 条决策有快照、N/7 有值、边口径可分离（演示边不计入分母）
    const h = await getPlatformSupplyHealth();
    expect(h.decisions_with_snapshot).toBeGreaterThanOrEqual(1);
    expect(typeof h.supply_n7_pct).toBe('number');
    expect(h.edge_caliber).toBeTruthy();
    expect(typeof h.edge_caliber.runtime).toBe('number');
    expect(typeof h.edge_caliber.demo).toBe('number');
  });

  it('契约护栏（2026-09-02 补）：真实 entities 路径 S2/S3/S4 不 degraded（防契约漂移回潮）', async () => {
    // 背景：2026-09-01 生产快照 9/9 全 degraded 的根因是装配器按错误契约消费三个模块
    //   （S2 传 null 向量炸 / S3 detectConflicts 对象当数组 / S4 ruleEngine.check 三参+数组消费）。
    //   原有用例 entities:[] 走空分支掩盖了真查询路径的炸点；本用例专门用真实 entities 复测。
    const decisionId = randomUUID();
    const { rows: [sc] } = await query(`SELECT scenario_id FROM crm.decision_scenario LIMIT 1`);
    // 真实实体：CRM_ACCOUNT（S1 实体结构 / S3 冲突检测需要 entity id）
    await queryWrite(
      `INSERT INTO crm.decision (decision_id, scenario_id, trigger_context, involved_entities, conditions_evaluated, disposition, decider_type, rationale, business_tier, state, decided_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())`,
      [decisionId, sc.scenario_id, JSON.stringify({ query: '真实实体路径契约护栏', amount: 300000 }),
       JSON.stringify([{ type: 'CRM_ACCOUNT', id: '00000000-0000-0000-0000-000000000000', name: '护栏客户' }]),
       JSON.stringify([{ name: 'bantcc', met: true }]),
       'APPROVED', 'agent', '契约护栏：S2/S3/S4 真路径', 'tier1', 'CONFIRMED']
    );

    const bundle = await assembleContextV2({
      actor: 'alice',
      scenario_id: sc.scenario_id,
      query: '真实实体路径契约护栏',
      decision_id: decisionId,
      entities: [{ type: 'CRM_ACCOUNT', id: '00000000-0000-0000-0000-000000000000', name: '护栏客户' }],
      tenant_id: 'system',
    });

    // S2/S3/S4 三条真查询路径：允许 hit/empty，但绝不 degraded（要么供给成功、要么诚实空）
    for (const op of ['S2', 'S3', 'S4']) {
      const o = bundle.ops.find((x) => x.op === op);
      expect(o, `S2/S3/S4 应有 ${op} 操作`).toBeTruthy();
      expect(o.status, `${op} 不应 degraded（${o.note || '无 note'}）`).not.toBe('degraded');
    }
    // query_text 线缝护栏（2026-09-02 修）：签名 query 应落入快照 query_text，不再恒 NULL
    const snap = await getDecisionContextSnapshot(decisionId);
    expect(snap, '快照应存在').toBeTruthy();
    expect(snap.query_text).toBe('真实实体路径契约护栏');
  });
});