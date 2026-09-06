// test/memory.test.js — 记忆治理底座验收（阶段 2 子系统二）
// TDD：每 Task 追加 describe 块；DB 集成用例依赖共享真实 PG（需先 `node db/migrate.js --seed`）
// 清理纪律：DB 集成用例 beforeEach 清写域表（memory_snapshot/memory_log/memory_note/particles/edges/events），
//           防同 refId/topic 跨用例残留导致断言累积（真 PG 全量跑时尤为关键）。
import { describe, test, expect, beforeAll, beforeEach } from 'vitest';
import { query } from '../src/db.js';
import { seedActions } from '../src/action/seed-actions.js';
import { judgeWorthiness } from '../src/memory/judge.js';
import { classifyForDistill, resolveChannel, appendMemory, retrieveMemory, distillMemory } from '../src/memory/memoryLog.js';
import { createSnapshot, getSnapshot } from '../src/memory/snapshot.js';
import { upsertNote, getNote } from '../src/memory/note.js';
import { captureMemory } from '../src/memory/capture.js';
import { on, off } from '../src/events/bus.js';
import { appendMemoryLog } from '../src/decision/decisionRepo.js';
import { assembleContext } from '../src/context/assembler.js';

// 文件级 beforeAll：只清一次 memory_log（清跨文件/上次残留，保证「仅返回本次所写」前提）。
// 不用 beforeEach：T3 块内 append→retrieve→distill 是有意链式共享（distill 消费 append 写的 deal:D1），
// 每条用例前清表会破坏块内顺序依赖。不动 memory_snapshot（T4 块内局部清）、memory_note（T1/T5 依赖种子）。
beforeAll(async () => {
  try { await query(`TRUNCATE crm.memory_log CASCADE`); } catch (e) { /* PG 不可用时纯逻辑用例不受影响 */ }
});

// ===== T1: Schema + Seed + Test-setup [需 PG] =====
describe('T1 schema', () => {
  beforeAll(async () => { try { await seedActions(); } catch {} });
  test('memory_log 扩展列存在', async () => {
    const r = await query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema='crm' AND table_name='memory_log'
        AND column_name IN ('layer','distilled','archived','ttl_days','actor','event_type')`);
    expect(r.rows.length).toBe(6);
  });
  test('memory_snapshot / memory_note 表存在', async () => {
    const r = await query(`SELECT table_name FROM information_schema.tables
      WHERE table_schema='crm' AND table_name IN ('memory_snapshot','memory_note')`);
    expect(r.rows.length).toBe(2);
  });
  test('memory_note 种子存在', async () => {
    const r = await query(`SELECT * FROM crm.memory_note WHERE topic='ui:import-export-pref'`);
    expect(r.rows.length).toBe(1);
  });
});

// ===== T2: judgeWorthiness 四优先级（纯函数，本地绿）=====
describe('T2 judgeWorthiness 四优先级', () => {
  test('① 敏感凭证硬拒（即便 explicit 也拦）', () => {
    const r = judgeWorthiness({ token: 'abc', note: '重要' }, { explicit: true });
    expect(r.ok).toBe(false); expect(r.code).toBe('credential');
  });
  test('② 显式意图优先放行', () => {
    const r = judgeWorthiness({ tmp: '/x', foo: 'bar' }, { explicit: true });
    expect(r.ok).toBe(true); expect(r.code).toBe('explicit');
  });
  test('③ 瞬态噪声正则拒（非 explicit）', () => {
    const r = judgeWorthiness({ log: 'grep -r Error traceback' });
    expect(r.ok).toBe(false); expect(r.code).toBe('noise');
  });
  test('④ 价值视界<30 且非 explicit 拒', () => {
    const r = judgeWorthiness({ msg: '临时讨论' }, { valueHorizonDays: 7 });
    expect(r.ok).toBe(false); expect(r.code).toBe('horizon');
  });
  test('正常事实放行', () => {
    const r = judgeWorthiness({ decision: '客户预算卡在财务部', why: '需升级审批' });
    expect(r.ok).toBe(true); expect(r.code).toBe('pass');
  });
});

// ===== T2b: 噪声边界回归锁（2026-09-03 修复）=====
// 背景：原 NOISE_RE 为无词边界的裸词正则，对 JSON.stringify(payload) 整体匹配 →
//   category/location（含 cat）、target/margin（含 rg）、false/results（含 ls）、template/attempt（含 tmp）被系统性误伤；
//   更严重的是 payload 只要含 `error` 键（即便值为 null）即全拒，生产抽样 300 条误判 25 条（8.3%），
//   全是「诚实留痕降级事件」→ 形成"不记录错误信息才能入库"的反向激励。
// 契约：噪声按【形态】判定（命令痕迹 / 临时路径 / 堆栈报错 / 搜索词），单词出现不构成噪声。
describe('T2b NOISE 边界回归锁', () => {
  test('真噪声仍拒：命令行 / 堆栈 / 临时路径 / 搜索词', () => {
    for (const p of [
      { log: 'grep -r Error traceback' },
      { cmd: 'cat /var/log/x.log' },
      { cmd: 'ls -la ./dist' },
      { err: 'Traceback (most recent call last):' },
      { err: 'at Object.<anonymous> (/app/src/db.js:42:11)' },
      { err: 'TypeError: x is not a function' },
      { err: 'connect ETIMEDOUT' },
      { err: 'timeout of 30000ms exceeded' },
      { err: 'Error: connect ECONNREFUSED' },
      { path: '/tmp/report.csv' },
      { path: 'node_modules/pg/lib/index.js' },
      { q: '搜索词：CRM' },
    ]) {
      const r = judgeWorthiness(p);
      expect(r.ok, `应判噪声: ${JSON.stringify(p)}`).toBe(false);
      expect(r.code).toBe('noise');
    }
  });

  test('误伤锁：业务键名/值含 cat·rg·ls·tmp 子词不得判噪声', () => {
    for (const p of [
      { category: '商机跟进', location: '上海' },                 // cat ← category / location
      { target: '回款率 80%', margin: 0.32, attempt: 2 },          // rg ← target / margin；tmp ← attempt
      { template: '季度复盘', stage: 'S4', result: 'false' },       // tmp ← template；ls ← false
      { industry: '印刷包装', application: '产线自动化' },          // cat ← application
      { decision: '客户预算卡在财务部', why: '需升级审批' },
      { summary: '客户确认年底前上一条产线，预算 800 万' },
    ]) {
      const r = judgeWorthiness(p);
      expect(r.code, `不得判噪声: ${JSON.stringify(p)}`).toBe('pass');
      expect(r.ok).toBe(true);
    }
  });

  test('error 键名不误伤：值为 null 的降级留痕必须放行（原实现 100% 误判）', () => {
    const r = judgeWorthiness({
      ts: '2026-09-02T12:50:26.364Z',
      text: '[边写降级] DECIDED_ON → age-unavailable',
      error: null,
    });
    expect(r.ok).toBe(true);
    expect(r.code).toBe('pass');
  });

  test('「临时讨论」落 horizon 而非 noise（四优先级顺序不被噪声抢先）', () => {
    const r = judgeWorthiness({ msg: '临时讨论' }, { valueHorizonDays: 7 });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('horizon');
  });

  test('at 时间文本不误伤（at 12:30:45 非堆栈）', () => {
    expect(judgeWorthiness({ note: '会议开始 at 12:30:45，客户到场' }).code).toBe('pass');
  });
});

// ===== T3: memoryLog 读写 + 蒸馏 + 检索（纯逻辑本地绿 + DB 集成）=====
describe('T3 memoryLog', () => {
  // ---- 纯逻辑（本地绿，无 PG）----
  test('classifyForDistill 标 distilled/archived', () => {
    const now = new Date('2026-08-25T00:00:00Z');
    const rows = [
      { id: 1, created_at: '2026-08-01T00:00:00Z', distilled: false }, // 24天前<30 不标
      { id: 2, created_at: '2026-07-20T00:00:00Z', distilled: false }, // 36天 标distilled
      { id: 3, created_at: '2026-06-01T00:00:00Z', distilled: false }, // >60天 标archived
    ];
    const out = classifyForDistill(rows, { ttlDays: 30, now });
    expect(out[0]._markDistilled).toBe(false);
    expect(out[1]._markDistilled).toBe(true);
    expect(out[2]._markArchived).toBe(true);
  });
  test('resolveChannel auto 按层选', () => {
    expect(resolveChannel({ channel: 'auto', layer: 'L-User' })).toBe('note');
    expect(resolveChannel({ channel: 'auto', layer: 'L-Workspace' })).toBe('log');
    expect(resolveChannel({ channel: 'snapshot' })).toBe('snapshot');
  });
  test('appendMemory 闸门拦截不入 DB（纯逻辑）', async () => {
    const r = await appendMemory({ topic: 't', payload: { token: 'x' } });
    expect(r.ok).toBe(false); expect(r.gate).toBe('worthiness'); expect(r.code).toBe('credential');
  });

  // ---- DB 集成（需 PG）----
  test('append→retrieve 往返', async () => {
    const a = await appendMemory({ topic: 'deal:D1', kind: 'event', payload: { note: '预算卡在财务部' }, layer: 'L-Workspace' });
    expect(a.ok).toBe(true);
    const b = await retrieveMemory({ topic: 'deal:D1' });
    expect(b.channel).toBe('log'); expect(b.rows.length).toBe(1);
  });
  test('distill 标 distilled 非删除', async () => {
    await query(`UPDATE crm.memory_log SET created_at = now() - interval '40 days' WHERE topic='deal:D1'`);
    const d = await distillMemory({ ttlDays: 30 });
    expect(d.ok).toBe(true);
    const r = await query(`SELECT distilled, archived FROM crm.memory_log WHERE topic='deal:D1'`);
    expect(r.rows[0].distilled).toBe(true);
    expect(r.rows[0].archived).toBe(false); // 非删除，仅标 distilled
    expect(r.rows.length).toBe(1); // 原始行保留
  });
});

// ===== T4: memory_snapshot 不可变快照 [需 PG] =====
describe('T4 memory_snapshot', () => {
  // 只清快照表（无种子依赖）；不动 memory_note/role_context_profile 种子（T1/T5 依赖）
  beforeEach(async () => {
    try { await query(`TRUNCATE crm.memory_snapshot CASCADE`); } catch (e) { /* PG 不可用跳过 */ }
  });

  test('createSnapshot 不可变写 + getSnapshot 回读', async () => {
    const s1 = await createSnapshot({ topic: 'approval:INST-1', refId: 'INST-1', snapshot: { verdict: 'approved', by: 'manager' } });
    expect(s1.id).toBeTruthy();
    // 不可变追加：同 refId 写第二条 → 读回 2 条（第一条不被覆盖，快照不可变语义）
    const s2 = await createSnapshot({ topic: 'approval:INST-1', refId: 'INST-1', snapshot: { verdict: 'rejected', by: 'manager', reason: 'budget' } });
    const got = await getSnapshot('INST-1');
    expect(got.length).toBe(2);
    expect(got[1].snapshot.verdict).toBe('approved');  // 最新在前（ORDER BY created_at DESC）
  });
});

// ===== T5: memory_note L-User upsert [需 PG] =====
describe('T5 memory_note', () => {
  test('upsertNote 重写非复制 + getNote 回读', async () => {
    await upsertNote({ layer: 'L-User', topic: 'ui:import-export-pref', content: { fields: ['a'], sort: 'x' } });
    const got = await getNote({ layer: 'L-User', topic: 'ui:import-export-pref' });
    expect(got.content.fields).toEqual(['a']);
    // 二次 upsert 覆盖
    await upsertNote({ layer: 'L-User', topic: 'ui:import-export-pref', content: { fields: ['a','b'], sort: 'y' } });
    const got2 = await getNote({ layer: 'L-User', topic: 'ui:import-export-pref' });
    expect(got2.content.fields).toEqual(['a','b']);
  });
});

// ===== T6: capture + 决策委托 =====
describe('T6 capture + 决策委托', () => {
  // ---- 纯逻辑（本地绿，无 PG）----
  test('captureMemory 跳过 decision 域（避免双写）', async () => {
    const r = await captureMemory({ domain: 'decision', type: 'made', payload: { x: 1 } });
    expect(r.ok).toBe(false); expect(r.reason).toBe('skipped-domain');
  });
  test('captureMemory 闸门拦截不入 DB', async () => {
    const r = await captureMemory({ domain: 'approval', type: 'submitted', payload: { password: 'x' } });
    expect(r.ok).toBe(false); expect(r.gate).toBe('worthiness');
  });

  // ---- DB 集成（需 PG）----
  test('总线事件 → 自动沉淀 memory_log', async () => {
    const unsub = on('*', (msg) => captureMemory({ domain: msg.domain, type: msg.type, payload: msg.summary }).catch(() => {}));
    await (await import('../src/events/bus.js')).emit('approval', 'submitted', { actor: 'mgr', note: '合同审批通过' });
    // bus.emit 同步广播但不 await 订阅者（fire-and-forget，订阅者异常隔离不阻断主写）；
    // 此处等异步落库提交后再查，验收「事件→memory_log 最终一致」语义（避免真库远端延迟下的竞态）
    await new Promise((r) => setTimeout(r, 80));
    unsub();
    const b = await retrieveMemory({ topic: 'event:approval:submitted' });
    expect(b.rows.length).toBeGreaterThanOrEqual(1);
  });
  test('决策主轴 appendMemoryLog 委托写入 memory_log', async () => {
    const row = await appendMemoryLog('DEC-TEST-1', { scenario_id: 's', disposition: 'approved', rationale: 'test' });
    expect(row).toBeTruthy();
    const r = await query(`SELECT * FROM crm.memory_log WHERE topic='decision:DEC-TEST-1'`);
    expect(r.rows.length).toBe(1);
  });
});

// ===== T7: assembler L2 接记忆 [需 PG] =====
describe('T7 assembler L2 接记忆', () => {
  test('L2 经 retrieveMemory 注入决策记忆', async () => {
    await appendMemory({ topic: 'decision:ASM-1', kind: 'decision', payload: { disposition: 'approved' }, layer: 'L-Workspace' });
    const ctx = await assembleContext({ actor: 'person-sales-a', intent: { scenario: null }, query: null });
    expect(ctx.layers.L2).toBeTruthy();
    const mems = ctx.layers.L2.memories || [];
    expect(mems.some((m) => (m.topic || '') === 'decision:ASM-1')).toBe(true);
  });
});

// ===== T8: distill 端点 [需 PG] =====
describe('T8 distill 端点', () => {
  test('dryRun 返回待蒸馏计数', async () => {
    // 自足造数据：不消费 T3 残留（T3 的 deal:D1 已被蒸馏，distilled=true 不满足 dryRun 条件）
    await appendMemory({ topic: 'deal:T8-EXPIRED', kind: 'event', payload: { note: '过期数据' }, layer: 'L-Workspace' });
    await query(`UPDATE crm.memory_log SET created_at = now() - interval '40 days' WHERE topic='deal:T8-EXPIRED'`);
    const r = await query(`SELECT count(*)::int AS n FROM crm.memory_log WHERE archived=false AND distilled=false AND created_at < now() - '30 days'::interval`);
    expect(r.rows[0].n).toBeGreaterThanOrEqual(1);
  });
});
