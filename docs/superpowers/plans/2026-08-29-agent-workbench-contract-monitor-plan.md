# 智能体工作台契约消费侧 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `agent-workbench` 成为 4 个智能体的运行效果监控中心——解析设计契约、按 `contract_task_id` 关联运行期 episode、判定「是否调了声明的 SKILL / 读了声明的记忆·知识 / success 是否通过」三维度，并把非合规回写为 feedback（落库 + 镜像 `*.feedback.json`），供 `aggregate-feedback.mjs` 产出**需批准**的改进提案，形成闭环。

**Architecture:** 设计契约（contract-yaml 双轨）为单一事实源；运行期 `agentLoop` 把 `knowledge_layers_read` + `contract_task_id` 写入 `monitor_event`（先补 `agent_id`/`context_facts` 两列修复既有静默失败）；新模块 `contractMonitor.js` 复用 `validate-contract.mjs` 解析并按 task 标题（join key）关联 episode 做三维度判定；`feedbackStore.js` 负责落库 + 镜像；`routes.js` 暴露 `/api/agent-monitor*` 端点并增强 `agent-workbench` 渲染合规矩阵；`renderer.js` 新增 `contract-matrix` 组件。

**Tech Stack:** Node 22 ESM · PostgreSQL (`crm` schema) · vitest（测试库 `plm_test`）· 既有 `renderPage`/`validatePageSchema` 渲染链路。

**Join key 约定（重要）：** 设计契约的 `task` 标题字符串 = 运行期 `contract_task_id`。调度派发时 `scheduler` 把 `task.contract_task_id` 注入 `ctx.contractTask`；演示中 `contract_task_id` 即等于契约 `task` 标题。未来可加契约 `id` 字段硬化，本计划按已批准设计（§A 未含 `id`）保持 `task` 标题为关联键。

---

## File Structure

| 文件 | 动作 | 职责 |
|------|------|------|
| `db/migrate-monitor-event-agent.sql` | 新增 | 幂等补 `monitor_event.agent_id`/`context_facts` + 索引 |
| `db/schema.sql` | 修改 | `monitor_event` 建表加两列 + 索引（:300-308） |
| `src/agent/agentLoop.js` | 修改 | `buildContextBlock` 返回 `{block,bundle}`；episode 增 `knowledge_layers_read`+`contract_task_id` |
| `src/agent/contractMonitor.js` | 新增 | `parseContractsFromDoc` / `judgeContract`（纯）/ `computeCompliance` |
| `db/migrate-agent-contract-feedback.sql` | 新增 | 建 `agent_contract_feedback` 表（唯一约束 `(contract_task_id,gap_type)`） |
| `db/schema.sql` | 修改 | 追加 `agent_contract_feedback` 建表 |
| `src/agent/feedbackStore.js` | 新增 | `upsertFeedback`（落库）+ `mirrorFeedback`（镜像 `*.feedback.json`） |
| `src/page/renderer.js` | 修改 | 新增 `contract-matrix` 组件渲染 case |
| `src/pages/S03.schema.js` | 修改 | 增加 `contract-matrix` 组件 |
| `src/http/routes.js` | 修改 | 补 `queryWrite` 导入；加 3 个端点 + 增强 `agent-workbench` handler |
| `test/agent-loop-context.test.js` | 新增 | Task 1 测试 |
| `test/contract-monitor.test.js` | 新增 | Task 2 测试 |
| `test/feedback-store.test.js` | 新增 | Task 3 测试 |
| `test/renderer-contract-matrix.test.js` | 新增 | Task 4 测试 |
| `scripts/demo-contract-loop.mjs` | 新增 | Task 5 端到端闭环演示 |

**测试运行约定（沿用仓库）：** `C:/Users/wangchuan08/.workbuddy/binaries/node/versions/22.22.2/node.exe node_modules/vitest/vitest.mjs run <test>`。

---

### Task 1: 运行期埋点（补列 + 记录 knowledge_layers_read 与 contract_task_id）

**Files:**
- Create: `db/migrate-monitor-event-agent.sql`
- Modify: `db/schema.sql:300-308`
- Modify: `src/agent/agentLoop.js:22-46,48-71`
- Test: `test/agent-loop-context.test.js`

- [ ] **Step 1: 写失败测试（mock db + assembler，断言 episode 携带新字段）**

```js
// test/agent-loop-context.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fileURLToPath } from 'node:url';

const captured = [];
vi.mock('../../src/db.js', () => ({
  query: vi.fn(async () => ({ rows: [] })),
  queryWrite: vi.fn(async (sql, params) => { captured.push({ sql, params }); return { rows: [{}] }; }),
}));
vi.mock('../../src/context/assembler.js', () => ({
  assembleContext: vi.fn(async () => ({
    layers: { L1: [{ id: 'a' }], L2: [{ id: 'b' }] },
    missing: { L2: true },
    degraded: true,
  })),
}));
vi.mock('../../src/skills/registry.js', () => ({
  getSkill: () => ({ slug: 'data-particle-read', steps: [] }),
  executeSkill: vi.fn(async () => ({ ok: true })),
}));

const { runWithSkill } = await import('../../src/agent/agentLoop.js');

describe('agentLoop 埋点', () => {
  beforeEach(() => captured.length = 0);
  it('context-injected episode 含 knowledge_layers_read 与 contract_task_id', async () => {
    await runWithSkill(
      { id: 't1', skill_slug: 'data-particle-read', payload: {} },
      { ctx: { actor: 'deal-coach', contractTask: 'T-DEMO' } }
    );
    const ctxEp = captured.find((c) => String(c.sql).includes('INSERT INTO crm.monitor_event'));
    expect(ctxEp).toBeTruthy();
    const ctxFacts = JSON.parse(ctxEp.params[2]);
    expect(ctxFacts.knowledge_layers_read).toEqual(['L1']); // L2 missing 被排除
    expect(ctxFacts.contract_task_id).toBe('T-DEMO');
  });
  it('loop-started episode 含 contract_task_id', async () => {
    await runWithSkill(
      { id: 't1', skill_slug: 'data-particle-read', payload: {} },
      { ctx: { actor: 'deal-coach', contractTask: 'T-DEMO' } }
    );
    const startEp = captured.filter((c) => String(c.sql).includes('INSERT INTO crm.monitor_event'))
      .map((c) => JSON.parse(c.params[2]))
      .find((f) => f.skill === 'data-particle-read');
    expect(startEp.contract_task_id).toBe('T-DEMO');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `C:/Users/wangchuan08/.workbuddy/binaries/node/versions/22.22.2/node.exe node_modules/vitest/vitest.mjs run test/agent-loop-context.test.js`
Expected: FAIL（`knowledge_layers_read` 未定义 / `buildContextBlock` 返回字符串）。

- [ ] **Step 3: 写最小实现**

`db/migrate-monitor-event-agent.sql`：
```sql
-- 幂等补列：修复 agentEpisodes 因缺列静默失败（设计 §1.1）
ALTER TABLE crm.monitor_event ADD COLUMN IF NOT EXISTS agent_id text;
ALTER TABLE crm.monitor_event ADD COLUMN IF NOT EXISTS context_facts jsonb;
CREATE INDEX IF NOT EXISTS idx_crm_monitor_event_agent
  ON crm.monitor_event(agent_id, created_at);
```

`db/schema.sql` 修改 `:300-308` 为：
```sql
CREATE TABLE IF NOT EXISTS crm.monitor_event (
  id          BIGSERIAL PRIMARY KEY,
  domain      TEXT NOT NULL,
  event_type  TEXT,
  agent_id    TEXT,
  context_facts JSONB,
  decision_id UUID,
  scenario_id TEXT,
  payload     JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_monitor_event_domain_scen
  ON crm.monitor_event(domain, scenario_id, created_at);
CREATE INDEX IF NOT EXISTS idx_crm_monitor_event_agent
  ON crm.monitor_event(agent_id, created_at);
```

`src/agent/agentLoop.js` 修改：
```js
// buildContextBlock 返回 { block, bundle }（保留 bundle 供埋点使用）
export async function buildContextBlock(task, ctx) {
  const bundle = await assembleContext(
    { actor: ctx?.actor, intent: task?.payload?.intent || {}, query: task?.payload?.query || task?.payload?.staticParams?.query || '' }
  ).catch(() => ({ layers: {}, degraded: true, missing: {}, scopeModel: 'all' }));
  return { block: formatForPrompt(bundle), bundle };
}

export async function runWithSkill(task, opts = {}) {
  const { llmThink = null, onStep = null, ctx = { tenantId: 'system', actor: 'agent' } } = opts;
  const skillSlug = task.skill_slug || 'crm-skill-fallback';
  const skill = getSkill(skillSlug);
  if (!skill) throw new Error(`SKILL 不存在: ${skillSlug}`);

  const think = llmThink || (await getLlmThink().catch(() => null)) || defaultThink;
  const startedAt = Date.now();
  const { block: contextBlock, bundle } = await buildContextBlock(task, ctx).catch(() => ({ block: '', bundle: { layers: {}, missing: {} } }));
  const knowledgeLayersRead = Object.keys(bundle?.layers || {}).filter((l) => !bundle?.missing?.[l]);
  const ctId = ctx?.contractTask || null;
  emit('trace', 'agent-context-injected', { taskId: task.id, len: contextBlock.length });
  recordEpisode({
    agent_id: ctx?.actor || 'agent', phase: 'context-injected',
    context_facts: {
      context_len: contextBlock.length,
      preview: String(contextBlock).slice(0, 800),
      knowledge_layers_read: knowledgeLayersRead,
      contract_task_id: ctId,
    },
    payload: { taskId: task.id, len: contextBlock.length },
  }).catch(() => {});
  emit('trace', 'agent-loop-started', { taskId: task.id, skill: skillSlug });
  recordEpisode({
    agent_id: ctx?.actor || 'agent', phase: 'loop-started',
    context_facts: { skill: skillSlug, contract_task_id: ctId },
    payload: { taskId: task.id, skill: skillSlug },
  }).catch(() => {});

  try {
    const outcome = await executeSkill(skill, task, { llmThink: think, ctx });
    if (think === defaultThink) outcome.degraded = true;
    emit('trace', 'agent-loop-done', { taskId: task.id, skill: skillSlug, ms: Date.now() - startedAt, degraded: outcome.degraded });
    recordEpisode({
      agent_id: ctx?.actor || 'agent', phase: 'loop-done',
      context_facts: { skill: skillSlug, degraded: outcome.degraded, ms: Date.now() - startedAt, contract_task_id: ctId },
      payload: { taskId: task.id, degraded: outcome.degraded },
    }).catch(() => {});
    onStep?.({ type: 'done', outcome });
    return outcome;
  } catch (e) {
    emit('trace', 'agent-loop-failed', { taskId: task.id, skill: skillSlug, error: e.message });
    recordEpisode({
      agent_id: ctx?.actor || 'agent', phase: 'loop-failed',
      context_facts: { skill: skillSlug, error: e.message, contract_task_id: ctId },
      payload: { taskId: task.id, error: e.message },
    }).catch(() => {});
    throw e;
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `C:/Users/wangchuan08/.workbuddy/binaries/node/versions/22.22.2/node.exe node_modules/vitest/vitest.mjs run test/agent-loop-context.test.js`
Expected: PASS（2/2）。

- [ ] **Step 5: Commit**

```bash
git add db/migrate-monitor-event-agent.sql db/schema.sql src/agent/agentLoop.js test/agent-loop-context.test.js
git commit -m "feat(agent): record knowledge_layers_read + contract_task_id; fix monitor_event columns"
```

---

### Task 2: 契约解析与合规判定后端（contractMonitor.js）

**Files:**
- Create: `src/agent/contractMonitor.js`
- Test: `test/contract-monitor.test.js`

- [ ] **Step 1: 写失败测试**

```js
// test/contract-monitor.test.js
import { describe, it, expect, vi } from 'vitest';
import { fileURLToPath } from 'node:url';

const ROWS = [];
vi.mock('../src/db.js', () => ({
  query: vi.fn(async () => ({ rows: ROWS })),
  queryWrite: vi.fn(async () => ({ rows: [] })),
}));
// 注意：test/ 与 src/ 是同级的仓库根子目录，故 mock 路径为 ../src/...（非 ../../src/...）

const { parseContractsFromDoc, judgeContract, computeCompliance } = await import('../src/agent/contractMonitor.js');
const docFixture = fileURLToPath(new URL('./fixtures/contract-doc.md', import.meta.url));

describe('contractMonitor', () => {
  it('parseContractsFromDoc 复用 validate-contract 抽取契约', () => {
    const cs = parseContractsFromDoc(docFixture);
    expect(cs.length).toBe(1);
    expect(cs[0].agent).toBe('crm-copilot');
    expect(cs[0].skills).toContain('data-particle-read');
  });

  it('judgeContract: skill + memory 双合规', () => {
    const c = { task: 'T-DEMO', agent: 'crm-copilot', skills: ['data-particle-read'], knowledge_scope: { layers: ['L1'] } };
    const eps = [
      { phase: 'loop-started', context_facts: { skill: 'data-particle-read', contract_task_id: 'T-DEMO' } },
      { phase: 'context-injected', context_facts: { knowledge_layers_read: ['L1'], contract_task_id: 'T-DEMO' } },
    ];
    const r = judgeContract(c, eps);
    expect(r.skill_ok).toBe(true);
    expect(r.memory_ok).toBe(true);
    expect(r.success).toBe('pending');
  });

  it('judgeContract: 缺 layer → memory 不合规', () => {
    const c = { task: 'T-DEMO', agent: 'crm-copilot', skills: ['data-particle-read'], knowledge_scope: { layers: ['L1'] } };
    const eps = [
      { phase: 'loop-started', context_facts: { skill: 'data-particle-read', contract_task_id: 'T-DEMO' } },
      { phase: 'context-injected', context_facts: { knowledge_layers_read: [], contract_task_id: 'T-DEMO' } },
    ];
    expect(judgeContract(c, eps).memory_ok).toBe(false);
  });

  it('computeCompliance: 按 task 标题关联 episode', async () => {
    ROWS.length = 0;
    ROWS.push(
      { phase: 'loop-started', context_facts: { skill: 'data-particle-read', contract_task_id: 'T-DEMO' }, payload: {} },
      { phase: 'context-injected', context_facts: { knowledge_layers_read: ['L1'], contract_task_id: 'T-DEMO' }, payload: {} },
    );
    const matrix = await computeCompliance(docFixture);
    expect(matrix[0].skill_ok).toBe(true);
    expect(matrix[0].memory_ok).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `C:/Users/wangchuan08/.workbuddy/binaries/node/versions/22.22.2/node.exe node_modules/vitest/vitest.mjs run test/contract-monitor.test.js`
Expected: FAIL（`Cannot find module .../contractMonitor.js`）。

- [ ] **Step 3: 写最小实现**

`test/fixtures/contract-doc.md`（测试夹具）：
````md
# DEMO 契约

```contract-yaml
- task: "T-DEMO"
  agent: crm-copilot
  skills: [data-particle-read]
  memory: [crm-copilot]
  knowledge_scope: { layers: [L1] }
  success: "demo"
```
````

`src/agent/contractMonitor.js`：
```js
// src/agent/contractMonitor.js — 解析设计契约 + 按 contract_task_id 关联运行期 episode 做三维度判定
import { query } from '../db.js';
import { readFileSync } from 'node:fs';
import {
  extractContractBlocks,
  parseContractYaml,
} from '../../scripts/validate-contract.mjs';

// join key：契约 task 标题 ↔ episode context_facts.contract_task_id
const JOIN_KEY = 'task';

export function parseContractsFromDoc(docPath) {
  const md = readFileSync(docPath, 'utf8');
  return extractContractBlocks(md).flatMap((b) => parseContractYaml(b));
}

function asFacts(e) {
  const cf = e?.context_facts;
  if (!cf) return {};
  if (typeof cf === 'string') { try { return JSON.parse(cf); } catch { return {}; } }
  return cf;
}

// 纯函数：契约 + 该契约已采集 episodes → 三维度判定
export function judgeContract(contract, episodes = []) {
  const skillEps = episodes.filter((e) => ['loop-started', 'loop-done'].includes(e.phase));
  const skillOk = (contract.skills || []).every((s) =>
    skillEps.some((e) => asFacts(e).skill === s));
  const ctxEps = episodes.filter((e) => e.phase === 'context-injected');
  const readLayers = new Set(ctxEps.flatMap((e) => {
    const kl = asFacts(e).knowledge_layers_read;
    return Array.isArray(kl) ? kl : [];
  }));
  const required = (contract.knowledge_scope?.layers || []);
  const memoryOk = required.every((l) => readLayers.has(l));
  return {
    task: contract[JOIN_KEY],
    agent: contract.agent,
    skill_ok: skillOk,
    memory_ok: memoryOk,
    success: 'pending',
  };
}

export async function computeCompliance(docPath) {
  const contracts = parseContractsFromDoc(docPath);
  const res = await query(
    `SELECT event_type AS phase, context_facts, payload
     FROM crm.monitor_event
     WHERE domain='agent' AND context_facts->>'contract_task_id' IS NOT NULL`
  );
  const byTask = new Map();
  for (const r of res.rows) {
    const id = r.context_facts?.contract_task_id;
    if (!id) continue;
    if (!byTask.has(id)) byTask.set(id, []);
    byTask.get(id).push({ phase: r.phase, context_facts: r.context_facts, payload: r.payload });
  }
  return contracts.map((c) => judgeContract(c, byTask.get(c[JOIN_KEY]) || []));
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `C:/Users/wangchuan08/.workbuddy/binaries/node/versions/22.22.2/node.exe node_modules/vitest/vitest.mjs run test/contract-monitor.test.js`
Expected: PASS（4/4）。

- [ ] **Step 5: Commit**

```bash
git add src/agent/contractMonitor.js test/contract-monitor.test.js test/fixtures/contract-doc.md
git commit -m "feat(agent): contractMonitor parse + 3-dimension compliance judge"
```

---

### Task 3: Feedback 落库与回写（feedbackStore + 端点）

**Files:**
- Create: `db/migrate-agent-contract-feedback.sql`
- Modify: `db/schema.sql`（追加上表）
- Create: `src/agent/feedbackStore.js`
- Modify: `src/http/routes.js`（补 `queryWrite` 导入；加 3 端点）
- Test: `test/feedback-store.test.js`

- [ ] **Step 1: 写失败测试**

```js
// test/feedback-store.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const upserts = [];
vi.mock('../src/db.js', () => ({
  query: vi.fn(async () => ({ rows: [] })),
  queryWrite: vi.fn(async (sql, params) => { upserts.push({ sql, params }); return { rows: [{ id: 1 }] }; }),
}));
// 注意：test/ 与 src/ 同级，mock 路径为 ../src/...（非 ../../src/...）

const { upsertFeedback, mirrorFeedback } = await import('../src/agent/feedbackStore.js');
const tmp = mkdtempSync(join(tmpdir(), 'fb-'));
const docPath = join(tmp, 'demo-design.md');

describe('feedbackStore', () => {
  beforeEach(() => upserts.length = 0);
  it('upsertFeedback 按 (contract_task_id,gap_type) 幂等', async () => {
    await upsertFeedback({ contractTaskId: 'T-DEMO', agent: 'crm-copilot', gapType: 'skill', observed: 'none', expected: 'data-particle-read' });
    expect(String(upserts[0].sql)).toContain('ON CONFLICT (contract_task_id, gap_type)');
  });
  it('mirrorFeedback 追加到 <doc>.feedback.json', () => {
    const r1 = mirrorFeedback(docPath, { contractTaskId: 'T-DEMO', gapType: 'skill' });
    const r2 = mirrorFeedback(docPath, { contractTaskId: 'T-DEMO', gapType: 'skill' });
    expect(r1.ok && r2.ok).toBe(true);
    const arr = JSON.parse(require('node:fs').readFileSync(docPath.replace(/\.md$/, '.feedback.json'), 'utf8'));
    expect(arr.length).toBe(2);
    expect(arr[0].gapType).toBe('skill');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `C:/Users/wangchuan08/.workbuddy/binaries/node/versions/22.22.2/node.exe node_modules/vitest/vitest.mjs run test/feedback-store.test.js`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写最小实现**

`db/migrate-agent-contract-feedback.sql`：
```sql
CREATE TABLE IF NOT EXISTS crm.agent_contract_feedback (
  id               BIGSERIAL PRIMARY KEY,
  contract_task_id text NOT NULL,
  agent           text,
  gap_type        text NOT NULL,
  observed        text,
  expected        text,
  severity        text DEFAULT 'medium',
  ts              timestamptz DEFAULT now(),
  resolved        bool DEFAULT false,
  UNIQUE (contract_task_id, gap_type)
);
```

`db/schema.sql` 在 `monitor_event` 之后追加上表（复制上述 CREATE TABLE）。

`src/agent/feedbackStore.js`：
```js
// src/agent/feedbackStore.js — 非合规回写：落库（幂等 upsert）+ 镜像 <doc>.feedback.json
import { query, queryWrite } from '../db.js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

export async function upsertFeedback({ contractTaskId, agent, gapType, observed, expected, severity = 'medium' }) {
  const r = await queryWrite(
    `INSERT INTO crm.agent_contract_feedback
       (contract_task_id, agent, gap_type, observed, expected, severity)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (contract_task_id, gap_type)
     DO UPDATE SET observed=EXCLUDED.observed, expected=EXCLUDED.expected,
                   severity=EXCLUDED.severity, ts=now(), resolved=false
     RETURNING *`,
    [contractTaskId, agent, gapType, observed, expected, severity]
  );
  return r.rows[0];
}

export function mirrorFeedback(docPath, entry) {
  if (!docPath) return { ok: false, reason: 'no_doc' };
  const fpath = docPath.replace(/\.md$/, '.feedback.json');
  let arr = [];
  try {
    if (existsSync(fpath)) arr = JSON.parse(readFileSync(fpath, 'utf8'));
    if (!Array.isArray(arr)) arr = [];
  } catch { arr = []; }
  arr.push({ ...entry, ts: new Date().toISOString() });
  try { writeFileSync(fpath, JSON.stringify(arr, null, 2)); return { ok: true }; }
  catch (e) { return { ok: false, error: String(e) }; }
}

export async function markSuccess(contractTaskId, marked) {
  const r = await queryWrite(
    `INSERT INTO crm.agent_contract_feedback
       (contract_task_id, gap_type, observed, expected, severity)
     VALUES ($1,'success',$2,$3,'info')
     ON CONFLICT (contract_task_id, gap_type)
     DO UPDATE SET observed=EXCLUDED.observed, ts=now()
     RETURNING *`,
    [contractTaskId, marked ? 'pass' : 'fail', marked ? '人工标记通过' : '人工标记不通过']
  );
  return r.rows[0];
}
```

`src/http/routes.js` 修改：
1. 第 51 行导入改为 `import { query, queryWrite } from '../db.js';`
2. 在 `agent-workbench` 路由之后追加端点（注意 `fileURLToPath` 已自 line 3 导入）：
```js
const DEFAULT_CONTRACT_DOC = fileURLToPath(new URL('../../docs/specs/2026-08-29-agent-workbench-contract-monitor-design.md', import.meta.url));

app.get('/api/agent-monitor', async (req, res) => {
  try {
    const doc = req.query.doc || DEFAULT_CONTRACT_DOC;
    const matrix = await computeCompliance(doc);
    res.json({ ok: true, doc, matrix });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/agent-monitor/feedback', async (req, res) => {
  try {
    const { contractTaskId, agent, gapType, observed, expected, severity, doc } = req.body || {};
    const row = await upsertFeedback({ contractTaskId, agent, gapType, observed, expected, severity });
    const mirror = mirrorFeedback(doc, { contractTaskId, agent, gapType, observed, expected, severity });
    res.json({ ok: true, row, mirror });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/agent-monitor/success', async (req, res) => {
  try {
    const { contractTaskId, marked } = req.body || {};
    const row = await markSuccess(contractTaskId, marked);
    res.json({ ok: true, row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
```
并在 routes.js 顶部导入：`import { computeCompliance } from '../agent/contractMonitor.js';` `import { upsertFeedback, mirrorFeedback, markSuccess } from '../agent/feedbackStore.js';`

- [ ] **Step 4: 跑测试确认通过**

Run: `C:/Users/wangchuan08/.workbuddy/binaries/node/versions/22.22.2/node.exe node_modules/vitest/vitest.mjs run test/feedback-store.test.js`
Expected: PASS（2/2）。

- [ ] **Step 5: Commit**

```bash
git add db/migrate-agent-contract-feedback.sql db/schema.sql src/agent/feedbackStore.js src/http/routes.js test/feedback-store.test.js
git commit -m "feat(agent): feedback upsert + mirror + agent-monitor endpoints"
```

---

### Task 4: 工作台前端合规矩阵 + success 标记

**Files:**
- Modify: `src/page/renderer.js`（新增 `contract-matrix` case）
- Modify: `src/pages/S03.schema.js`（加组件）
- Modify: `src/http/routes.js`（增强 `agent-workbench` handler）
- Test: `test/renderer-contract-matrix.test.js`

- [ ] **Step 1: 写失败测试**

```js
// test/renderer-contract-matrix.test.js
import { describe, it, expect } from 'vitest';
import { renderPage } from '../src/page/renderer.js';
import { schema as S03 } from '../src/pages/S03.schema.js';

const rows = [
  { task: 'T-DEMO', agent: 'crm-copilot', skill_ok: true, memory_ok: true, success: 'pending' },
  { task: 'T-GAP', agent: 'crm-copilot', skill_ok: false, memory_ok: false, success: 'fail' },
];

describe('contract-matrix 渲染', () => {
  it('renderer 输出三列 + 标记按钮', () => {
    const { html } = renderPage(S03, { components: { 'contract-matrix': { rows } } });
    expect(html).toContain('SKILL');
    expect(html).toContain('记忆/知识');
    expect(html).toContain('T-DEMO');
    expect(html).toContain('T-GAP');
    expect(html).toContain('data-action="POST /api/agent-monitor/success"');
  });
  it('schema 含 contract-matrix 组件且校验通过', () => {
    expect(S03.components.some((c) => c.kind === 'contract-matrix')).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `C:/Users/wangchuan08/.workbuddy/binaries/node/versions/22.22.2/node.exe node_modules/vitest/vitest.mjs run test/renderer-contract-matrix.test.js`
Expected: FAIL（`未知组件 contract-matrix` / S03 无该组件）。

- [ ] **Step 3: 写最小实现**

`src/page/renderer.js` 新增函数与 case（在 `renderComponent` 的 switch 前定义 `renderContractMatrix`）：
```js
function renderContractMatrix(comp, data) {
  const rows = Array.isArray(data?.rows) ? data.rows : [];
  const title = comp.title ? `<h3 class="pg-comp-title">${escapeHtml(comp.title)}</h3>` : '';
  if (!rows.length) return `<div class="pg-contract-matrix">${title}${stateBlock('empty')}</div>`;
  const body = rows.map((r) => {
    const ok = (v) => (v ? '<span class="pg-ok">✓</span>' : '<span class="pg-bad">✗</span>');
    const succ = r.success === 'pass' ? '<span class="pg-ok">✓</span>'
      : r.success === 'fail' ? '<span class="pg-bad">✗</span>'
      : '<span class="pg-pending">—</span>';
    return `<tr><td>${escapeHtml(r.task || '')}</td><td>${escapeHtml(r.agent || '')}</td>`
      + `<td>${ok(r.skill_ok)}</td><td>${ok(r.memory_ok)}</td><td>${succ}</td>`
      + `<td><button data-action="POST /api/agent-monitor/success" data-contract-task-id="${escapeHtml(r.task || '')}">标记</button></td></tr>`;
  }).join('');
  return `<div class="pg-contract-matrix">${title}`
    + `<table class="pg-table"><thead><tr>`
    + `<th>任务</th><th>智能体</th><th>SKILL</th><th>记忆/知识</th><th>成功</th><th>操作</th>`
    + `</tr></thead><tbody>${body}</tbody></table></div>`;
}
```
并在 `renderComponent` switch 内加：`case 'contract-matrix': return renderContractMatrix(comp, data);`

`src/pages/S03.schema.js` 在 `components` 数组内（建议置于 `table` 组件之后）追加：
```js
{
  kind: 'contract-matrix',
  title: '契约合规矩阵',
  dataBinding: { source: 'contract', columns: ['task', 'agent', 'skill_ok', 'memory_ok', 'success', 'op'] },
},
```

`src/http/routes.js` 增强 `agent-workbench` handler（`routes.js:520-551` 内 `data` 组装处）注入矩阵：
```js
let matrixRows = [];
try { matrixRows = await computeCompliance(DEFAULT_CONTRACT_DOC); } catch {}
// 在 data.components 注入：
'contract-matrix': { rows: matrixRows },
```
（保留既有 `table`/`result-card` 等组件不变。）

- [ ] **Step 4: 跑测试确认通过**

Run: `C:/Users/wangchuan08/.workbuddy/binaries/node/versions/22.22.2/node.exe node_modules/vitest/vitest.mjs run test/renderer-contract-matrix.test.js`
Expected: PASS（2/2）。

- [ ] **Step 5: Commit**

```bash
git add src/page/renderer.js src/pages/S03.schema.js src/http/routes.js test/renderer-contract-matrix.test.js
git commit -m "feat(ui): agent-workbench contract-matrix + success mark"
```

---

### Task 5: 端到端闭环演示（无 DB 依赖）

**Files:**
- Create: `scripts/demo-contract-loop.mjs`

- [ ] **Step 1: 写演示脚本**

`scripts/demo-contract-loop.mjs`：
```js
// scripts/demo-contract-loop.mjs — 演示「生产侧契约 → 运行期埋点 → 消费侧判定 → 回写 → 改进提案」闭环
// 无 DB 依赖：用纯函数 judgeContract + 镜像 feedback.json + aggregate-feedback.mjs
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { judgeContract } from '../src/agent/contractMonitor.js';
import { mirrorFeedback } from '../src/agent/feedbackStore.js';
import { writeFileSync } from 'node:fs';

const tmp = mkdtempSync(join(tmpdir(), 'loop-'));
const docPath = join(tmp, 'demo-design.md');
writeFileSync(docPath, `# DEMO\n\n\`\`\`contract-yaml\n- task: "T-DEMO"\n  agent: crm-copilot\n  skills: [data-particle-read]\n  memory: [crm-copilot]\n  knowledge_scope: { layers: [L1] }\n  success: "demo"\n\`\`\`\n`);

// 1) 运行期 episode（由 agentLoop 写入，此处模拟）
const episodes = [
  { phase: 'loop-started', context_facts: { skill: 'data-particle-read', contract_task_id: 'T-DEMO' } },
  { phase: 'context-injected', context_facts: { knowledge_layers_read: ['L1'], contract_task_id: 'T-DEMO' } },
];
const contract = { task: 'T-DEMO', agent: 'crm-copilot', skills: ['data-particle-read'], knowledge_scope: { layers: ['L1'] } };
const r = judgeContract(contract, episodes);
console.log('[判定] skill_ok=%s memory_ok=%s success=%s', r.skill_ok, r.memory_ok, r.success);

// 2) 制造一次 skill 缺失 → 回写 feedback（复现 2 次以触发提案）
const gap = { contractTaskId: 'T-GAP', agent: 'crm-copilot', gapType: 'skill', observed: 'none', expected: 'data-particle-read', severity: 'high' };
mirrorFeedback(docPath, gap);
mirrorFeedback(docPath, gap);

// 3) aggregate-feedback.mjs 产出需批准提案
const node = process.execPath;
const out = execFileSync(node, ['scripts/aggregate-feedback.mjs', docPath.replace(/\.md$/, '.feedback.json')], { encoding: 'utf8' });
console.log('[闭环提案]\n' + out);
```

- [ ] **Step 2: 运行演示**

Run: `C:/Users/wangchuan08/.workbuddy/binaries/node/versions/22.22.2/node.exe scripts/demo-contract-loop.mjs`
Expected: 打印 `[判定] skill_ok=true memory_ok=true success=pending`，随后 `[闭环提案]` 含 `occurrences: 2` 与 `requiresApproval: true`。

- [ ] **Step 3: Commit**

```bash
git add scripts/demo-contract-loop.mjs
git commit -m "demo: agent-workbench contract closed-loop demonstration"
```

---

## Self-Review

**1. Spec coverage:**
- §1.1 缺列修复 → Task 1（迁移 + schema + episode 落库）。✓
- §3.2 埋点增强 → Task 1（`knowledge_layers_read` + `contract_task_id`）。✓
- §4 解析 + 判定 → Task 2（`parseContractsFromDoc`/`judgeContract`/`computeCompliance`）。✓
- §5 回写 → Task 3（`upsertFeedback` + `mirrorFeedback` + 端点）。✓
- §6 前端矩阵 + success 标记 → Task 4（renderer case + schema + handler + 端点）。✓
- §7 验收 → Task 5 演示脚本。✓
- §8 留白（resolved 收敛 / task 绑定键固化）→ 未做，符合"留白"定义。✓

**2. Placeholder scan:** 无 TBD/TODO；每个代码步均含完整实现；测试含真实断言；命令含预期输出。

**3. Type consistency:** `computeCompliance(docPath)` 全程一致；`judgeContract(contract, episodes)` 签名在 Task 2 测试/实现/Task 5 一致；`upsertFeedback({contractTaskId,agent,gapType,observed,expected,severity})` 与端点 body 解构一致；`mirrorFeedback(docPath, entry)` 与 demo 调用一致；`markSuccess(contractTaskId, marked)` 与端点一致。`renderContractMatrix(comp, data)` 取 `data.rows`。✓

**4. Join key 一致性：** Task 2/3/4/5 均按 `contract.task` 标题 = `contract_task_id` 关联，与设计 §4「按 context_facts.contract_task_id 关联」对齐（未引入新字段，保持已批准设计原貌）。✓
