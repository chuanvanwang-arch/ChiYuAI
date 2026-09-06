// test/provenance-integrity.test.js — C2 审计链 T3/T4：决策生命周期事件入链 + 端到端集成回归
// 设计：docs/superpowers/plans/2026-09-03-c2c3c4-decision-integrity-implementation.md T3/T4
//
// T3 前的实况：27 处 recordDecisionEvent 的事件**全部在哈希链外**——决策「发生过什么」
//   （自主放行 / 升级人工 / 人工改判 / 物化）可被任意 UPDATE 且无痕，只有 decision 主条受保护。
//
// 覆盖面真查（2026-09-03 代码级清点，勿信「27 处全入链」的说法）：
//   入链（decision_id 非空，4 类）：made(decisionRepo:316) / autonomous(autonomyEngine:285)
//                                  / escalated(autonomyEngine:315) / human-disposition(disposition.js:72)
//   不入链（decision_id 恒 null，23 处，设计如此）：required（决策尚未产生，无 id 可挂）
//     / config_change ×19（configRouter.js:30 第 0 闸**降级**路径，本身就无决策对象）
//     / agent_dispatch ×2 / asset_uploaded ×1（派发与素材事件，无决策归属）
//   → 无归属事件入链只会制造孤儿条目（且被 FK 拒），故桥接以 decision_id 非空为唯一准入闸。
//
// 锁死五类回归：
//   ① 事件入链且链自洽（createDecision → decision + event:made，verifyChain OK）
//   ② 篡改事件条目 → TAMPERED（T3 的核心价值：事件此前零哈希保护）
//   ③ 无归属事件不入链（config_change 降级路径）——防止后人把「事件量」当「审计覆盖」灌水
//   ④ Q2 溯源口径收窄：event:* 不计入证据条目，事件入链不使可审计性评分漂移
//   ⑤ fail-open：审计写入失败不得阻断业务事件（DROP 表真实注入故障，非 mock）
import { describe, it, expect, beforeEach } from 'vitest';
import { query } from '../src/db.js';
import { on } from '../src/events/bus.js';
import {
  ensureProvenanceSchema, trackEntry, verifyChain,
} from '../src/decision/provenance.js';
import { createDecision, recordDecisionEvent } from '../src/decision/decisionRepo.js';
import { computeAudit4q } from '../src/decision/auditability.js';

const DID = '44444444-4444-4444-4444-444444444444';

const entriesOf = async (decisionId = DID) => (await query(
  `SELECT entry_type, hash_version FROM crm.decision_provenance WHERE decision_id=$1 ORDER BY id`,
  [decisionId]
)).rows;

beforeEach(async () => {
  await ensureProvenanceSchema();
  await query(
    `TRUNCATE crm.decision, crm.decision_provenance, crm.decision_precedent_rel, crm.decision_event,
              crm.memory_log, crm.monitor_event, crm.provenance_seal RESTART IDENTITY CASCADE`
  );
  // 裸决策行（不经 createDecision）：createDecision 内部会跑七维上下文装配、自动写 N 条 context_supply，
  //   无法构造「链里只有事件条目」的场景。需要该场景的用例（Q2 收窄反向验证）用这行手工决策。
  await query(
    `INSERT INTO crm.decision (decision_id, scenario_id, trigger_context, involved_entities, conditions_evaluated, disposition, decider_type, rationale, business_tier, state)
     VALUES ($1,'LEAD_FOLLOW_UP','{}','[]','[]','APPROVE','AUTONOMOUS_AGENT','event-link-test','NORMAL','AUTONOMOUS')`,
    [DID]
  );
});

async function makeDecision(overrides = {}) {
  return createDecision({
    scenario_id: 'LEAD_FOLLOW_UP',
    trigger_context: {},
    conditions_evaluated: [],
    disposition: 'APPROVE',
    decider_type: 'AUTONOMOUS_AGENT',
    rationale: 'event-link-test',
    business_tier: 'NORMAL',
    state: 'AUTONOMOUS',
    ...overrides,
  });
}

describe('T3 决策事件入链', () => {
  it('createDecision → provenance 同时含 evidence 条目与 event:made（T3 验收①）', async () => {
    const d = await makeDecision();
    const rows = await entriesOf(d.decision_id);
    const types = rows.map((r) => r.entry_type);
    expect(types).toContain('decision');
    expect(types).toContain('event:made');
    // 事件按 v2 入链（否则只覆盖 payload，篡改 entry_type 检不出）
    expect(rows.every((r) => Number(r.hash_version) >= 2)).toBe(true);
  });

  it('事件入链后 verifyChain 仍 OK（T3 验收②）', async () => {
    const d = await makeDecision();
    await expect(verifyChain({ decision_id: d.decision_id })).resolves.toMatchObject({ status: 'OK' });
  });

  it('无归属事件不入链：config_change 降级路径（decision_id=null）不产生孤儿条目', async () => {
    // configRouter.js:30 的降级路径就是这种形态——第 0 闸未产出决策，事件只有 scenario_id。
    await recordDecisionEvent('config_change', { scenario_id: 'config-change', trigger_context: { key: 'x' } });
    const { rows } = await query(`SELECT count(*)::int AS n FROM crm.decision_provenance`);
    expect(rows[0].n).toBe(0);
    // 但事件本身必须落库（审计降级留痕未丢失，只是不进哈希链）
    const ev = await query(`SELECT count(*)::int AS n FROM crm.decision_event WHERE event_type='config_change'`);
    expect(ev.rows[0].n).toBe(1);
  });

  it('篡改事件条目 → TAMPERED（T3 核心价值：事件此前零哈希保护）', async () => {
    const d = await makeDecision();
    await expect(verifyChain({ decision_id: d.decision_id })).resolves.toMatchObject({ status: 'OK' });
    // 抹掉 event:made 的痕迹（模拟"决策曾升级人工"的事实被抹除）
    await query(
      `UPDATE crm.decision_provenance SET entry_type='event:autonomous' WHERE decision_id=$1 AND entry_type='event:made'`,
      [d.decision_id]
    );
    const v = await verifyChain({ decision_id: d.decision_id });
    expect(v.status).toBe('TAMPERED');
  });

  it('事件 payload 篡改 → TAMPERED（升级原因/建议处置不可事后改写）', async () => {
    const d = await makeDecision();
    await query(
      `UPDATE crm.decision_provenance SET payload = payload || '{"scenario_id":"TAMPERED"}'::jsonb
        WHERE decision_id=$1 AND entry_type='event:made'`,
      [d.decision_id]
    );
    const v = await verifyChain({ decision_id: d.decision_id });
    expect(v.status).toBe('TAMPERED');
  });
});

describe('T4 C2 端到端集成回归', () => {
  it('Q2 溯源口径收窄：追加事件不增证据计数，评分不漂移', async () => {
    const d = await makeDecision();
    const before = await computeAudit4q(d.decision_id);
    // 基线：createDecision 内部七维装配已写 N 条 context_supply（N 随装配实现变化 → 一律用相对断言，不写魔数）
    expect(before.questions.Q2.event_entries).toBe(1);      // event:made 已入链，但不计入证据
    expect(before.health.statuses.Q2).toBe('pass');
    // 再追加一条生命周期事件：证据计数必须纹丝不动，只有 event_entries 增长
    await recordDecisionEvent('escalated', { decision_id: d.decision_id, scenario_id: 'LEAD_FOLLOW_UP' });
    const after = await computeAudit4q(d.decision_id);
    expect(after.questions.Q2.entries).toBe(before.questions.Q2.entries);
    expect(after.questions.Q2.context_supply_entries).toBe(before.questions.Q2.context_supply_entries);
    expect(after.questions.Q2.event_entries).toBe(before.questions.Q2.event_entries + 1);
    expect(after.health.statuses.Q2).toBe(before.health.statuses.Q2); // 评分不因事件入链而漂移
  });

  it('只有事件条目而无证据条目 → Q2 仍 warn（事件不能顶替溯源证据）', async () => {
    // 用裸决策行（不经 createDecision 装配）：链里只有 event:made，无 context_supply
    await recordDecisionEvent('made', { decision_id: DID, scenario_id: 'LEAD_FOLLOW_UP' });
    const a = await computeAudit4q(DID);
    expect(a.questions.Q2.event_entries).toBe(1);
    expect(a.questions.Q2.context_supply_entries).toBe(0);
    expect(a.health.statuses.Q2).not.toBe('pass');
  });

  it('fail-open：审计写入失败不阻断业务事件（DROP 表真实注入，非 mock）', async () => {
    // 真实故障注入：删掉溯源表，使 trackEntry 必然抛错。
    // 断言业务事件三件事照旧：①落 decision_event ②返回行对象 ③emit 广播送达。
    const d = await makeDecision(); // 决策行必须存在（decision_event.decision_id 有 FK）
    // 监听器在 makeDecision **之后**注册：createDecision 自身也会往 decision 域发 'made'（实测 seen=2 即由此而来），
    //   先注册会把建决策的事件算进「本次事件广播是否送达」的判据。
    const seen = [];
    const off = on('decision', (m) => { if (m.type === 'escalated') seen.push(m.summary || {}); });
    try {
      const base = (await query(`SELECT count(*)::int AS n FROM crm.decision_event WHERE event_type='escalated'`)).rows[0].n;
      await query(`DROP TABLE crm.decision_provenance`);
      const ev = await recordDecisionEvent('escalated', { decision_id: d.decision_id, scenario_id: 'LEAD_FOLLOW_UP' });
      expect(ev).toBeTruthy();
      expect(ev.event_type).toBe('escalated');
      const { rows } = await query(`SELECT count(*)::int AS n FROM crm.decision_event WHERE event_type='escalated'`);
      expect(rows[0].n).toBe(base + 1);
      expect(seen.length).toBe(1); // 广播必须送达——审计失败不影响业务可观测性
    } finally {
      off();
      await ensureProvenanceSchema(); // 立即重建，避免污染同文件后续用例
    }
  });
});
