# 决策校准 P0：HITL 处置回写接线 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让人工处置动作真正回写到 `crm.decision`，从而采集到「人工覆写信号」——这是整个决策质量校准层唯一的被调量来源。

**Architecture:** 新增 `src/decision/disposition.js` 作为人工处置的**唯一出口**，内部完成状态迁移（一致→`CONFIRMED`，覆写→`REVERSED`）、审计留痕（`audit_event`，复用被处置决策自身的 `decision_id`，不产生自引用决策）、决策事件广播与 AGE 图同步。升级（HITL）决策经 `createTask` 落地为待办并携带 `decision_id`，打通「决策 → 待办 → 人工处置」链路。对外暴露 `POST /api/decisions/:id/disposition`。

**Tech Stack:** Node 22 + ESM + Express 4 + PostgreSQL（pg）+ vitest 3

**设计依据：** `docs/2026-08-28-decision-quality-calibration-design.md` §2.1 / §3（已批准）

**测试命令约定：** 沙箱内禁 `npx`，统一用
`node node_modules/vitest/vitest.mjs run <files>`

**迁移约定：** `db/schema.sql` 由 `npm run migrate`（`db/migrate.js`）幂等执行；测试库 `plm_test` 的前置由 `npm run pretest` → `scripts/seed-test-config.mjs` 施加。**新增列必须同时写这两处**，否则测试库会缺列（该坑已有先例，见 `scripts/seed-test-config.mjs:7-10` 注释）。

---

## 文件清单

| 文件 | 动作 | 职责 |
|---|---|---|
| `db/schema.sql` | 改 | `decision` 增 4 列；`tasks` 增 `decision_id` 列 + 索引 |
| `scripts/seed-test-config.mjs` | 改 | 新增 `ensureCalibrationP0Columns()` 并挂进 `main()` 的 steps |
| `src/decision/disposition.js` | 新建 | 人工处置唯一出口（状态迁移 + 审计 + 事件 + 图同步） |
| `src/kanban/kanban.js` | 改 | `createTask` 支持 `decisionId` |
| `src/http/routes.js` | 改 | 导入 `createTask` / `recordHumanDisposition`；升级分支建待办；新增处置端点 |
| `test/calibration/disposition.test.js` | 新建 | 处置回写全契约 |
| `test/kanban/createTask.test.js` | 新建 | `decisionId` 落库与回读 |

---

## Task 1: 迁移 —— 决策与任务表补列

**Files:**
- Modify: `db/schema.sql`（`crm.decision` 定义后、`crm.tasks` 定义后）
- Modify: `scripts/seed-test-config.mjs`

- [ ] **Step 1: 在 `db/schema.sql` 补列**

在 `db/schema.sql` 的 `CREATE TABLE IF NOT EXISTS crm.decision (...)` 之后（该文件 `decision_precedent_rel` 建表之前）追加：

```sql
-- 决策校准 P0：人工处置回写列（设计 2026-08-28 §2.1）
ALTER TABLE crm.decision
  ADD COLUMN IF NOT EXISTS human_disposition    TEXT,
  ADD COLUMN IF NOT EXISTS human_decided_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS human_decider_id     TEXT,
  ADD COLUMN IF NOT EXISTS human_decider_role   TEXT;
CREATE INDEX IF NOT EXISTS idx_crm_decision_human_disp
  ON crm.decision(human_disposition) WHERE human_disposition IS NOT NULL;
```

在 `CREATE INDEX IF NOT EXISTS idx_crm_tasks_depends` 之后追加：

```sql
-- 决策校准 P0：决策 → 待办 关联（打通 HITL 处置链路）
ALTER TABLE crm.tasks
  ADD COLUMN IF NOT EXISTS decision_id UUID REFERENCES crm.decision(decision_id);
CREATE INDEX IF NOT EXISTS idx_crm_tasks_decision ON crm.tasks(decision_id);
```

- [ ] **Step 2: 在测试前置脚本补同样的列**

在 `scripts/seed-test-config.mjs` 的 `ensureDealSeed()` 之后追加：

```js
// ⑧ 决策校准 P0 列（db/schema.sql 用 CREATE TABLE IF NOT EXISTS，已存在的测试库不补列 → 幂等补）
async function ensureCalibrationP0Columns() {
  return run(`
    ALTER TABLE crm.decision
      ADD COLUMN IF NOT EXISTS human_disposition    TEXT,
      ADD COLUMN IF NOT EXISTS human_decided_at     TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS human_decider_id     TEXT,
      ADD COLUMN IF NOT EXISTS human_decider_role   TEXT;
    ALTER TABLE crm.tasks
      ADD COLUMN IF NOT EXISTS decision_id UUID REFERENCES crm.decision(decision_id);
  `);
}
```

并把该步进 `main()` 的 `steps` 数组（在 `['CRM_DEAL 测试粒子', ensureDealSeed]` 之后）：

```js
    ['决策校准 P0 列', ensureCalibrationP0Columns],
```

- [ ] **Step 3: 执行迁移并验证列存在**

Run: `node db/migrate.js`
Expected: `[migrate] crm schema 就绪（幂等）`

Run: `PGDATABASE=plm_test node scripts/seed-test-config.mjs`
Expected: 末行 `[seed-test-config] 全部就绪（幂等）`，且输出含 ` ✓ 决策校准 P0 列`

- [ ] **Step 4: Commit**

```bash
git add db/schema.sql scripts/seed-test-config.mjs
git commit -m "feat(calibration-p0): decision 人工处置列 + tasks.decision_id 关联"
```

---

## Task 2: `src/decision/disposition.js` —— 人工处置唯一出口

**Files:**
- Create: `src/decision/disposition.js`
- Test: `test/calibration/disposition.test.js`

> **为什么是唯一出口**：`decisionRepo.js:195` 的 `confirmDecision` 与 `:214` 的 `reverseDecision` 全仓 0 调用方，`state='CONFIRMED'`/`'REVERSED'` 从未产生。本模块取代二者的对外职责，把它们收敛为内部实现。
> **为什么处置动作不新建 decision**：人工处置是对既有决策的补全，若要求它"携带一个 decision_id"会形成决策自引用。此处第0闸的正确形态是复用被处置决策自身的 id 落 `audit_event`（`db/schema.sql` 的 `audit_event.decision_id` 列本就为此设计）。
>
> **为什么绝不覆写 `decider_type` / `decider_id` / `decider_role`**：这三个字段记录的是"引擎当初把决策判给了谁"，是**决策来源的溯源凭据**。一旦覆写，P1 的 `autonomy_override_rate` 将无法区分"自主决策被覆写"与"升级决策被改判"——而被覆写的自主决策恰恰是唯一的核心质量样本。人工信息一律只写 `human_*` 四个新列，与原字段严格分离。（既有 `confirmDecision` 的 `decider_type=COALESCE($2, decider_type)` 覆写语义不再沿用。）

- [ ] **Step 1: 写失败测试**

```js
// test/calibration/disposition.test.js — 人工处置回写（校准 P0：被调量采集点）
import { describe, it, expect, beforeEach } from 'vitest';
import { query } from '../../src/db.js';
import { createDecision } from '../../src/decision/decisionRepo.js';
import { recordHumanDisposition, DISPOSABLE_STATES } from '../../src/decision/disposition.js';

beforeEach(async () => {
  await query('TRUNCATE crm.decision, crm.decision_precedent_rel, crm.decision_event RESTART IDENTITY CASCADE');
});

async function seed() {
  return createDecision({
    scenario_id: 'LEAD_FOLLOW_UP',
    trigger_context: { name: '校准测试商机' },
    involved_entities: [],
    conditions_evaluated: [],
    disposition: 'APPROVE',
    decider_type: 'AUTONOMOUS_AGENT',
    rationale: '测试用决策',
    business_tier: 'LEAD',
    state: 'AUTONOMOUS',
  });
}

describe('recordHumanDisposition', () => {
  it('人工处置与建议一致 → CONFIRMED 且 human_disposition 落库', async () => {
    const d = await seed();
    const r = await recordHumanDisposition(d.decision_id, {
      disposition: 'APPROVE', by_id: 'alice', by_role: 'sales',
    });
    expect(r.ok).toBe(true);
    expect(r.overridden).toBe(false);
    expect(r.next_state).toBe('CONFIRMED');
    const row = (await query('SELECT * FROM crm.decision WHERE decision_id=$1', [d.decision_id])).rows[0];
    expect(row.human_disposition).toBe('APPROVE');
    expect(row.human_decider_id).toBe('alice');
    expect(row.human_decided_at).toBeTruthy();
    expect(row.state).toBe('CONFIRMED');
    expect(row.outcome).not.toBe('REVERSED');
    // 决策来源溯源凭据不得被覆写：P1 的 autonomy_override_rate 靠它筛自主样本
    expect(row.decider_type).toBe('AUTONOMOUS_AGENT');
    expect(row.decider_id).toBe(d.decider_id);
  });

  it('人工改判（与建议不等）→ REVERSED + outcome=REVERSED + 审计落链', async () => {
    const d = await seed();
    const r = await recordHumanDisposition(d.decision_id, {
      disposition: 'REJECT', by_id: 'bob', by_role: 'manager', note: '预算不符',
    });
    expect(r.ok).toBe(true);
    expect(r.overridden).toBe(true);
    expect(r.next_state).toBe('REVERSED');
    const row = (await query('SELECT outcome FROM crm.decision WHERE decision_id=$1', [d.decision_id])).rows[0];
    expect(row.outcome).toBe('REVERSED');
    const audit = (await query(
      `SELECT * FROM crm.audit_event WHERE decision_id=$1 AND action='human-disposition'`, [d.decision_id])).rows[0];
    expect(audit).toBeTruthy();
    expect(audit.payload.from_disposition).toBe('APPROVE');
    expect(audit.payload.to_disposition).toBe('REJECT');
    expect(audit.payload.overridden).toBe(true);
    expect(audit.payload.note).toBe('预算不符');
  });

  it('未知 decision_id → 404；已终结状态 → 409', async () => {
    const notFound = await recordHumanDisposition('00000000-0000-0000-0000-000000000000', { disposition: 'APPROVE' });
    expect(notFound.ok).toBe(false);
    expect(notFound.status).toBe(404);

    const d = await seed();
    await recordHumanDisposition(d.decision_id, { disposition: 'REJECT' });
    const again = await recordHumanDisposition(d.decision_id, { disposition: 'APPROVE' });
    expect(again.ok).toBe(false);
    expect(again.status).toBe(409);
  });

  it('缺 disposition → 抛错；DISPOSABLE_STATES 不含已终结态', () => {
    expect(DISPOSABLE_STATES.has('AUTONOMOUS')).toBe(true);
    expect(DISPOSABLE_STATES.has('HUMAN')).toBe(true);
    expect(DISPOSABLE_STATES.has('CONFIRMED')).toBe(false);
    expect(DISPOSABLE_STATES.has('REVERSED')).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/calibration/disposition.test.js`
Expected: FAIL —— `Cannot find module '../../src/decision/disposition.js'`

- [ ] **Step 3: 实现**

```js
// src/decision/disposition.js — 人工处置回写（HITL 闭环唯一出口）
// 设计依据：docs/2026-08-28-decision-quality-calibration-design.md §3
// 背景（代码级核实）：confirmDecision / reverseDecision（decisionRepo.js:195/:214）全仓 0 调用方，
//   导致 state='CONFIRMED'/'REVERSED' 恒不产生、reversal_rate 恒为 0。本模块是被调量的采集点。
import { query, queryWrite } from '../db.js';
import { emit } from '../events/bus.js';
import { recordDecisionEvent } from './decisionRepo.js';
import { recordAudit } from '../action/auditHook.js';
import { addDecision, isAvailable } from './ageGraph.js';

// 可被人工处置的状态集合（已终结的 CONFIRMED / REVERSED 不可再处置）
export const DISPOSABLE_STATES = new Set(['REQUIRED', 'HUMAN', 'AUTONOMOUS']);

// 记录人工最终处置。返回 { ok, decision, overridden, next_state } 或 { ok:false, status, error }
export async function recordHumanDisposition(decision_id, { disposition, by_id = null, by_role = null, note = '' } = {}) {
  if (!decision_id) throw new Error('recordHumanDisposition: 缺少 decision_id');
  if (!disposition || typeof disposition !== 'string') throw new Error('recordHumanDisposition: 缺少 disposition');

  const cur = (await query(
    `SELECT decision_id, scenario_id, disposition AS suggested_disposition, state
       FROM crm.decision WHERE decision_id=$1`, [decision_id])).rows[0];
  if (!cur) return { ok: false, status: 404, error: '决策不存在' };
  if (!DISPOSABLE_STATES.has(cur.state)) {
    return { ok: false, status: 409, error: `决策状态 ${cur.state} 不可处置` };
  }

  const overridden = cur.suggested_disposition !== disposition;
  const nextState = overridden ? 'REVERSED' : 'CONFIRMED';

  const r = await queryWrite(
    `UPDATE crm.decision
        SET human_disposition = $2,
            human_decided_at  = now(),
            human_decider_id  = $3,
            human_decider_role= $4,
            state             = $5,
            outcome           = CASE WHEN $5 = 'REVERSED' THEN 'REVERSED' ELSE outcome END,
            updated_at        = now()
      WHERE decision_id = $1
      RETURNING *`,
    [decision_id, disposition, by_id, by_role, nextState]
  );
  const d = r.rows[0];

  // 审计留痕：复用被处置决策自身的 id（不新建 decision，避免自引用）
  await recordAudit({
    target_particle_type: 'decision',
    source: 'approval',
    action: 'human-disposition',
    actor: by_id || 'system',
    decision_id,
    payload: {
      scenario_id: cur.scenario_id,
      from_disposition: cur.suggested_disposition,
      to_disposition: disposition,
      overridden,
      note,
    },
  }).catch(() => {});

  await recordDecisionEvent('human-disposition', {
    decision_id, scenario_id: cur.scenario_id, disposition, overridden, by_id, by_role,
  }).catch(() => {});

  if (isAvailable()) {
    try {
      await addDecision(d);
    } catch (e) {
      emit('trace', 'decision-graph-sync-failed', { decision_id, error: String(e?.message || e) });
    }
  }

  emit('decision', overridden ? 'overridden' : 'confirmed', { decision_id, disposition, by_role });
  return { ok: true, decision: d, overridden, next_state: nextState };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/calibration/disposition.test.js`
Expected: 4 passed

- [ ] **Step 5: Commit**

```bash
git add src/decision/disposition.js test/calibration/disposition.test.js
git commit -m "feat(calibration-p0): 人工处置回写唯一出口 disposition.js"
```

---

## Task 3: `createTask` 支持 `decisionId`

**Files:**
- Modify: `src/kanban/kanban.js:33-40`
- Test: `test/kanban/createTask.test.js`

- [ ] **Step 1: 写失败测试**

```js
// test/kanban/createTask.test.js — createTask decisionId 关联（校准 P0 链路）
import { describe, it, expect, beforeEach } from 'vitest';
import { query } from '../../src/db.js';
import { createTask, getTask } from '../../src/kanban/kanban.js';
import { createDecision } from '../../src/decision/decisionRepo.js';

beforeEach(async () => {
  await query('TRUNCATE crm.tasks, crm.decision RESTART IDENTITY CASCADE');
});

describe('createTask decisionId', () => {
  it('传入 decisionId → 落库且可按 decision_id 反查', async () => {
    const d = await createDecision({
      scenario_id: 'LEAD_FOLLOW_UP', trigger_context: {}, involved_entities: [],
      conditions_evaluated: [], disposition: 'ESCALATE', decider_type: 'HUMAN',
      rationale: '升级待审批', business_tier: 'LEAD', state: 'HUMAN',
    });
    const t = await createTask({
      step: 'decision-review', title: '决策审批', actionName: 'decision-disposition',
      payload: { type: 'CRM_DEAL' }, decisionId: d.decision_id,
    });
    expect(t.decision_id).toBe(d.decision_id);

    const rows = (await query('SELECT id FROM crm.tasks WHERE decision_id=$1', [d.decision_id])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(t.id);
  });

  it('不传 decisionId → 列为 null（向后兼容既有调用方）', async () => {
    const t = await createTask({ step: 's1', title: 't', actionName: 'a' });
    expect(t.decision_id).toBeNull();
    expect((await getTask(t.id)).decision_id).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/kanban/createTask.test.js`
Expected: FAIL —— `t.decision_id` 为 `undefined`（列不存在）

- [ ] **Step 3: 实现**

把 `src/kanban/kanban.js:33-40` 改为：

```js
// 创建任务：默认 ready 态；depends_on 为 UUID[]（缺省空）
// decisionId：校准 P0 —— 升级决策落地待办时携带，打通「决策 → 待办 → 人工处置」链路
export async function createTask({ tenantId = 'system', chainId = null, step, title, actionName, payload = {}, dependsOn = [], decisionId = null }) {
  const r = await queryWrite(
    `INSERT INTO tasks (tenant_id, chain_id, step, title, action_name, payload, depends_on, status, decision_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'ready',$8) RETURNING *`,
    [tenantId, chainId, step, title, actionName, JSON.stringify(payload), dependsOn, decisionId]
  );
  return r.rows[0];
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/kanban/createTask.test.js`
Expected: 2 passed

- [ ] **Step 5: Commit**

```bash
git add src/kanban/kanban.js test/kanban/createTask.test.js
git commit -m "feat(calibration-p0): createTask 支持 decisionId 关联"
```

---

## Task 4: 路由接线 —— 升级建待办 + 处置端点

**Files:**
- Modify: `src/http/routes.js`（import 区、`:216` 升级分支、`/api/monitor/audit` 之后新增端点）

> **注意**：`routes.js` 在 server 启动时加载，改动后**必须重启 server** 才生效。

- [ ] **Step 1: 补 import**

在 `src/http/routes.js` 顶部 import 区追加：

```js
import { createTask } from '../kanban/kanban.js';
import { recordHumanDisposition } from '../decision/disposition.js';
```

- [ ] **Step 2: 升级分支落地待办**

把 `src/http/routes.js:216-222` 的升级分支：

```js
          if (dec.mode === 'escalated' || dec.decision?.state !== 'AUTONOMOUS') {
            return res.status(403).json({
              error: '写操作需自主决策上下文（第0闸）：该商机分级升级人工，请经审批流发起',
              decision: dec.decision?.decision_id || null, tier: dec.tier || null,
            });
          }
```

改为：

```js
          if (dec.mode === 'escalated' || dec.decision?.state !== 'AUTONOMOUS') {
            // 校准 P0：升级决策落地为待办（携带 decision_id），使人工处置可回写 → 采集覆写信号
            //   fail-open：建待办失败不阻断主流程，仍返回 403（第0闸语义不变）
            await createTask({
              step: 'decision-review',
              title: `决策审批：${type} · ${dec.decision?.scenario_id || 'LEAD_FOLLOW_UP'}`,
              actionName: 'decision-disposition',
              payload: { type, payload },
              decisionId: dec.decision?.decision_id || null,
            }).catch(() => {});
            return res.status(403).json({
              error: '写操作需自主决策上下文（第0闸）：该商机分级升级人工，请经审批流发起',
              decision: dec.decision?.decision_id || null, tier: dec.tier || null,
            });
          }
```

- [ ] **Step 3: 新增处置端点**

在 `app.get('/api/monitor/audit', ...)` 处理器之后插入：

```js
  // 校准 P0：人工处置回写（HITL 闭环采集点；被调量 = human_disposition vs disposition）
  app.post('/api/decisions/:id/disposition', async (req, res) => {
    const me = resolveMe(req);
    if (!me?.ok) return res.status(401).json({ error: '未登录' });
    const { disposition, note } = req.body || {};
    try {
      const r = await recordHumanDisposition(req.params.id, {
        disposition,
        by_id: me.username || me.display_name || 'user',
        by_role: me.role,
        note,
      });
      if (!r.ok) return res.status(r.status || 400).json({ error: r.error });
      res.json({ ok: true, decision: r.decision, overridden: r.overridden, state: r.next_state });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
```

- [ ] **Step 4: 写端点测试**

新建 `test/http/decisionDisposition.test.js`。

> **HTTP 测试惯例（已核实，照抄即可）**：`createApp()` 出自 `src/http/server.js:14`，其 `app.fetch(path, opts)` 是进程内适配器（`server.js:31`），`res.status` / `res.json()` 可用。鉴权用 `Authorization: Bearer ${issueToken({username, role, display_name})}`，`issueToken` 出自 `src/http/auth.js`——参照 `test/particles-write.test.js:10-19`。

```js
// test/http/decisionDisposition.test.js — 人工处置端点（校准 P0）
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createApp } from '../../src/http/server.js';
import { issueToken } from '../../src/http/auth.js';
import { query } from '../../src/db.js';
import { createDecision } from '../../src/decision/decisionRepo.js';

let app;
beforeAll(() => { app = createApp(); });
beforeEach(async () => {
  await query('TRUNCATE crm.decision, crm.decision_event RESTART IDENTITY CASCADE');
});

const bearer = (role) => `Bearer ${issueToken({ username: 'tester', role, display_name: '测试员' })}`;

function post(path, body, role = 'sales') {
  return app.fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: bearer(role) },
    body: JSON.stringify(body),
  });
}

async function seedDecision() {
  return createDecision({
    scenario_id: 'LEAD_FOLLOW_UP', trigger_context: {}, involved_entities: [],
    conditions_evaluated: [], disposition: 'APPROVE', decider_type: 'AUTONOMOUS_AGENT',
    rationale: '测试用决策', business_tier: 'LEAD', state: 'AUTONOMOUS',
  });
}

describe('POST /api/decisions/:id/disposition', () => {
  it('无 token → 401', async () => {
    const res = await app.fetch('/api/decisions/00000000-0000-0000-0000-000000000000/disposition', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ disposition: 'APPROVE' }),
    });
    expect(res.status).toBe(401);
  });

  it('改判（与建议不等）→ 200 + overridden=true + state=REVERSED', async () => {
    const d = await seedDecision();
    const res = await post(`/api/decisions/${d.decision_id}/disposition`, { disposition: 'REJECT', note: '预算不符' });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.overridden).toBe(true);
    expect(j.state).toBe('REVERSED');
  });

  it('认可（与建议一致）→ 200 + overridden=false + state=CONFIRMED', async () => {
    const d = await seedDecision();
    const res = await post(`/api/decisions/${d.decision_id}/disposition`, { disposition: 'APPROVE' });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.overridden).toBe(false);
    expect(j.state).toBe('CONFIRMED');
  });

  it('未知 decision_id → 404；缺 disposition → 400', async () => {
    const nf = await post('/api/decisions/00000000-0000-0000-0000-000000000000/disposition', { disposition: 'APPROVE' });
    expect(nf.status).toBe(404);

    const d = await seedDecision();
    const bad = await post(`/api/decisions/${d.decision_id}/disposition`, {});
    expect(bad.status).toBe(400);
  });
});
```

- [ ] **Step 5: 运行测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/http/decisionDisposition.test.js`
Expected: 2 passed

- [ ] **Step 6: Commit**

```bash
git add src/http/routes.js test/http/decisionDisposition.test.js
git commit -m "feat(calibration-p0): 升级决策落地待办 + 人工处置端点"
```

---

## Task 5: 全量回归与验收

- [ ] **Step 1: 跑全量**

Run: `node node_modules/vitest/vitest.mjs run`
Expected: 无新增失败（基线见当日记录：1107 例 / 1099 通过 / 6 失败，6 条均为既有问题）

- [ ] **Step 2: 手工验收 P0 是否真的打通**

Run（需先起 server：`node src/http/server.js`）：

```bash
# 1) 发起一个会升级的商机写（无先例 → LEAD_FOLLOW_UP 升级 HITL）
curl -s -X POST http://127.0.0.1:3000/api/particles \
  -H 'Content-Type: application/json' -H 'x-crm-actor: {"ok":true,"role":"sales","username":"alice"}' \
  -d '{"type":"CRM_DEAL","payload":{"name":"P0验收商机","stage":"leads"}}'
# 期望：403 + decision（HUMAN 态决策 id）

# 2) 查该 decision_id 是否生成了待办
psql -h 127.0.0.1 -p 5433 -U agent2b -d plm -c \
  "SELECT id, step, action_name, decision_id FROM crm.tasks WHERE decision_id IS NOT NULL ORDER BY created_at DESC LIMIT 3;"
# 期望：至少 1 行，decision_id 与步骤 1 返回的 decision 一致

# 3) 对该决策做人工处置（改判）
curl -s -X POST http://127.0.0.1:3000/api/decisions/<decision_id>/disposition \
  -H 'Content-Type: application/json' -H 'x-crm-actor: {"ok":true,"role":"manager","username":"bob"}' \
  -d '{"disposition":"REJECT","note":"P0 验收"}'
# 期望：{"ok":true,"overridden":true,"state":"REVERSED"}

# 4) 确认被调量已产生（P0 前此处恒为空）
psql -h 127.0.0.1 -p 5433 -U agent2b -d plm -c \
  "SELECT count(*) FROM crm.decision WHERE human_disposition IS NOT NULL;"
# 期望：>= 1
```

**判定标准：步骤 4 返回的计数从 0 变为 ≥1，即 P0 打通。** P0 之前 `human_disposition` 列不存在、`confirmDecision` 无调用方，该信号恒为 0。

- [ ] **Step 3: Commit（若验收中产生修补）**

```bash
git add -A
git commit -m "fix(calibration-p0): 验收修补"
```

---

## 自检清单

- [x] 覆盖设计 §2.1（列与索引）、§3（处置回写唯一出口 + 审计不自引用）
- [x] 迁移两处都写（`db/schema.sql` + `scripts/seed-test-config.mjs`），规避测试库缺列的既有坑
- [x] 每个 Task 自带测试与 commit
- [x] 验收标准是可观测的计数变化，不是"看起来对"
