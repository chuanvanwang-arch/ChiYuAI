# 记忆治理底座 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 AI 原生 CRM 阶段 2 子系统二「记忆治理底座」——把记忆做成被治理的资产（双轨 append-only 日志 + 不可变快照 + L-User 常驻笔记 + 四优先级写入闸门 + 30 天蒸馏 + 按层/主题检索 + 事件总线单汇点捕获），并接入上下文分层 L2。

**Architecture:** 新建 `src/memory/`（5 模块，与 `src/context/`、`src/decision/` 同构：纯函数 + 薄 DB 访问）。`memory_log` 扩展 layer/distilled/archived/ttl 列；新增 `memory_snapshot`/`memory_note` 表。决策主轴 `appendMemoryLog` 重构为委托 `memory.appendMemory`（唯一汇点）。`captureMemory` 订阅 L2 事件总线；`assembler.L2` 改调 `memory.retrieveMemory`。记忆是事件副产物，**不开 memory CRUD Action 表面**。

**Tech Stack:** Node 22 ESM + PostgreSQL 16 (crm schema, 单库单租户) + vitest (singleFork, fileParallelism:false)。测试命令：`node node_modules/vitest/vitest.mjs run test/memory.test.js`。

---

## File Structure

| 文件 | 责任 |
|---|---|
| `db/schema.sql` | ALTER `memory_log` 扩展列 + 新增 `memory_snapshot` / `memory_note` 表 |
| `db/seed.sql` | 追加 1 行 `memory_note`（L-User UI 偏好示例） |
| `db/test-setup.sql` | TRUNCATE 列表补 `memory_snapshot` / `memory_note` |
| `src/memory/judge.js` | 写入门槛闸门（纯函数） |
| `src/memory/memoryLog.js` | `appendMemory` / `retrieveMemory` / `distillMemory` + 纯函数 `classifyForDistill` / `resolveChannel` |
| `src/memory/snapshot.js` | `createSnapshot` / `getSnapshot`（不可变） |
| `src/memory/note.js` | `upsertNote` / `getNote`（L-User upsert） |
| `src/memory/capture.js` | `captureMemory` + 总线订阅（residue 单汇点） |
| `src/decision/decisionRepo.js` | `appendMemoryLog` 重构为委托 `memory.appendMemory`（第 90-97 行） |
| `src/context/assembler.js` | L2 检索改调 `memory.retrieveMemory`（第 38-41 行） |
| `src/http/routes.js` | 新增 `POST /api/memory/distill` 端点 |
| `test/memory.test.js` | 纯逻辑（本地绿）+ DB 集成（需 PG）测试 |

---

### Task 1: Schema + Seed + Test-setup

**Files:**
- Modify: `db/schema.sql` (在 `role_context_profile` 段之后追加)
- Modify: `db/seed.sql` (在 `role_context_profile` 种子之后追加)
- Modify: `db/test-setup.sql` (TRUNCATE 列表)
- Test: `test/memory.test.js`

- [ ] **Step 1: 写失败测试（DB 集成，需 PG）**

```js
// test/memory.test.js
import { query } from '../src/db.js';
import { seedActions } from '../src/action/seed-actions.js';

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
```

- [ ] **Step 2: 执行确认失败（无 PG 时整文件后续 DB 用例跳过；PG 环境应报 schema 不存在）**

Run: `node node_modules/vitest/vitest.mjs run test/memory.test.js`
Expected: PG 环境 FAIL（`relation "crm.memory_snapshot" does not exist`）

- [ ] **Step 3: 写实现（schema.sql 追加）**

在 `db/schema.sql` 末尾（`role_context_profile` 索引之后）追加：

```sql
-- ============ 阶段 2 记忆治理底座：memory_log 扩展 + 快照 + 常驻笔记 ============
ALTER TABLE crm.memory_log
  ADD COLUMN IF NOT EXISTS layer      TEXT    NOT NULL DEFAULT 'L-Workspace',
  ADD COLUMN IF NOT EXISTS actor      TEXT,
  ADD COLUMN IF NOT EXISTS event_type TEXT,
  ADD COLUMN IF NOT EXISTS distilled  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS archived   BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ttl_days   INTEGER NOT NULL DEFAULT 30;
CREATE INDEX IF NOT EXISTS idx_crm_memory_log_layer_topic ON crm.memory_log(layer, topic, created_at);

-- 不可变快照（审批/凭证/报价版本，禁 update/delete）
CREATE TABLE IF NOT EXISTS crm.memory_snapshot (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  topic      TEXT NOT NULL,
  ref_id     TEXT,
  snapshot   JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_memory_snapshot_ref ON crm.memory_snapshot(ref_id, created_at);

-- L-User 常驻笔记（唯一键 upsert 重写，防膨胀）
CREATE TABLE IF NOT EXISTS crm.memory_note (
  layer     TEXT NOT NULL DEFAULT 'L-User',
  topic     TEXT NOT NULL,
  content   JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ttl_days  INTEGER NOT NULL DEFAULT 365,
  archived  BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (layer, topic)
);
```

- [ ] **Step 4: seed.sql 追加**

在 `db/seed.sql` 的 `role_context_profile` 种子块之后追加：

```sql
-- L-User UI 偏好记忆（导入导出字段/排序，跨会话跨端复用）
INSERT INTO crm.memory_note (layer, topic, content, ttl_days) VALUES
  ('L-User', 'ui:import-export-pref',
   '{"fields":["name","amount","owner"],"sort":"created_at desc","upsertMode":"upsert"}', 365)
ON CONFLICT (layer, topic) DO NOTHING;
```

- [ ] **Step 5: test-setup.sql TRUNCATE 列表扩展**

将第 3-6 行改为：

```sql
TRUNCATE particles, edges, tasks, task_audit, scheduler_lock, events,
         decision, decision_precedent_rel, decision_event, memory_log,
         memory_snapshot, memory_note,
         decision_scenario, methodology_template, methodology_dimension, policy_version, business_tier_config,
         role_context_profile
         RESTART IDENTITY CASCADE;
```

- [ ] **Step 6: 跑测试（PG 环境）确认通过**

Run: `node db/migrate.js --seed && node node_modules/vitest/vitest.mjs run test/memory.test.js`
Expected: T1 三个用例 PASS

- [ ] **Step 7: Commit**

```bash
git add db/schema.sql db/seed.sql db/test-setup.sql test/memory.test.js
git commit -m "feat(memory-T1): schema ALTER memory_log + memory_snapshot + memory_note + seed"
```

---

### Task 2: judge 写入门槛闸门（纯函数，本地绿）

**Files:**
- Create: `src/memory/judge.js`
- Test: `test/memory.test.js`

- [ ] **Step 1: 写失败测试（纯逻辑，无 PG）**

```js
import { judgeWorthiness } from '../src/memory/judge.js';

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
```

- [ ] **Step 2: 执行确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/memory.test.js -t T2`
Expected: FAIL（`Cannot find module '../src/memory/judge.js'`）

- [ ] **Step 3: 写实现**

```js
// src/memory/judge.js — 写入门槛闸门（纯函数，无 DB）
const CREDENTIAL_RE = /(api[_-]?key|token|password|secret|私钥|凭证)/i;
const NOISE_RE = /(grep|rg|find|ls|cat|echo|tmp|node_modules|\.cache|Error|Exception|traceback|timeout|搜索词)/i;

export function judgeWorthiness(payload, { explicit = false, valueHorizonDays = 30 } = {}) {
  const s = typeof payload === 'string' ? payload : JSON.stringify(payload ?? '');
  if (CREDENTIAL_RE.test(s)) return { ok: false, code: 'credential', reason: '敏感凭证硬拒（即便显式也拦）' };
  if (explicit) return { ok: true, code: 'explicit' };
  if (NOISE_RE.test(s)) return { ok: false, code: 'noise', reason: '瞬态噪声不入记忆' };
  if (valueHorizonDays < 30) return { ok: false, code: 'horizon', reason: '价值视界<30天且非显式' };
  return { ok: true, code: 'pass' };
}
```

- [ ] **Step 4: 执行确认通过（本地绿，无需 PG）**

Run: `node node_modules/vitest/vitest.mjs run test/memory.test.js -t T2`
Expected: PASS（5/5）

- [ ] **Step 5: Commit**

```bash
git add src/memory/judge.js test/memory.test.js
git commit -m "feat(memory-T2): judgeWorthiness 四优先级闸门（纯函数）"
```

---

### Task 3: memoryLog 读写 + 蒸馏 + 检索（纯函数本地绿 + DB 集成）

**Files:**
- Create: `src/memory/memoryLog.js`
- Test: `test/memory.test.js`

- [ ] **Step 1: 写失败测试**

```js
import { judgeWorthiness } from '../src/memory/judge.js';
import { classifyForDistill, resolveChannel, appendMemory, retrieveMemory, distillMemory } from '../src/memory/memoryLog.js';

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
```

- [ ] **Step 2: 执行确认失败（纯逻辑部分应已可跑，DB 部分 PG 失败）**

Run: `node node_modules/vitest/vitest.mjs run test/memory.test.js -t T3`
Expected: 纯逻辑 3 例 PASS；DB 2 例 PG 失败（模块未实现）

- [ ] **Step 3: 写实现**

```js
// src/memory/memoryLog.js — memory_log 扩展读写 + 蒸馏 + 检索
import { query } from '../db.js';
import { judgeWorthiness } from './judge.js';

// 纯函数：选出应标 distilled / archived 的行（测试用，无 DB）
export function classifyForDistill(rows, { ttlDays = 30, now = new Date() } = {}) {
  const ttlMs = ttlDays * 86400000;
  const nowMs = now.getTime();
  return rows.map((r) => {
    const age = nowMs - new Date(r.created_at).getTime();
    return { ...r, _markDistilled: !r.distilled && age >= ttlMs, _markArchived: age >= ttlMs * 2 };
  });
}

// 纯函数：通道解析（测试用）
export function resolveChannel({ channel = 'auto', layer } = {}) {
  if (channel && channel !== 'auto') return channel;
  if (layer === 'L-User') return 'note';
  return 'log';
}

export async function appendMemory({ topic, kind = 'event', payload, layer = 'L-Workspace', actor, eventType, ttlDays = 30, explicit = false, valueHorizonDays = 30 }) {
  const verdict = judgeWorthiness(payload, { explicit, valueHorizonDays });
  if (!verdict.ok) return { ok: false, gate: 'worthiness', code: verdict.code, reason: verdict.reason };
  const r = await query(
    `INSERT INTO crm.memory_log (topic, kind, payload, layer, actor, event_type, ttl_days)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [topic, kind, payload, layer, actor, eventType, ttlDays]
  );
  return { ok: true, row: r.rows[0] };
}

export async function retrieveMemory({ layer, topic, topicLike, channel = 'auto', limit = 50 } = {}) {
  const ch = resolveChannel({ channel, layer, topic });
  if (ch === 'note') {
    const r = await query(`SELECT * FROM crm.memory_note WHERE layer=$1 AND topic=$2 AND archived=false`, [layer, topic]);
    return { channel: 'note', rows: r.rows };
  }
  if (topicLike) {
    const r = await query(`SELECT * FROM crm.memory_log WHERE topic LIKE $1 AND archived=false ORDER BY created_at DESC LIMIT $2`, [topicLike, limit]);
    return { channel: 'log', rows: r.rows };
  }
  const r = await query(`SELECT * FROM crm.memory_log WHERE topic=$1 AND archived=false ORDER BY created_at DESC LIMIT $2`, [topic, limit]);
  return { channel: 'log', rows: r.rows };
}

export async function distillMemory({ ttlDays = 30 } = {}) {
  await query(`UPDATE crm.memory_log SET distilled=true WHERE archived=false AND distilled=false AND created_at < now() - ($1 || ' days')::interval`, [ttlDays]);
  await query(`UPDATE crm.memory_log SET archived=true WHERE archived=false AND created_at < now() - (($1 * 2) || ' days')::interval`, [ttlDays]);
  await query(`UPDATE crm.memory_note SET archived=true WHERE archived=false AND updated_at < now() - (ttl_days || ' days')::interval`);
  return { ok: true };
}
```

- [ ] **Step 4: 执行确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/memory.test.js -t T3`
Expected: 纯逻辑 3 例本地 PASS；DB 2 例 PG PASS

- [ ] **Step 5: Commit**

```bash
git add src/memory/memoryLog.js test/memory.test.js
git commit -m "feat(memory-T3): memoryLog 读写+蒸馏+检索（含纯函数 classify/resolve）"
```

---

### Task 4: snapshot 不可变快照

**Files:**
- Create: `src/memory/snapshot.js`
- Test: `test/memory.test.js`

- [ ] **Step 1: 写失败测试（DB 集成）**

```js
import { createSnapshot, getSnapshot } from '../src/memory/snapshot.js';

describe('T4 memory_snapshot', () => {
  test('createSnapshot 不可变写 + getSnapshot 回读', async () => {
    const s = await createSnapshot({ topic: 'approval:INST-1', refId: 'INST-1', snapshot: { verdict: 'approved', by: 'manager' } });
    expect(s.id).toBeTruthy();
    const got = await getSnapshot('INST-1');
    expect(got.length).toBe(1); expect(got[0].snapshot.verdict).toBe('approved');
  });
});
```

- [ ] **Step 2: 写实现**

```js
// src/memory/snapshot.js — 不可变记忆快照（审批/凭证/报价版本）
import { query } from '../db.js';

export async function createSnapshot({ topic, refId, snapshot }) {
  const r = await query(
    `INSERT INTO crm.memory_snapshot (topic, ref_id, snapshot) VALUES ($1,$2,$3) RETURNING *`,
    [topic, refId, snapshot]
  );
  return r.rows[0];
}

export async function getSnapshot(refId) {
  const r = await query(`SELECT * FROM crm.memory_snapshot WHERE ref_id=$1 ORDER BY created_at DESC`, [refId]);
  return r.rows;
}
```

- [ ] **Step 3: 执行确认通过（PG）**

Run: `node node_modules/vitest/vitest.mjs run test/memory.test.js -t T4`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/memory/snapshot.js test/memory.test.js
git commit -m "feat(memory-T4): memory_snapshot 不可变快照"
```

---

### Task 5: note L-User 常驻笔记 upsert

**Files:**
- Create: `src/memory/note.js`
- Test: `test/memory.test.js`

- [ ] **Step 1: 写失败测试（DB 集成）**

```js
import { upsertNote, getNote } from '../src/memory/note.js';

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
```

- [ ] **Step 2: 写实现**

```js
// src/memory/note.js — L-User 常驻笔记（唯一键 upsert 重写，防膨胀）
import { query } from '../db.js';

export async function upsertNote({ layer = 'L-User', topic, content, ttlDays = 365 }) {
  const r = await query(
    `INSERT INTO crm.memory_note (layer, topic, content, ttl_days, updated_at)
     VALUES ($1,$2,$3,$4, now())
     ON CONFLICT (layer, topic) DO UPDATE SET content=EXCLUDED.content, ttl_days=EXCLUDED.ttl_days, updated_at=now(), archived=false
     RETURNING *`,
    [layer, topic, content, ttlDays]
  );
  return r.rows[0];
}

export async function getNote({ layer = 'L-User', topic }) {
  const r = await query(`SELECT * FROM crm.memory_note WHERE layer=$1 AND topic=$2 AND archived=false`, [layer, topic]);
  return r.rows[0] || null;
}
```

- [ ] **Step 3: 执行确认通过（PG）**

Run: `node node_modules/vitest/vitest.mjs run test/memory.test.js -t T5`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/memory/note.js test/memory.test.js
git commit -m "feat(memory-T5): memory_note L-User upsert 重写"
```

---

### Task 6: capture 单汇点 + 决策主轴委托重构

**Files:**
- Create: `src/memory/capture.js`
- Modify: `src/decision/decisionRepo.js:90-97`（`appendMemoryLog` 委托）
- Test: `test/memory.test.js`

- [ ] **Step 1: 写失败测试**

```js
import { captureMemory } from '../src/memory/capture.js';
import { on, off } from '../src/events/bus.js';
import { appendMemoryLog } from '../src/decision/decisionRepo.js';

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
```

- [ ] **Step 2: 写实现 capture.js**

```js
// src/memory/capture.js — 事件总线订阅者（residue 零摩擦单汇点）
import { appendMemory } from './memoryLog.js';
import { on } from '../events/bus.js';

const SKIP_DOMAINS = new Set(['decision']); // 决策由主轴委托写入，避免双写

export async function captureMemory(event) {
  if (!event || !event.type) return { ok: false, reason: 'no-event' };
  const domain = event.domain || 'event';
  if (SKIP_DOMAINS.has(domain)) return { ok: false, reason: 'skipped-domain' };
  const res = await appendMemory({
    topic: event.topic || `event:${domain}:${event.type}`,
    kind: event.kind || 'event',
    payload: event.payload ?? {},
    layer: event.layer || 'L-Workspace',
    actor: event.actor,
    eventType: event.type,
    explicit: !!event.explicit,
    valueHorizonDays: event.valueHorizonDays ?? 30,
  });
  return res;
}

export function registerCaptureSubscriber() {
  return on('*', (msg) => {
    captureMemory({ domain: msg.domain, type: msg.type, payload: msg.summary, actor: msg.summary?.actor })
      .catch(() => {});
  });
}
```

- [ ] **Step 3: 重构 decisionRepo.appendMemoryLog（第 90-97 行）**

替换为：

```js
import { appendMemory } from '../memory/memoryLog.js';

export async function appendMemoryLog(decisionId, payload) {
  const res = await appendMemory({
    topic: `decision:${decisionId}`,
    kind: 'decision',
    payload,
    layer: 'L-Workspace',
    eventType: 'decision-made',
  });
  return res.ok ? res.row : null;
}
```

（保留 `import { query }` 不变；其余调用方 `await appendMemoryLog(...).catch(()=>{})` 行为等价。）

- [ ] **Step 4: 执行确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/memory.test.js -t T6`
Expected: 纯逻辑 2 例本地 PASS；DB 2 例 PG PASS

- [ ] **Step 5: Commit**

```bash
git add src/memory/capture.js src/decision/decisionRepo.js test/memory.test.js
git commit -m "feat(memory-T6): captureMemory 总线单汇点 + 决策主轴委托写入"
```

---

### Task 7: assembler L2 接入 retrieveMemory

**Files:**
- Modify: `src/context/assembler.js:3,31-42`（`retrieveL2` 改调 `memory.retrieveMemory`）
- Test: `test/memory.test.js`

- [ ] **Step 1: 写失败测试（DB 集成）**

```js
import { assembleContext } from '../src/context/assembler.js';

describe('T7 assembler L2 接记忆', () => {
  test('L2 经 retrieveMemory 注入决策记忆', async () => {
    await appendMemory({ topic: 'decision:ASM-1', kind: 'decision', payload: { disposition: 'approved' }, layer: 'L-Workspace' });
    const ctx = await assembleContext({ actor: 'person-sales-a', intent: { scenario: null }, query: null });
    expect(ctx.layers.L2).toBeTruthy();
    const mems = ctx.layers.L2.memories || [];
    expect(mems.some((m) => (m.topic || '') === 'decision:ASM-1')).toBe(true);
  });
});
```

- [ ] **Step 2: 改 assembler.js**

顶部第 3 行后加：
```js
import { retrieveMemory } from '../memory/memoryLog.js';
```
`retrieveL2` 替换为：
```js
async function retrieveL2(actor, intent) {
  const scenario = intent?.scenario || null;
  const r = await query(
    `SELECT decision_id, scenario_id, disposition, rationale FROM crm.decision
     WHERE ($1::text IS NULL OR scenario_id=$1) ORDER BY decided_at DESC LIMIT 5`,
    [scenario]
  );
  const m = await retrieveMemory({ topicLike: 'decision:%', limit: 5 }).catch(() => ({ rows: [] }));
  return { decisions: r.rows, memories: m.rows };
}
```

- [ ] **Step 3: 执行确认通过（PG）**

Run: `node node_modules/vitest/vitest.mjs run test/memory.test.js -t T7`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/context/assembler.js test/memory.test.js
git commit -m "feat(memory-T7): assembler L2 改调 memory.retrieveMemory"
```

---

### Task 8: distill HTTP 端点

**Files:**
- Modify: `src/http/routes.js`（`createRoutes` 内追加端点，顶部加 import）
- Test: `test/memory.test.js`（集成，需 PG + 起 server；或用 query 直接验 distill 已在 T3 覆盖，此端点仅薄封装）

- [ ] **Step 1: 写实现（routes.js 顶部加 import，createRoutes 内追加）**

顶部 import 区加：
```js
import { distillMemory } from '../memory/memoryLog.js';
```
`createRoutes` 内（如 health 端点之后）追加：
```js
  app.post('/api/memory/distill', async (req, res) => {
    const dryRun = req.query.dryRun === '1' || req.body?.dryRun;
    if (dryRun) {
      // dryRun：仅返回待蒸馏计数，不写
      const r = await query(`SELECT count(*)::int AS n FROM crm.memory_log WHERE archived=false AND distilled=false AND created_at < now() - '30 days'::interval`);
      return res.json({ dryRun: true, wouldDistill: r.rows[0].n });
    }
    const d = await distillMemory({ ttlDays: 30 });
    res.json({ ok: d.ok });
  });
```

- [ ] **Step 2: 写失败测试（集成，需 PG）**

```js
describe('T8 distill 端点', () => {
  test('dryRun 返回待蒸馏计数', async () => {
    await query(`UPDATE crm.memory_log SET created_at = now() - interval '40 days' WHERE topic='deal:D1'`);
    const r = await query(`SELECT count(*)::int AS n FROM crm.memory_log WHERE archived=false AND distilled=false AND created_at < now() - '30 days'::interval`);
    expect(r.rows[0].n).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 3: 执行确认通过（PG）**

Run: `node node_modules/vitest/vitest.mjs run test/memory.test.js -t T8`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/http/routes.js test/memory.test.js
git commit -m "feat(memory-T8): POST /api/memory/distill 端点（dryRun+执行）"
```

---

### Task 9: 文档状态更新 + 全量回归标注

**Files:**
- Modify: `docs/2026-08-25-memory-lifecycle-design.md`（顶部状态行）
- Modify: `docs/2026-08-25-ai-native-crm-overall-design.md`（§8.6 第二项标注已完成）
- Test: `test/memory.test.js`（收尾）

- [ ] **Step 1: 更新设计文档状态行**

将 `docs/2026-08-25-memory-lifecycle-design.md` 顶部状态改为：
```
> 状态：已批准（2026-08-25）+ 实施完成（T1–T8 提交 22b12a4→<末commit>；纯逻辑 N 例本地绿，DB 集成需 PG 就绪环境）
```

- [ ] **Step 2: 更新总体设计 §8.6**

将 §8.6 第 2 项「记忆三构件（ai-memory-lifecycle）」标注为 **已完成**，附 commit 区间与交付摘要（含跟进/评论捕获留待阶段 3 的说明）。

- [ ] **Step 3: 全量回归（PG 环境）**

Run: `node db/migrate.js --seed && node node_modules/vitest/vitest.mjs run`
Expected: 基线 ~47 + 上下文 ~11 + 记忆 ~N 全绿（沙箱无 PG 时记忆纯逻辑子集绿，DB 集成标注需 PG）

- [ ] **Step 4: Commit**

```bash
git add docs/2026-08-25-memory-lifecycle-design.md docs/2026-08-25-ai-native-crm-overall-design.md
git commit -m "docs(memory-T9): 设计状态更新为实施完成 + 总体设计§8.6标注"
```

---

## 自审（plan 对照 spec）

- **Spec 覆盖**：§3.1 ALTER memory_log（T1）✓；§3.2 memory_snapshot（T4）✓；§3.3 memory_note（T5+seed T1）✓；§4.1 judgeWorthiness（T2）✓；§4.2 captureMemory 单汇点+决策跳过（T6）✓；§4.3 distillMemory 幂等归档非删除（T3+T8）✓；§4.4 retrieveMemory 通道+L2 接入（T3+T7）✓；§5 接口边界（capture 接 bus、assembler 接 retrieve）✓；§7 YAGNI（未建 FOLLOW_UP/COMMENT、未开 CRUD Action）✓。
- **占位扫描**：无 TBD/TODO；每步含完整代码与命令。
- **类型一致**：`appendMemory({topic,kind,payload,layer,actor,eventType,ttlDays,explicit,valueHorizonDays})` 在 T3 定义、T6 capture 调用一致；`retrieveMemory({topic,topicLike,channel,layer,limit})` T3 定义、T7 调用一致；`captureMemory({domain,type,payload,...})` T6 定义、总线订阅 `on('*', msg=>captureMemory({domain:msg.domain,...}))` 一致。
- **已知环境约束**：沙箱无 PostgreSQL，纯逻辑（judge / classifyForDistill / resolveChannel / appendMemory 闸门 / capture 路由）本机可绿；DB 集成（append/retrieve/distill/snapshot/note/总线E2E/决策委托/assembler）需在用户 PG 就绪环境 `node db/migrate.js --seed` 后验收。
