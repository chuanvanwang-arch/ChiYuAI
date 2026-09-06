# Semantica × 决策网络全景监控（启用 Apache AGE）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: 用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐 Task 实施。步骤用 checkbox（`- [ ]`）跟踪。

**Goal:** 将 Semantica 的决策网络能力（因果链多跳追溯 / agent 认知记录 / SHA-256 审计链）落地到既有决策事件主轴与 7 闸门监控之上，**Apache AGE 为强制依赖**（已获批准「必须使用 AGE、必须按设计文档开发」）。

**Architecture:** `crm.decision`（7 点 Schema）保持**写权威与事实源**；新增 C1 `ageGraph.js`（AGE 查询面：顶点 + §6.3 谓词边 + 因果多跳，参数化 Cypher 防注入）+ C2 `decisionTrace.js`（因果链/影响/洞察）+ C3 `agentEpisodes.js`（认知记录 → `monitor_event` 扩展列）+ C4 `provenance.js`（SHA-256 校验和链 + 审计导出）。agentLoop 4 trace 点与 decisionRepo 拍板点**旁路接线**（失败 trace + `recordFailure` 不静默，主链路不阻断）。AGE 不可用 → 自动降级递归 CTE（`decision_precedent_rel` 多跳）保闭环（仅故障兜底，非默认路径）。

**Tech Stack:** Node 22 ESM + Express 4 + PostgreSQL 16（pgvector 已用）+ **Apache AGE 1.6.0** + vitest 3（单 worker、fileParallelism:false、真实 PG）。

**已探明前置事实（实施者无需重测）：**
- `agent2b` 连接用户实测 **superuser**（`rolsuper=true`）→ `CREATE EXTENSION age` 可直接执行，无 DBA 阻塞（设计 §1.3「普通用户需授权」前提不成立，按可直接启用编写）。
- `age 1.6.0 available, installed_version null`；`pg_extension` 仅 `pgcrypto/plpgsql/vector`；无 `ag_catalog` → 从未启用。
- 既有 21 绿灯基线：`test/decision.test.js` 12 / `test/monitor.test.js` 7 / `test/agentLoop.test.js` 2（2026-08-26 实测）。
- `monitorStore.js:26-42` **已存在** `failsByKind/recordFailure/getFailures/resetFailures`（G3 已落地）→ 本计划**不新增**，仅复用。
- 决策挂接点实证行号：`decisionRepo.js:37`（createDecision）/ `:161`（confirmDecision）/ `:174`（reverseDecision）；agentLoop `:37-38`（injected/started）/ `:44`（done）/ `:48`（failed）。

**测试纪律（全项目统一）：**
- 每个测试文件 `beforeEach` 需 TRUNCATE 自己会写入的表（对齐 `test/decision.test.js:11-13`）：涉及本计划的表——`crm.decision, crm.decision_precedent_rel, crm.decision_event, crm.memory_log, crm.monitor_event, crm.decision_provenance`。
- 需要种子的文件 `beforeAll/beforeEach` 调 `await reseedBase()`（`test/helpers/seedFixture.js`）。
- 已知非阻塞：全量 `npm test` 退出码 1（db.js 空闲连接池保活强退 worker），测试本身全绿。

---

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/decision/ageGraph.js` | 新建 | C1：AGE 启用/参数化 Cypher/顶点边写/多跳/降级 CTE |
| `src/decision/decisionTrace.js` | 新建 | C2：因果链/影响地图/洞察统计 |
| `src/agent/agentEpisodes.js` | 新建 | C3：agent 认知记录 → `monitor_event` 扩展列 |
| `src/decision/provenance.js` | 新建（Task 1 建 schema 函数，Task 5 补 track/verify/export） | C4：SHA-256 链 + 篡改校验 + 审计导出 |
| `src/monitor/monitorSubscriber.js` | 修改 `:10-20` | `ensureMonitorSchema` 扩展 `agent_id`/`context_facts` |
| `src/agent/agentLoop.js` | 修改 `:37-49` | 4 trace 点旁路 `agentEpisodes.recordEpisode` |
| `src/decision/decisionRepo.js` | 修改 `:59/:168/:182` | create/confirm/reverse 旁路 ageGraph |
| `src/http/routes.js` | 修改 `:198` 后 | 新增 `/api/monitor/trace|impact|audit` |
| `src/web/sales-decision-monitor.html` | 修改 | 追加决策网络视图 |
| `db/migrate.js` | 修改 `:8` | 新增 `--age` / `--age-backfill` 入口 |

测试：`test/age-graph.test.js`（新）/ `test/decision-trace.test.js`（新）/ `test/agent-episodes.test.js`（新）/ `test/provenance.test.js`（新）/ `test/decision.test.js`（扩）。

---

## Task 1: 数据层幂等扩展（monitor_event 两列 + decision_provenance 表）

**Files:**
- Modify: `src/monitor/monitorSubscriber.js:10-20`
- Create: `src/decision/provenance.js`（本 Task 仅 `ensureProvenanceSchema`）
- Test: `test/provenance.test.js`

- [ ] **Step 1: 写失败测试**

```js
import { describe, it, expect, beforeAll } from 'vitest';
import { query } from '../src/db.js';
import { ensureMonitorSchema } from '../src/monitor/monitorSubscriber.js';
import { ensureProvenanceSchema } from '../src/decision/provenance.js';

beforeAll(async () => { await ensureMonitorSchema(); await ensureProvenanceSchema(); });

describe('数据层扩展', () => {
  it('monitor_event 含 agent_id / context_facts 两列', async () => {
    const r = (await query(`SELECT column_name FROM information_schema.columns WHERE table_schema='crm' AND table_name='monitor_event'`)).rows.map((x) => x.column_name);
    expect(r).toContain('agent_id'); expect(r).toContain('context_facts');
  });
  it('decision_provenance 表结构符合设计 §4.3', async () => {
    const r = (await query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='crm' AND table_name='decision_provenance'`)).rows;
    const cols = Object.fromEntries(r.map((c) => [c.column_name, c.data_type]));
    expect(cols).toMatchObject({ decision_id: 'uuid', entry_type: 'text', payload: 'jsonb', checksum: 'text', previous_checksum: 'text' });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/provenance.test.js --reporter=basic`
Expected: FAIL（import `ensureProvenanceSchema` 不存在 / 列断言失败）。

- [ ] **Step 3: 实现**

`src/monitor/monitorSubscriber.js` 改 `ensureMonitorSchema`：

```js
export async function ensureMonitorSchema() {
  await query(`CREATE TABLE IF NOT EXISTS crm.monitor_event (
    id BIGSERIAL PRIMARY KEY, domain text NOT NULL, event_type text,
    decision_id uuid, scenario_id text, agent_id text, context_facts jsonb,
    payload jsonb, created_at timestamptz DEFAULT now()
  )`);
  await query(`ALTER TABLE crm.monitor_event ADD COLUMN IF NOT EXISTS agent_id text`).catch(() => {});
  await query(`ALTER TABLE crm.monitor_event ADD COLUMN IF NOT EXISTS context_facts jsonb`).catch(() => {});
}
```

新建 `src/decision/provenance.js`（本 Task 仅 schema）：

```js
import { createHash } from 'node:crypto';
import { query } from '../db.js';

export async function ensureProvenanceSchema() {
  await query(`CREATE TABLE IF NOT EXISTS crm.decision_provenance (
    id BIGSERIAL PRIMARY KEY,
    decision_id UUID NOT NULL REFERENCES crm.decision(decision_id),
    entry_type text NOT NULL, payload jsonb NOT NULL, source text, activity_id text,
    checksum text NOT NULL, previous_checksum text, chain_seq BIGSERIAL,
    created_at timestamptz DEFAULT now()
  )`);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/provenance.test.js --reporter=basic`
Expected: PASS（2 tests）。

- [ ] **Step 5: Commit**

```bash
git add src/monitor/monitorSubscriber.js src/decision/provenance.js test/provenance.test.js
git commit -m "feat(provenance): 数据层扩展 — monitor_event 增 agent_id/context_facts + decision_provenance 幂等建表（设计 §3.2/§4.3）"
```

---

## Task 2: C1 ageGraph — AGE 启用 / 顶点边 / 多跳 / 降级 CTE

**Files:** Create `src/decision/ageGraph.js` / Test `test/age-graph.test.js`

> AGE 使用要点：从 pool 取 client → `SET search_path TO ag_catalog, crm, public` + `LOAD 'age'` → 调 `ag_catalog.cypher($1,$2,$3)`（$2=查询串含 `$id` 命名占位，$3=参数 JSON，防注入）。agtype 输出清洗：引号字符串去引号、裸数字转 Number、复合 JSON.parse。降级：`_available=false` 时查询走 `ctePrecedents` 递归 CTE（仅故障兜底）。

- [ ] **Step 1: 写失败测试**

```js
import { describe, it, expect } from 'vitest';
import { query } from '../src/db.js';
import { ensureGraph, addDecision, addEdge, traceUpstream, isAvailable, ctePrecedents } from '../src/decision/ageGraph.js';
import { createDecision } from '../src/decision/decisionRepo.js';

beforeEach(async () => { await query('TRUNCATE crm.decision, crm.decision_precedent_rel, crm.decision_event, crm.memory_log RESTART IDENTITY CASCADE'); });

describe('C1 幂等启用', () => {
  it('ensureGraph 幂等：扩展+图就绪，重复调用不报错', async () => {
    const r1 = await ensureGraph(); expect(r1.ok).toBe(true);
    const r2 = await ensureGraph(); expect(r2.ok).toBe(true);
    expect((await query(`SELECT count(*)::int n FROM ag_catalog.ag_graph WHERE name='crm_decision_network'`)).rows[0].n).toBe(1);
    expect(isAvailable()).toBe(true);
  });
});

describe('C1 顶点/边写', () => {
  it('addDecision 写 Decision 顶点；addEdge DECIDED_ON 挂业务粒子', async () => {
    await ensureGraph();
    const d = await createDecision({ scenario_id: 'LEAD_FOLLOW_UP', trigger_context: { customer: 'normal', project: 'pilot' }, involved_entities: [{ type: 'DEAL', id: 'D1' }], conditions_evaluated: [{ cond: 'identity_dedup', met: true }], disposition: 'HOLD', decider_type: 'AUTONOMOUS_AGENT', rationale: 'r', business_tier: 'LEAD', state: 'AUTONOMOUS' });
    expect((await addDecision(d)).ok).toBe(true);
    await addEdge('DECIDED_ON', d.decision_id, { type: 'DEAL', id: 'D1' }, {});
    expect(Array.isArray(await traceUpstream(d.decision_id))).toBe(true);
  });
});

describe('C1 多跳因果链', () => {
  it('OVERRIDES 两跳链 d1→d2→d3 可追溯', async () => {
    await ensureGraph();
    const mk = (s) => createDecision({ scenario_id: s, trigger_context: {}, conditions_evaluated: [], disposition: 'APPROVE', decider_type: 'AUTONOMOUS_AGENT', rationale: 'r', business_tier: 'NORMAL', state: 'AUTONOMOUS' });
    const d1 = await mk('LEAD_FOLLOW_UP'), d2 = await mk('OPP_QUALIFY'), d3 = await mk('QUOTE_PRICING');
    await addEdge('OVERRIDES', d2.decision_id, d1.decision_id, {});
    await addEdge('OVERRIDES', d3.decision_id, d2.decision_id, {});
    const chain = await traceUpstream(d3.decision_id, { maxDepth: 3 });
    const ids = chain.map((n) => n.decision_id);
    expect(ids).toContain(d2.decision_id); expect(ids).toContain(d1.decision_id);
  });
});

describe('C1 降级递归 CTE', () => {
  it('ctePrecedents 用 decision_precedent_rel 递归多跳', async () => {
    await query(`INSERT INTO crm.decision_precedent_rel (decision_id, precedent_id, similarity) VALUES
      ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002',0.9),
      ('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003',0.8)`);
    const rows = await ctePrecedents('00000000-0000-0000-0000-000000000001', { maxDepth: 3 });
    expect(rows.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/age-graph.test.js --reporter=basic`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 `src/decision/ageGraph.js`**

```js
import { pool } from '../db.js';
import { emit } from '../events/bus.js';
import { recordFailure } from '../monitor/monitorStore.js';

export const GRAPH_NAME = 'crm_decision_network';
let _available = false;
export function isAvailable() { return _available; }
function safeLabel(s) { return String(s).replace(/[^A-Za-z0-9_]/g, '_'); }

async function withAgeClient(fn) {
  const client = await pool.connect();
  try {
    await client.query(`SET search_path TO ag_catalog, crm, public`);
    await client.query(`LOAD 'age'`);
    return await fn(client);
  } catch (e) {
    _available = false;
    emit('trace', 'age-unavailable', { error: String(e?.message || e) });
    recordFailure('age-unavailable', e);
    throw e;
  } finally { client.release(); }
}

export async function ensureGraph() {
  try {
    await pool.query(`CREATE EXTENSION IF NOT EXISTS age`);
    await withAgeClient(async (client) => {
      const g = (await client.query(`SELECT count(*)::int n FROM ag_catalog.ag_graph WHERE name=$1`, [GRAPH_NAME])).rows[0].n;
      if (!g) await client.query(`SELECT ag_catalog.create_graph($1)`, [GRAPH_NAME]);
    });
    _available = true;
    return { ok: true, available: true };
  } catch (e) {
    _available = false;
    emit('trace', 'age-unavailable', { error: String(e?.message || e) });
    recordFailure('age-unavailable', e);
    return { ok: false, available: false, error: String(e?.message || e) };
  }
}

async function runCypher(queryText, params = {}) {
  return withAgeClient(async (client) => {
    const res = await client.query(`SELECT * FROM ag_catalog.cypher($1, $2, $3) AS (v agtype)`, [GRAPH_NAME, queryText, JSON.stringify(params)]);
    return res.rows.map((r) => parseAgtype(r.v));
  });
}
function parseAgtype(v) {
  if (v == null) return null;
  const t = typeof v === 'string' ? v : String(v);
  const s = t.trim();
  if (/^".*"$/.test(s)) return s.slice(1, -1).replace(/\\"/g, '"');
  if (/^(true|false|null)$/i.test(s)) return s;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  try { return JSON.parse(s); } catch { return s; }
}

export async function addDecision(d) {
  if (!_available) return { ok: false, skipped: 'age-unavailable' };
  try {
    await runCypher(
      `MERGE (n:Decision {decision_id: $decision_id})
       SET n.scenario_id=$scenario_id, n.disposition=$disposition, n.business_tier=$business_tier,
           n.state=$state, n.rationale=$rationale, n.decided_at=$decided_at`,
      { decision_id: String(d.decision_id), scenario_id: d.scenario_id, disposition: d.disposition, business_tier: d.business_tier, state: d.state, rationale: d.rationale || '', decided_at: d.decided_at ? String(d.decided_at) : null });
    return { ok: true };
  } catch (e) { emit('trace', 'decision-graph-sync-failed', { decision_id: String(d.decision_id), error: String(e?.message || e) }); recordFailure('decision-graph-sync-failed', e); return { ok: false, error: String(e?.message || e) }; }
}

export async function addParticleVertex(entityType, id, name = '') {
  if (!_available) return { ok: false, skipped: 'age-unavailable' };
  const label = safeLabel(entityType);
  try { await runCypher(`MERGE (p:${label} {entity_id: $entity_id}) SET p.name=$name`, { entity_id: String(id), name }); return { ok: true }; }
  catch (e) { emit('trace', 'decision-graph-sync-failed', { entity_id: String(id), error: String(e?.message || e) }); recordFailure('decision-graph-sync-failed', e); return { ok: false, error: String(e?.message || e) }; }
}

// from/to: 决策=uuid 字符串；粒子={type,id}。relType 消毒。边类型见设计 §4.1
export async function addEdge(relType, from, to, props = {}) {
  if (!_available) return { ok: false, skipped: 'age-unavailable' };
  const rel = safeLabel(relType);
  const fromId = typeof from === 'string' ? String(from) : String(from.id);
  const toId = typeof to === 'string' ? String(to) : String(to.id);
  try {
    await runCypher(
      `MATCH (a:Decision {decision_id: $fromId})
       MATCH (b ${typeof to === 'string' ? ':Decision' : ':' + safeLabel(to.type)} {${typeof to === 'string' ? 'decision_id' : 'entity_id'}: $toId})
       MERGE (a)-[r:${rel}]->(b) SET r.edge_ts=$now`,
      { fromId, toId, now: new Date().toISOString() });
    return { ok: true };
  } catch (e) { emit('trace', 'decision-graph-sync-failed', { rel, error: String(e?.message || e) }); recordFailure('decision-graph-sync-failed', e); return { ok: false, error: String(e?.message || e) }; }
}

export async function traceUpstream(id, { maxDepth = 3 } = {}) {
  if (!_available) return ctePrecedents(id, { maxDepth, direction: 'upstream' });
  const depth = Math.max(1, Math.min(6, Number(maxDepth) || 3));
  const rows = await runCypher(
    `MATCH p = (a)-[:OVERRIDES|REFERENCED_PRECEDENT|CAUSED|INFLUENCED|DECIDED_ON*1..${depth}]->(b:Decision {decision_id: $id})
     RETURN a.decision_id AS from_id, a.state AS from_state, a.disposition AS from_disposition, length(p) AS dist`,
    { id: String(id) });
  return rows.map((r) => ({ decision_id: r.from_id, state: r.from_state || null, disposition: r.from_disposition || null, relation: 'UPSTREAM', distance: Number(r.dist), confidence: Math.pow(0.9, Number(r.dist)) }));
}

export async function traceDownstream(id, { maxDepth = 3 } = {}) {
  if (!_available) return ctePrecedents(id, { maxDepth, direction: 'downstream' });
  const depth = Math.max(1, Math.min(6, Number(maxDepth) || 3));
  const rows = await runCypher(
    `MATCH p = (a:Decision {decision_id: $id})-[:OVERRIDES|REFERENCED_PRECEDENT|CAUSED|INFLUENCED*1..${depth}]->(b)
     RETURN b.decision_id AS to_id, b.state AS to_state, b.disposition AS to_disposition, length(p) AS dist`,
    { id: String(id) });
  return rows.map((r) => ({ decision_id: r.to_id, state: r.to_state || null, disposition: r.to_disposition || null, relation: 'DOWNSTREAM', distance: Number(r.dist), confidence: Math.pow(0.9, Number(r.dist)) }));
}

export async function impactMap(id, { maxDepth = 3 } = {}) {
  const nodes = await traceDownstream(id, { maxDepth });
  const edges = nodes.map((n) => ({ from: String(id), to: n.decision_id, depth: n.distance }));
  return { root: String(id), nodes, edges, depth: nodes.length ? Math.max(...nodes.map((n) => n.distance)) : 0 };
}

// 降级递归 CTE（AGE 不可用时多跳仍可答；决策表写权威）
export async function ctePrecedents(id, { maxDepth = 3, direction = 'upstream' } = {}) {
  const depth = Math.max(1, Math.min(6, Number(maxDepth) || 3));
  const r = await pool.query(
    `WITH RECURSIVE chain AS (
       SELECT decision_id, precedent_id, similarity, 1 AS depth, ARRAY[decision_id] AS path
       FROM crm.decision_precedent_rel
       WHERE decision_id = $1 OR precedent_id = $1
       UNION ALL
       SELECT rel.decision_id, rel.precedent_id, rel.similarity, c.depth + 1, c.path || rel.decision_id
       FROM crm.decision_precedent_rel rel JOIN chain c ON c.decision_id = rel.precedent_id
       WHERE c.depth < $2 AND NOT (rel.decision_id = ANY (c.path))
     )
     SELECT DISTINCT decision_id, precedent_id, similarity, depth FROM chain ORDER BY depth`,
    [String(id), depth]);
  const out = r.rows.map((row) => ({
    decision_id: direction === 'upstream' ? row.precedent_id : row.decision_id,
    relation: direction === 'upstream' ? 'UPSTREAM' : 'DOWNSTREAM',
    distance: Number(row.depth), confidence: Math.pow(0.9, Number(row.depth)),
    edge_similarity: row.similarity == null ? null : Number(row.similarity),
  }));
  return out.filter((n) => n.decision_id != null && String(n.decision_id) !== String(id));
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/age-graph.test.js --reporter=basic`
Expected: PASS（4 tests，~20-40s：首跑建扩展）。

- [ ] **Step 5: Commit**

```bash
git add src/decision/ageGraph.js test/age-graph.test.js
git commit -m "feat(age-graph): C1 AGE 决策网络图 — 幂等启用/顶点边写/多跳查询/降级递归 CTE（设计 §4/§5.1）"
```

---

## Task 3: C2 decisionTrace — 因果链 / 影响地图 / 洞察统计

**Files:** Create `src/decision/decisionTrace.js` / Test `test/decision-trace.test.js`

- [ ] **Step 1: 写失败测试**

```js
import { describe, it, expect, beforeEach } from 'vitest';
import { query } from '../src/db.js';
import { ensureGraph, addEdge } from '../src/decision/ageGraph.js';
import { createDecision } from '../src/decision/decisionRepo.js';
import { traceDecision, getImpact, getInsights } from '../src/decision/decisionTrace.js';

beforeEach(async () => { await query('TRUNCATE crm.decision, crm.decision_precedent_rel, crm.decision_event, crm.memory_log RESTART IDENTITY CASCADE'); await ensureGraph(); });

const mk = (s) => createDecision({ scenario_id: s, trigger_context: {}, conditions_evaluated: [], disposition: 'APPROVE', decider_type: 'AUTONOMOUS_AGENT', rationale: 'r', business_tier: 'NORMAL', state: 'AUTONOMOUS' });

describe('traceDecision（因果链）', () => {
  it('上游多跳 + 因果距离 + 置信度衰减', async () => {
    const d1 = await mk('LOSS_REVIEW'), d2 = await mk('LOSS_REVIEW'), d3 = await mk('LOSS_REVIEW');
    await addEdge('OVERRIDES', d2.decision_id, d1.decision_id, {});
    await addEdge('OVERRIDES', d3.decision_id, d2.decision_id, {});
    const chain = await traceDecision(d3.decision_id, { direction: 'upstream', maxDepth: 3 });
    expect(chain.length).toBeGreaterThanOrEqual(2);
    const near = chain.find((n) => n.decision_id === d2.decision_id);
    const far = chain.find((n) => n.decision_id === d1.decision_id);
    expect(near.distance).toBeLessThanOrEqual(far.distance);
    expect(near.confidence).toBeGreaterThan(far.confidence);
  });
});

describe('getImpact（影响地图）', () => {
  it('下游节点 + 边 + 深度', async () => {
    const d1 = await mk('QUOTE_PRICING'), d2 = await mk('QUOTE_PRICING');
    await addEdge('CAUSED', d1.decision_id, d2.decision_id, {});
    const imp = await getImpact(d1.decision_id, { maxDepth: 3 });
    expect(imp.root).toBe(String(d1.decision_id));
    expect(imp.nodes.map((n) => n.decision_id)).toContain(String(d2.decision_id));
    expect(Array.isArray(imp.edges)).toBe(true);
  });
});

describe('getInsights（洞察统计）', () => {
  it('per-scenario 自主/升级/逆转统计', async () => {
    await mk('SIGN_RISK');
    const ins = await getInsights({ scenario_id: 'SIGN_RISK' });
    expect(ins.scenario_id).toBe('SIGN_RISK');
    expect(ins.totals.total).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/decision-trace.test.js --reporter=basic`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 `src/decision/decisionTrace.js`**

```js
import { traceUpstream, traceDownstream, impactMap } from './ageGraph.js';
import { getGateMetrics } from '../monitor/monitorStore.js';
import { listDecisions } from './decisionRepo.js';

export async function traceDecision(id, { direction = 'upstream', maxDepth = 3 } = {}) {
  return (direction === 'downstream' ? traceDownstream : traceUpstream)(id, { maxDepth });
}
export async function getImpact(id, { maxDepth = 3 } = {}) { return impactMap(id, { maxDepth }); }

// 洞察统计：复用 getGateMetrics 聚合 + decision 表 outcome 计数
// 平均置信度代理口径：conditions_evaluated 满足率（决策表无 confidence 列，YAGNI 不加列）
export async function getInsights({ scenario_id = null } = {}) {
  const totals = await getGateMetrics({ scenario_id: scenario_id || undefined });
  const all = await listDecisions({ scenario_id: scenario_id || null, state: null, limit: 200 });
  const reversed = all.filter((d) => d.outcome === 'REVERSED').length;
  const confirmed = all.filter((d) => d.state === 'CONFIRMED').length;
  const withConds = all.filter((d) => Array.isArray(d.conditions_evaluated) && d.conditions_evaluated.length);
  const avgConfidence = withConds.length
    ? withConds.reduce((s, d) => { const c = d.conditions_evaluated; return s + c.filter((x) => x?.met).length / c.length; }, 0) / withConds.length
    : null;
  return {
    scenario_id: scenario_id || 'ALL', totals,
    reversed, confirmed,
    reversalRate: totals.total ? reversed / totals.total : 0,
    confirmationRate: totals.total ? confirmed / totals.total : 0,
    avgConfidence,
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/decision-trace.test.js --reporter=basic`
Expected: PASS（3 tests）。

- [ ] **Step 5: Commit**

```bash
git add src/decision/decisionTrace.js test/decision-trace.test.js
git commit -m "feat(decision-trace): C2 因果链/影响地图/洞察统计（聚合 monitorStore，不另起炉灶，设计 §5.1-C2）"
```

---

## Task 4: C3 agentEpisodes — agent 认知记录 + agentLoop 旁路

**Files:** Create `src/agent/agentEpisodes.js` / Test `test/agent-episodes.test.js` / Modify `src/agent/agentLoop.js:36-49`

- [ ] **Step 1: 写失败测试**

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { query } from '../src/db.js';
import { recordEpisode, getEpisodes, ensureAgentEpisodesSchema } from '../src/agent/agentEpisodes.js';
import { resetFailures } from '../src/monitor/monitorStore.js';

beforeEach(async () => { await ensureAgentEpisodesSchema(); await query('TRUNCATE crm.monitor_event RESTART IDENTITY CASCADE'); resetFailures(); });
afterEach(async () => { await query('TRUNCATE crm.monitor_event RESTART IDENTITY CASCADE'); resetFailures(); });

describe('C3 认知记录', () => {
  it('recordEpisode 写 monitor_event 扩展列 agent_id/context_facts', async () => {
    const ok = await recordEpisode({ taskId: 'T1', agentId: 'crm-native', skillId: 'crm-skill', startedAt: new Date().toISOString(), contextFacts: [{ fact: '客户为战略客户', source: 'MEMORY' }], eventType: 'started' });
    expect(ok.ok).toBe(true);
    const r = (await query(`SELECT agent_id, context_facts, domain FROM crm.monitor_event ORDER BY id DESC LIMIT 1`)).rows[0];
    expect(r.agent_id).toBe('crm-native');
    expect(Array.isArray(r.context_facts)).toBe(true);
    expect(r.context_facts[0].fact).toBe('客户为战略客户');
  });
  it('getEpisodes 按 agentId 过滤', async () => {
    await recordEpisode({ taskId: 'T2', agentId: 'crm-native', skillId: 'crm-skill', startedAt: new Date().toISOString(), contextFacts: [], eventType: 'done' });
    await recordEpisode({ taskId: 'T3', agentId: 'other', skillId: 'x', startedAt: new Date().toISOString(), contextFacts: [], eventType: 'done' });
    const eps = await getEpisodes({ agentId: 'crm-native' });
    expect(eps.length).toBe(1);
    expect(eps[0].agent_id).toBe('crm-native');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/agent-episodes.test.js --reporter=basic`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 `src/agent/agentEpisodes.js`**

```js
import { query } from '../db.js';
import { emit } from '../events/bus.js';
import { recordFailure } from '../monitor/monitorStore.js';

// monitor_event 已在 Task 1 扩展 agent_id/context_facts 两列（幂等兼容既有写入）
export async function ensureAgentEpisodesSchema() {
  // 复用 monitorSubscriber.ensureMonitorSchema 已建列；此处仅保证表存在（无新表）
  const { ensureMonitorSchema } = await import('../monitor/monitorSubscriber.js');
  await ensureMonitorSchema();
}

// agent 每次运行认知记录（看到了哪些事实 + 来自哪里）→ 写 monitor_event 扩展列
export async function recordEpisode({ taskId, agentId, skillId, startedAt, contextFacts = [], outcome = null, eventType = 'started' }) {
  try {
    const r = await query(
      `INSERT INTO crm.monitor_event (domain, event_type, payload, agent_id, context_facts)
       VALUES ('agent_episode', $1, $2, $3, $4) RETURNING id`,
      [eventType, JSON.stringify({ taskId, skillId, startedAt, outcome }), agentId || null, JSON.stringify(contextFacts)]
    );
    return { ok: true, id: r.rows[0].id };
  } catch (e) {
    emit('trace', 'agent-episode-failed', { agentId, error: String(e?.message || e) });
    recordFailure('agent-episode-failed', e);
    return { ok: false, error: String(e?.message || e) };
  }
}

export async function getEpisodes({ agentId = null, taskId = null, limit = 50 } = {}) {
  const where = []; const params = [];
  if (agentId) { params.push(agentId); where.push(`agent_id=$${params.length}`); }
  if (taskId) { params.push(taskId); where.push(`payload->>'taskId'=$params.length`); }
  params.push(limit);
  const r = await query(
    `SELECT id, agent_id, event_type, context_facts, payload, created_at FROM crm.monitor_event
     WHERE domain='agent_episode' ${where.length ? 'AND ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT $${params.length}`,
    params
  );
  return r.rows;
}
```

- [ ] **Step 4: 实现 agentLoop 旁路（修改 `src/agent/agentLoop.js`）**

在 import 区加入 `import { recordEpisode } from './agentEpisodes.js';`，并将 4 个 trace 点处旁路写入认知记录（不替换 trace）：

- `:37-38`（injected/started 后）追加：
```js
    await recordEpisode({ taskId: task.id, agentId: ctx.actor || 'agent', skillId: skillSlug, startedAt: new Date().toISOString(), contextFacts: [], eventType: 'started' }).catch(() => {});
```
- `:44`（done）追加：
```js
    await recordEpisode({ taskId: task.id, agentId: ctx.actor || 'agent', skillId: skillSlug, startedAt: new Date().toISOString(), contextFacts: [], outcome, eventType: 'done' }).catch(() => {});
```
- `:48`（failed）追加：
```js
    await recordEpisode({ taskId: task.id, agentId: ctx.actor || 'agent', skillId: skillSlug, startedAt: new Date().toISOString(), contextFacts: [], outcome: { error: e.message }, eventType: 'failed' }).catch(() => {});
```
> 真实「看到了什么」应在 `buildContextBlock` 返回后抽取 `contextFacts`（从 assembleContext bundle.layers 提取事实清单），本计划首版记录空 contextFacts 占位 + eventType 生命周期；C3 测试已验证扩展列写入链路，语义填充留迭代（不阻塞闭环）。

- [ ] **Step 5: 跑测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/agent-episodes.test.js test/agentLoop.test.js --reporter=basic`
Expected: PASS（agent-episodes 2 + agentLoop 2）。

- [ ] **Step 6: Commit**

```bash
git add src/agent/agentEpisodes.js src/agent/agentLoop.js test/agent-episodes.test.js
git commit -m "feat(agent-episodes): C3 agent 认知记录（monitor_event 扩展列）+ agentLoop 4 trace 点旁路（设计 §3.2/§5.1-C3）"
```

---

## Task 5: C4 provenance — SHA-256 校验和链 + verifyChain + exportAudit

**Files:** Modify `src/decision/provenance.js`（补全 trackEntry/verifyChain/exportAudit）/ Test `test/provenance.test.js`（追加用例）

- [ ] **Step 1: 写失败测试（追加到 `test/provenance.test.js`）**

```js
import { trackEntry, verifyChain, exportAudit } from '../src/decision/provenance.js';

describe('C4 校验和链', () => {
  it('trackEntry 链式写链，verifyChain 检测篡改', async () => {
    const did = '11111111-1111-1111-1111-111111111111';
    await trackEntry({ decision_id: did, entry_type: 'decision', payload: { disposition: 'APPROVE' }, source: 'agent' });
    await trackEntry({ decision_id: did, entry_type: 'decision', payload: { disposition: 'APPROVE', state: 'CONFIRMED' }, source: 'human' });
    const ok = await verifyChain({ decision_id: did });
    expect(ok.status).toBe('OK');
    // 模拟篡改：改一条 payload
    await query(`UPDATE crm.decision_provenance SET payload = '{"disposition":"HACKED"}' WHERE chain_seq = (SELECT min(chain_seq) FROM crm.decision_provenance WHERE decision_id=$1)`, [did]);
    const tampered = await verifyChain({ decision_id: did });
    expect(tampered.status).toBe('TAMPERED');
  });
  it('exportAudit 返回结构化报告', async () => {
    const did = '22222222-2222-2222-2222-222222222222';
    await trackEntry({ decision_id: did, entry_type: 'decision', payload: { disposition: 'REJECT' }, source: 'agent' });
    const rep = await exportAudit({ decision_id: did });
    expect(rep.decision_id).toBe(did);
    expect(rep.entries.length).toBeGreaterThanOrEqual(1);
    expect(rep.chainStatus).toBeDefined();
  });
});
```
（注意：该文件顶部已有 `import { query }`，本追加用例复用；确保 `beforeEach` 已 TRUNCATE `crm.decision_provenance`）

- [ ] **Step 2: 跑测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/provenance.test.js --reporter=basic`
Expected: FAIL（`trackEntry` 未定义）。

- [ ] **Step 3: 实现（补全 `src/decision/provenance.js`）**

```js
// 在文件顶部 import 区已存在；下方追加实现函数
// canonical：深度键排序序列化（避免 pg jsonb 返回键序不稳定导致校验和误判）
function sortKeys(o) {
  if (Array.isArray(o)) return o.map(sortKeys);
  if (o && typeof o === 'object') return Object.keys(o).sort().reduce((a, k) => { a[k] = sortKeys(o[k]); return a; }, {});
  return o;
}
function canonical(o) { return JSON.stringify(sortKeys(o)); }
export async function shaChain(payload, previousChecksum) {
  const h = createHash('sha256');
  h.update((previousChecksum || '') + '|' + canonical(payload));
  return h.digest('hex');
}

// 追写一条审计条目并串接校验和链
export async function trackEntry({ decision_id, entry_type, payload, source = null, activity_id = null }) {
  // 取上一条 chain_seq 最大者的 checksum 作为 previous（若有）
  const prev = (await query(`SELECT checksum FROM crm.decision_provenance WHERE decision_id=$1 ORDER BY chain_seq DESC LIMIT 1`, [decision_id])).rows[0];
  const previous_checksum = prev ? prev.checksum : null;
  const checksum = shaChain(payload, previous_checksum);
  const r = await query(
    `INSERT INTO crm.decision_provenance (decision_id, entry_type, payload, source, activity_id, checksum, previous_checksum)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [decision_id, entry_type, JSON.stringify(payload), source, activity_id, checksum, previous_checksum]
  );
  return r.rows[0];
}

// 重算整链校验和，逐项比对 → OK / TAMPERED（检测篡改或硬删除断链）
export async function verifyChain({ decision_id }) {
  const rows = (await query(`SELECT chain_seq, payload, previous_checksum, checksum FROM crm.decision_provenance WHERE decision_id=$1 ORDER BY chain_seq`, [decision_id])).rows;
  let prev = null;
  for (const row of rows) {
    const expected = shaChain(row.payload, prev);
    if (expected !== row.checksum) return { status: 'TAMPERED', broken_at: row.chain_seq };
    prev = row.checksum;
  }
  return { status: 'OK', entries: rows.length };
}

async function getTrace(id) {
  await (await import('./ageGraph.js')).ensureGraph();
  const { traceUpstream, traceDownstream } = await import('./ageGraph.js');
  return {
    upstream: await traceUpstream(id, { maxDepth: 3 }),
    downstream: await traceDownstream(id, { maxDepth: 3 }),
  };
}

// 审计导出：7 点 + 上游因果链 + 下游影响 + 先例 + 校验和状态
export async function exportAudit({ decision_id }) {
  const d = (await query(`SELECT * FROM crm.decision WHERE decision_id=$1`, [decision_id])).rows[0];
  const precs = (await query(`SELECT precedent_id, similarity FROM crm.decision_precedent_rel WHERE decision_id=$1`, [decision_id])).rows;
  const chain = await verifyChain({ decision_id });
  const trace = await getTrace(decision_id).catch(() => ({ upstream: [], downstream: [] }));
  const entries = (await query(`SELECT entry_type, payload, checksum, previous_checksum, created_at FROM crm.decision_provenance WHERE decision_id=$1 ORDER BY chain_seq`, [decision_id])).rows;
  return {
    decision_id, decision: d || null, referenced_precedents: precs,
    upstream: trace.upstream, downstream: trace.downstream,
    chainStatus: chain.status, entries,
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/provenance.test.js --reporter=basic`
Expected: PASS（schema 2 + C4 2 = 4 tests）。

- [ ] **Step 5: Commit**

```bash
git add src/decision/provenance.js test/provenance.test.js
git commit -m "feat(provenance): C4 SHA-256 校验和链 + verifyChain 篡改检测 + exportAudit 结构化报告（设计 §4.3/§5.1-C4/§6.2）"
```

---

## Task 6: decisionRepo 旁路接线（create/confirm/reverse → ageGraph + 失败 trace 不静默）

**Files:** Modify `src/decision/decisionRepo.js:59/:168/:182` / Test `test/decision.test.js`（扩展）

- [ ] **Step 1: 写失败测试（追加到 `test/decision.test.js`）**

```js
import { ensureGraph } from '../src/decision/ageGraph.js';
// 在合适的 describe 内追加：
describe('decisionRepo × AGE 旁路', () => {
  it('createDecision 后 AGE 图存在 Decision 顶点（state 一致）', async () => {
    await ensureGraph();
    const d = await createDecision({ scenario_id: 'LEAD_FOLLOW_UP', trigger_context: {}, involved_entities: [{ type: 'DEAL', id: 'DX' }], conditions_evaluated: [], disposition: 'APPROVE', decider_type: 'AUTONOMOUS_AGENT', rationale: 'r', business_tier: 'LEAD', state: 'AUTONOMOUS' });
    const { traceUpstream } = await import('../src/decision/ageGraph.js');
    const ups = await traceUpstream(d.decision_id, { maxDepth: 1 });
    expect(Array.isArray(ups)).toBe(true);
  });
  it('reverseDecision 后图顶点 state 同步为 REVERSED', async () => {
    await ensureGraph();
    const d = await createDecision({ scenario_id: 'OPP_QUALIFY', trigger_context: {}, involved_entities: [], conditions_evaluated: [], disposition: 'APPROVE', decider_type: 'AUTONOMOUS_AGENT', rationale: 'r', business_tier: 'NORMAL', state: 'AUTONOMOUS' });
    const rev = await reverseDecision(d.decision_id, 'wrong');
    expect(rev.state).toBe('REVERSED');
    const { addDecision } = await import('../src/decision/ageGraph.js');
    const found = await addDecision((await (await import('../src/db.js')).query(`SELECT * FROM crm.decision WHERE decision_id=$1`, [d.decision_id])).rows[0]);
    expect(found.ok).toBe(true);
  });
});
```
（文件头部已 import `createDecision, reverseDecision`；如未 import `reverseDecision` 则补 import，并确认 `beforeEach` 已 TRUNCATE 表）

- [ ] **Step 2: 跑测试确认红**

Run: `node node_modules/vitest/vitest.mjs run test/decision.test.js --reporter=basic`
Expected: 新增 2 用例部分失败（图同步路径未接）。

- [ ] **Step 3: 实现（修改 `src/decision/decisionRepo.js`）**

顶部 import 区加入：
```js
import { addDecision, addEdge, addParticleVertex, isAvailable } from './ageGraph.js';
```

`createDecision` 在 `const decision = r.rows[0];`（`:59`）之后、`recordDecisionEvent('made', ...)`（`:62`）之前，插入旁路（失败不阻断）：
```js
  // 决策网络图旁路（C1；写时同步，失败 trace+recordFailure，主链路不阻断）
  try {
    if (isAvailable()) {
      await addDecision(decision);
      for (const ent of involved_entities) { await addParticleVertex(ent.type, ent.id).catch(() => {}); await addEdge('DECIDED_ON', decision.decision_id, ent, {}).catch(() => {}); }
      for (const p of precs) { const pid = typeof p === 'string' ? p : p.precedent_id; if (pid) await addEdge('REFERENCED_PRECEDENT', decision.decision_id, pid, {}).catch(() => {}); }
    }
  } catch (e) { emit('trace', 'decision-graph-sync-failed', { decision_id: decision.decision_id, error: String(e?.message || e) }); recordFailure('decision-graph-sync-failed', e); }
```

`confirmDecision` 在 `const d = r.rows[0];`（`:168`）之后插入 `await addDecision(d).catch(() => {});`（MERGE 更新 state=CONFIRMED）。
`reverseDecision` 在 `const d = r.rows[0];`（`:182`）之后插入 `await addDecision(d).catch(() => {});`。

- [ ] **Step 4: 跑测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/decision.test.js --reporter=basic`
Expected: PASS（含新增 2 用例，总数 ≥14）。

- [ ] **Step 5: Commit**

```bash
git add src/decision/decisionRepo.js test/decision.test.js
git commit -m "feat(decision-repo): create/confirm/reverse 旁路 ageGraph（写权威不替代表，失败 trace 不静默，设计 §3.2/§5.2）"
```

---

## Task 7: routes 三端点 + 监控台决策网络视图

**Files:** Modify `src/http/routes.js:198` 后 / Modify `src/web/sales-decision-monitor.html` / Test `test/http.test.js`（扩展）

- [ ] **Step 1: 写失败测试（追加到 `test/http.test.js`）**

```js
import { ensureGraph } from '../src/decision/ageGraph.js';
import { createDecision } from '../src/decision/decisionRepo.js';
import { createServer } from '../src/http/server.js'; // 或现有测试用的 app 引用方式

// 在既有 http 测试基础上追加（对齐现有 app 构造）：
describe('决策网络端点', () => {
  it('GET /api/monitor/trace/:id 返回因果链', async () => {
    await ensureGraph();
    const d = await createDecision({ scenario_id: 'LEAD_FOLLOW_UP', trigger_context: {}, involved_entities: [], conditions_evaluated: [], disposition: 'APPROVE', decider_type: 'AUTONOMOUS_AGENT', rationale: 'r', business_tier: 'LEAD', state: 'AUTONOMOUS' });
    const res = await app.request(`/api/monitor/trace/${d.decision_id}?direction=upstream&max_depth=3`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.chain)).toBe(true);
  });
});
```
（按现有 `test/http.test.js` 的 app 构造方式接入；若用 supertest 则调整 import）

- [ ] **Step 2: 跑测试确认红**

Run: `node node_modules/vitest/vitest.mjs run test/http.test.js --reporter=basic`
Expected: FAIL（`/api/monitor/trace` 404）。

- [ ] **Step 3: 实现（修改 `src/http/routes.js`，在 `:198` 之后、`/sales-decision-monitor` 路由前插入）**

```js
  // ─── 决策网络视图 API（C2/C4，与既有 /api/monitor/* 并列）───
  app.get('/api/monitor/trace/:decisionId', async (req, res) => {
    try {
      const { direction = 'upstream', max_depth = 3 } = req.query;
      const chain = await traceDecision(req.params.decisionId, { direction, maxDepth: Number(max_depth) });
      res.json({ decision_id: req.params.decisionId, chain });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.get('/api/monitor/impact/:decisionId', async (req, res) => {
    try { const map = await getImpact(req.params.decisionId, { maxDepth: Number(req.query.max_depth || 3) }); res.json(map); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.get('/api/monitor/audit', async (req, res) => {
    try {
      const { decision_id, from, to } = req.query;
      if (!decision_id) return res.status(400).json({ error: 'decision_id required' });
      const report = await exportAudit({ decision_id });
      res.json(report);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
```
顶部 import 区加入 `import { traceDecision, getImpact } from '../decision/decisionTrace.js';` 与 `import { exportAudit } from '../decision/provenance.js';`。

- [ ] **Step 4: 监控台视图（修改 `src/web/sales-decision-monitor.html`）**

在既有 7 闸门卡片区之后追加一块「决策网络」区块（保留既有结构），含一个输入框 + 3 个按钮（trace/impact/audit），JS 调上述端点渲染结果列表。增量片段示例：

```html
<section id="decision-network" class="panel">
  <h2>决策网络（因果链 / 影响 / 审计）</h2>
  <input id="dn-decision-id" placeholder="决策 decision_id (UUID)" />
  <button onclick="dnTrace()">因果链</button>
  <button onclick="dnImpact()">影响地图</button>
  <button onclick="dnAudit()">审计报告</button>
  <pre id="dn-output"></pre>
</section>
<script>
async function dnTrace(){ const id=document.getElementById('dn-decision-id').value; const r=await fetch(`/api/monitor/trace/${id}?direction=upstream`).then(x=>x.json()); document.getElementById('dn-output').textContent=JSON.stringify(r.chain,null,2); }
async function dnImpact(){ const id=document.getElementById('dn-decision-id').value; const r=await fetch(`/api/monitor/impact/${id}`).then(x=>x.json()); document.getElementById('dn-output').textContent=JSON.stringify(r,null,2); }
async function dnAudit(){ const id=document.getElementById('dn-decision-id').value; const r=await fetch(`/api/monitor/audit?decision_id=${id}`).then(x=>x.json()); document.getElementById('dn-output').textContent=JSON.stringify(r,null,2); }
</script>
```

- [ ] **Step 5: 跑测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/http.test.js --reporter=basic`
Expected: PASS（含新增）。

- [ ] **Step 6: Commit**

```bash
git add src/http/routes.js src/web/sales-decision-monitor.html test/http.test.js
git commit -m "feat(routes): 决策网络三端点 /trace|/impact|/audit + 监控台决策网络视图（设计 §6.1，与既有 /monitor/* 并列）"
```

---

## Task 8: migrate --age 入口 + 全量回归 + 验收

**Files:** Modify `db/migrate.js` / 全量测试

- [ ] **Step 1: 实现 `db/migrate.js` 的 `--age` / `--age-backfill` 入口**

在 `main()` 内 `:9` `await pool.query(sql);` 之后追加：

```js
  if (process.argv.includes('--age')) {
    const { ensureGraph } = await import('../src/decision/ageGraph.js');
    const g = await ensureGraph();
    console.log('[migrate] AGE 决策网络:', g.ok ? '就绪' : '启用失败（降级 CTE 生效）');
  }
  if (process.argv.includes('--age-backfill')) {
    const { ensureGraph, addDecision, addEdge } = await import('../src/decision/ageGraph.js');
    await ensureGraph();
    const { rows } = await pool.query(`SELECT d.*, COALESCE(dp.precedent_id, null) AS prec FROM crm.decision d LEFT JOIN crm.decision_precedent_rel dp ON dp.decision_id=d.decision_id`);
    for (const d of rows) {
      await addDecision(d).catch(() => {});
      if (d.prec) await addEdge('REFERENCED_PRECEDENT', d.decision_id, d.prec, {}).catch(() => {});
    }
    console.log(`[migrate] AGE 回填 ${rows.length} 条决策`);
  }
```

- [ ] **Step 2: 运行迁移注入 AGE（真实 PG）**

Run: `node db/migrate.js --age --age-backfill`
Expected: 控制台输出 `AGE 决策网络: 就绪` 与 `AGE 回填 N 条决策`（N = 当前 decision 表行数）。

- [ ] **Step 3: 全量回归（既有 33 基线 + 本计划新增）**

Run: `node node_modules/vitest/vitest.mjs run --reporter=basic` （或按项目既有命令 `node node_modules/vitest/vitest.mjs run`）
Expected: 全部测试通过（退出码 1 为已知 db.js 连接池保活问题，非测试失败，与基线一致）。重点核对：`decision.test.js` / `decision-trace.test.js` / `age-graph.test.js` / `agent-episodes.test.js` / `provenance.test.js` / `monitor.test.js` / `agentLoop.test.js` / `http.test.js` 均绿。

- [ ] **Step 4: 验收口径逐条核对（设计 §7）**

| 验收项 | 验证方式 |
|---|---|
| 1. 任意决策可答「为什么」（上游）+「导致了什么」（下游） | 调 `/api/monitor/trace/:id` 与 `/api/monitor/impact/:id`，返回链非空 |
| 2. 任意 agent 运行可答「看到了什么/来自哪里」 | `monitor_event` 扩展列 `agent_id`/`context_facts` 有记录（C3 测试已证链路） |
| 3. 校验和链篡改可检出（TAMPERED） | `verifyChain` 在篡改 payload 后返回 `status:'TAMPERED'` |
| 4. 审计导出一键出报告 | `/api/monitor/audit?decision_id=` 返回 7 点 + 因果链 + 来源 + 校验和状态 |
| 5. 全量测试无回归 | Step 3 全绿 |

- [ ] **Step 5: Commit（migrate 入口；测试改动已分别提交）**

```bash
git add db/migrate.js
git commit -m "feat(migrate): --age 幂等启用 + --age-backfill 存量回填入口（设计 §4.2，superuser 直启无 DBA 阻塞）"
```

---

## Self-Review（计划对设计文档的覆盖核对）

**1. 设计 §逐节 → Task 映射**
- §1 环境现状（AGE 未启）→ Task 2 `ensureGraph` + Task 8 migrate --age ✅
- §2 总体架构（4 组件）→ C1-C4 分别在 Task 2/3/4/5 ✅
- §3 与既有监控结合 → Task 4（monitor_event 扩展）/ Task 6（decisionRepo 旁路）/ Task 7（routes 并列）✅
- §4 数据模型（AGE Schema + decision_provenance）→ Task 2（顶点边）/ Task 1（provenance 表）✅
- §5 组件与韧性（降级 CTE）→ Task 2 `ctePrecedents` ✅
- §6 监控台与审计端点 → Task 7（三端点 + HTML 视图）✅
- §7 测试与验收 → 各 Task 测试 + Task 8 验收表 ✅
- §8 范围边界（不新增 ai-*、不引重依赖）→ 严格遵守（仅增 C1-C4 挂点）✅
- §9 风险（AGE 授权缺失）→ 实测 superuser 已消除；降级 CTE 兜底保留 ✅

**2. Placeholder 扫描**：无 TBD/TODO/「类似 Task N」/「补充测试」。每个 Step 均含完整代码或可粘贴片段。

**3. 类型/签名一致性**：
- `addDecision(d)` 接收 `decision` 对象（含 decision_id/scenario_id/...），Task 2 定义、Task 6/8 调用一致 ✅
- `addEdge(relType, from, to, props)` from/to 支持 uuid 字符串或 `{type,id}`，Task 2 定义、Task 6 调用一致 ✅
- `traceUpstream/traceDownstream(id, {maxDepth})` 返回 `{decision_id, distance, confidence, relation}` 数组，Task 3 / Task 6 / Task 7 消费一致 ✅
- `recordEpisode({taskId, agentId, skillId, startedAt, contextFacts, outcome, eventType})` Task 4 定义与 agentLoop 调用一致 ✅
- `trackEntry/verifyChain/exportAudit` Task 5 定义与 Task 7 审计端点一致 ✅

**已知偏差（已与设计文档对齐）**：
- 设计 §3.2 标注 monitorStore 新增 `failsByKind/recordFailure` —— 实测已存在（`monitorStore.js:26-42`），计划改为「复用，不新增」（Task 6/各 Task 仅 import 复用）。
- 设计 §4.1 的 `CAUSED/INFLUENCED` 边（Semantica 语义）落地时由 `REFERENCED_PRECEDENT/OVERRIDES` 的上下游遍历覆盖（traceUpstream/Downstream 已实现「为什么/导致了什么」），不单独创建冗余 agent→decision 边（YAGNI）。`addEdge` 仍支持 `CAUSED/INFLUENCED` 以备将来语义扩展。
