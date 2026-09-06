// test/provenance-patrol.test.js — C2 审计链 T2：写时自检 verifyTail + 定时巡检 patrolChains + 封印比对
// 设计：docs/superpowers/plans/2026-09-03-c2c3c4-decision-integrity-implementation.md T2
//
// 锁死四类回归：
//   ① verifyTail O(1) 链尾自检的四态（EMPTY/OK/TAMPERED/BROKEN_HEAD）——写时自检是"写入即发现"的唯一通道。
//   ② patrolChains 篡改检出（tampered）——并锁死「事件域必须是 decision 而非 trace」：
//      trace 域不落 monitor_event（monitorSubscriber.js:32 只订阅 decision 域），
//      改错域 = 告警只进内存与 SSE，事后无法证明「曾经检出过篡改」，治理留痕断裂。
//   ③ 删链尾检出（head_lost）——**T2 的核心价值**：哈希链只能校验「存在的前后关系」，
//      删掉链尾后全链重算依旧自洽（本测试同步断言 verifyChain 仍返回 OK），纯哈希链永远检不出截尾，
//      必须靠 provenance_seal 封印的 entry_count 比对。此断言是防止封印逻辑被"优化掉"的唯一防线。
//   ④ 封印不被脏状态污染：TAMPERED 时不刷新 head/entry_count（否则基准被篡改后的值覆盖，删尾检出失效）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { query } from '../src/db.js';
import { on } from '../src/events/bus.js';
import { ensureMonitorSchema, registerMonitorSubscriber } from '../src/monitor/monitorSubscriber.js';
import {
  ensureProvenanceSchema, trackEntry, verifyChain, verifyTail, patrolChains,
} from '../src/decision/provenance.js';

// 注册 decision 域落库订阅（monitorSubscriber.js:32）——生产由 server 注册。
// 巡检告警能否进 monitor_event 完全取决于它，测试必须自己注册，否则「域写错」这类缺陷测不出来。
await ensureMonitorSchema();
registerMonitorSubscriber();

const DID = '33333333-3333-3333-3333-333333333333';

// 篡改场景模拟：本测试自建链（DID 固定），所有 UPDATE/DELETE 均带 decision_id 精确条件，
// 不涉及任何既有业务数据（与「绝对禁 DELETE 生产数据」铁律一致——此处删除的是本测试刚写入的行）。
const tailId = () => query(`SELECT max(id) AS id FROM crm.decision_provenance WHERE decision_id=$1`, [DID]);
const headId = () => query(`SELECT min(id) AS id FROM crm.decision_provenance WHERE decision_id=$1`, [DID]);

beforeEach(async () => {
  await ensureProvenanceSchema();
  await query(
    `TRUNCATE crm.decision, crm.decision_provenance, crm.decision_precedent_rel, crm.decision_event,
              crm.memory_log, crm.monitor_event, crm.provenance_seal RESTART IDENTITY CASCADE`
  );
  await query(
    `INSERT INTO crm.decision (decision_id, scenario_id, trigger_context, involved_entities, conditions_evaluated, disposition, decider_type, rationale, business_tier, state)
     VALUES ($1,'LEAD_FOLLOW_UP','{}','[]','[]','APPROVE','AUTONOMOUS_AGENT','patrol-test','NORMAL','CONFIRMED')`,
    [DID]
  );
});

async function seedChain(n = 3) {
  for (let i = 1; i <= n; i += 1) {
    await trackEntry({ decision_id: DID, entry_type: 'decision', payload: { seq: i }, source: 'agent' });
  }
}

function captureEvents(type) {
  const seen = [];
  const off = on('decision', (m) => { if (m.type === type) seen.push(m.summary || {}); });
  return { seen, off };
}

describe('T2 verifyTail（写时 O(1) 链尾自检）', () => {
  it('空链 → EMPTY', async () => {
    await expect(verifyTail({ decision_id: DID })).resolves.toMatchObject({ status: 'EMPTY', entries: 0 });
  });

  it('正常链 → OK 且 head 等于末条 checksum', async () => {
    await seedChain(3);
    const v = await verifyTail({ decision_id: DID });
    expect(v.status).toBe('OK');
    expect(v.entries).toBe(2);            // 只取链尾两条（O(1) 语义）
    expect(v.head).toBeTruthy();
  });

  it('篡改链尾 payload → TAMPERED', async () => {
    await seedChain(2);
    const { rows } = await tailId();
    await query(`UPDATE crm.decision_provenance SET payload='{"seq":99}'::jsonb WHERE id=$1`, [rows[0].id]);
    await expect(verifyTail({ decision_id: DID })).resolves.toMatchObject({ status: 'TAMPERED' });
  });

  it('删链头（剩 1 条）→ BROKEN_HEAD（首条 previous 非空）', async () => {
    await seedChain(2);
    const { rows } = await headId();
    await query(`DELETE FROM crm.decision_provenance WHERE id=$1`, [rows[0].id]);
    await expect(verifyTail({ decision_id: DID })).resolves.toMatchObject({ status: 'BROKEN_HEAD' });
  });

  it('删链头（剩多条）→ verifyTail 恒 OK，改由 patrolChains 检出 BROKEN_HEAD', async () => {
    // 两层分工取证（非缺陷）：verifyTail 是 O(1) 链尾自检，只看末两条，
    //   删链头不影响链尾自洽 → 它本就不该报；链的「头被砍」由全量巡检负责。
    await seedChain(3);
    const { rows } = await headId();
    await query(`DELETE FROM crm.decision_provenance WHERE id=$1`, [rows[0].id]);
    await expect(verifyTail({ decision_id: DID })).resolves.toMatchObject({ status: 'OK' });
    expect((await verifyChain({ decision_id: DID })).status).toBe('BROKEN_HEAD');
    // 巡检把 BROKEN_HEAD 归入 tampered 计数（head_lost 只用于封印比对出的截尾）
    const r = await patrolChains({ decisionIds: [DID] });
    expect(r.tampered).toBe(1);
    expect(r.head_lost).toBe(0);
  });
});

describe('T2 patrolChains（定时巡检 + 封印比对）', () => {
  it('首次巡检：全绿且建立封印基准', async () => {
    await seedChain(3);
    const r = await patrolChains({ decisionIds: [DID] });
    expect(r).toMatchObject({ scanned: 1, ok: 1, tampered: 0, forked: 0, head_lost: 0, sealed: 1 });
    const seal = (await query(`SELECT entry_count, head_checksum, last_status FROM crm.provenance_seal WHERE decision_id=$1`, [DID])).rows[0];
    expect(seal.entry_count).toBe(3);
    expect(seal.last_status).toBe('OK');
    expect(seal.head_checksum).toBeTruthy();
  });

  it('篡改 entry_type → tampered 且落 decision 域 monitor 事件（trace 域不落库）', async () => {
    await seedChain(3);
    await patrolChains({ decisionIds: [DID] });        // 先建基准
    const { rows } = await headId();
    await query(`UPDATE crm.decision_provenance SET entry_type='entity' WHERE id=$1`, [rows[0].id]);

    const cap = captureEvents('provenance-chain-violation');
    try {
      const r = await patrolChains({ decisionIds: [DID] });
      expect(r.tampered).toBe(1);
      expect(r.ok).toBe(0);
      // 事件域=decision → monitorSubscriber 落库；summary 带 decision_id 供回溯
      expect(cap.seen.length).toBe(1);
      expect(cap.seen[0]).toMatchObject({ decision_id: DID, status: 'TAMPERED' });
      const ev = (await query(
        `SELECT event_type FROM crm.monitor_event WHERE domain='decision' AND event_type='provenance-chain-violation' AND decision_id=$1`,
        [DID]
      )).rows;
      expect(ev.length).toBeGreaterThanOrEqual(1);   // 断言真的落库了（域错则此处为空）
    } finally {
      cap.off();
    }
  });

  it('删链尾 → head_lost（纯哈希链检不出，靠封印）', async () => {
    await seedChain(3);
    await patrolChains({ decisionIds: [DID] });        // 基准：entry_count=3
    const { rows } = await tailId();
    await query(`DELETE FROM crm.decision_provenance WHERE id=$1`, [rows[0].id]);

    // 反证：删尾后哈希链本身仍然自洽 —— 这正是「截尾不可检出」的固有盲区，也是本用例存在的理由
    expect((await verifyChain({ decision_id: DID })).status).toBe('OK');

    const r = await patrolChains({ decisionIds: [DID] });
    expect(r.head_lost).toBe(1);
    expect(r.tampered).toBe(0);
  });

  it('封印不被脏状态污染：TAMPERED 时不刷新 head/entry_count', async () => {
    await seedChain(3);
    await patrolChains({ decisionIds: [DID] });
    const before = (await query(`SELECT entry_count, head_checksum FROM crm.provenance_seal WHERE decision_id=$1`, [DID])).rows[0];

    const { rows } = await headId();
    await query(`UPDATE crm.decision_provenance SET entry_type='entity' WHERE id=$1`, [rows[0].id]);
    await patrolChains({ decisionIds: [DID] });
    const after = (await query(`SELECT entry_count, head_checksum, last_status FROM crm.provenance_seal WHERE decision_id=$1`, [DID])).rows[0];

    expect(after.entry_count).toBe(before.entry_count);     // 基准未被覆盖
    expect(after.head_checksum).toBe(before.head_checksum);
    expect(after.last_status).toBe('TAMPERED');             // 但结论被记录
  });

  it('并发分叉（同 previous 多条）→ forked', async () => {
    await seedChain(2);
    // 手工复制链尾：造成两条同 previous_checksum（trackEntry 无锁无 seq 的固有风险）
    const tail = (await query(
      `SELECT * FROM crm.decision_provenance WHERE decision_id=$1 ORDER BY id DESC LIMIT 1`, [DID]
    )).rows[0];
    await query(
      `INSERT INTO crm.decision_provenance (decision_id, entry_type, payload, source, activity_id, checksum, previous_checksum, hash_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [DID, tail.entry_type, JSON.stringify(tail.payload), tail.source, tail.activity_id,
        tail.checksum, tail.previous_checksum, tail.hash_version]
    );
    const r = await patrolChains({ decisionIds: [DID] });
    expect(r.forked).toBe(1);
  });
});
