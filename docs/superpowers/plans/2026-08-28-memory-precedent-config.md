# 记忆/先例管理配置页（item 26 · 记忆三构件 + 先例网络 + 蒸馏）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为配置中心第 26 项「记忆 / 先例管理」交付管理页 `/memory.html`，使记忆三构件（`memory_log` 流水 → `memory_note` 常驻笔记 → `memory_snapshot` 不可变快照）与决策先例网络（`decision_precedent_rel` 相似度边）可读可管、30 天蒸馏可触发，绝对禁删（只置 `archived=true`/`INACTIVE`），写经决策第 0 闸（`config_change`）。

**Background / 现状缺口（证据）：**
- 表已就绪：`crm.memory_log`（append-only，layer/actor/event_type/distilled/archived/ttl_days，schema.sql:197/229）、`crm.memory_snapshot`（不可变，schema.sql:239）、`crm.memory_note`（(layer,topic) PK upsert，schema.sql:249）。
- 先例网络：`crm.decision_precedent_rel(decision_id, precedent_id, similarity)`（decisionRepo.js:99-115 写时镜像；ageGraph.js 递归 CTE 多跳；autonomyEngine 按相似度自主引用）。
- 蒸馏已有端点：`POST /api/memory/distill`（routes.js:804，dryRun 计数 + 执行：memory_log 置 distilled / 归档 archived，memory_note 按 ttl 归档）。
- **缺口：除蒸馏外无任何 memory 读取/管理端点**（无列表、无快照/笔记视图、无先例网络视图）；蓝图 S31（master-blueprint §S31 `/config/memory`）设计存在但未落页。
- 页面范式：第 14/22/28 项同构——`*Render.js` 纯函数子模块（零服务端 import，浏览器 ESM 可加载）+ 原文件保留 Router + re-export + 页面 import 子模块；写经 `recordDecisionEvent('config_change', ...)` 第 0 闸 + `resolveMe` sysadmin 403。

**Tech Stack:** Node 22 + ESM + Express 4 + PostgreSQL（crm schema）；门户 ESM 子模块（`/portal/*.js`，Content-Type:text/javascript）浏览器与 vitest 共用；vitest（globals OFF，须 `import {test,expect} from 'vitest'`）。

**硬约束（红线）：**
1. **绝对禁删**：list/distill 只置 `distilled=true` / `archived=true`，无 DELETE 路由；`memory_snapshot` 不可变（无 update/delete）。
2. **写经决策第 0 闸**：蒸馏触发（POST）落一条 `config_change` 决策事件（`recordDecisionEvent`），返回 event_id。
3. **不动既有语义**：`memoryLog.js` 的 `appendMemory/retrieveMemory/distillMemory`、`note.js` 的 `upsertNote/getNote`、`snapshot.js` 的 `createSnapshot/getSnapshot` 签名与行为一律不变；本页只**读取 + 触发既有蒸馏**。
4. 页面 import **必须指向 `*Render.js` 子模块**（源头文件含 express/db import，浏览器 ESM 崩溃——2026-08-27 QA 教训）。

**范围（YAGNI）：**
- ✅ 记忆日志列表（log）：按 layer/topic 过滤、`distilled/archived` 徽标、最近 50 条。
- ✅ 常驻笔记表（note）：`(layer,topic)` 列表 + 只读预览。
- ✅ 快照表（snapshot）：不可变快照列表（ref_id 可点看 json）。
- ✅ 先例网络面板：`decision_precedent_rel` 汇总（顶层被引用先例 TopN + 相似度），只读。
- ✅ 蒸馏触发：dryRun 预检（待蒸馏计数）+ 执行（写决策事件）。
- ❌ 不做记忆**写入/编辑**（记忆是业务副作用自动捕获，residue 铁律：禁止"独立记录动作"界面；`appendMemory` 不开配置页入口）。
- ❌ 不做 `memory_note` 内容编辑（L-User 笔记由系统蒸馏写入）。
- ❌ 不做先例边新增/删除（先例由决策引擎自动镜像）。

---

## 文件结构

- 新建 `src/portal/memoryConfigRender.js`：纯函数（`LOG_LAYERS/LOG_KINDS` 常量、`memorySummary`、`renderMemoryLogs`、`renderMemoryNotes`、`renderMemorySnapshots`、`renderPrecedentPanel`、`renderDistillPanel`）——零服务端 import。
- 新建 `src/portal/memoryConfig.js`：`createMemoryConfigRouter`（GET 列表 / POST distill，注入式依赖 defaultDeps）+ 从 Render 子模块 re-export。
- 新建 `test/web/memoryConfig.test.js`：渲染 ~8 例 + handler ~6 例（RED→GREEN）。
- 新建 `src/web/memory.html`：拉取→渲染→蒸馏触发（dryRun 预检 + 执行）。
- 修改 `src/http/routes.js`：import + `app.use(createMemoryConfigRouter({}))` + `/memory.html` + `/memory` 302 + `/portal/memoryConfigRender.js` 静态段（原文件 `/portal/memoryConfig.js` 也挂，兼容）。
- 修改 `src/portal/configCenter.js`：第 26 项 `pending→ready` + `page:'/memory.html'` + `endpoint:'/api/memory'` + note 更新。
- 修改 `src/web/nav.js`：追加「🧠 记忆管理」入口（位于系统设置前）。
- 修改 `src/portal/memoryConfigRender.js`：若 `src/web/nav.js` 顺序需调整，见 Task 4。

---

### Task 1: 渲染纯函数 + 渲染测试（RED→GREEN）

**Files:**
- Create: `src/portal/memoryConfigRender.js`
- Test: `test/web/memoryConfig.test.js`

- [ ] **Step 1: 写失败测试**

```js
// test/web/memoryConfig.test.js
import { test, expect } from 'vitest';
import {
  LOG_LAYERS, LOG_KINDS, memorySummary, renderMemoryLogs, renderMemoryNotes,
  renderMemorySnapshots, renderPrecedentPanel, renderDistillPanel,
} from '../../src/portal/memoryConfigRender.js';

const LOGS = [
  { id: 'a1', layer: 'L-Workspace', topic: 'decision:abc', kind: 'decision', actor: 'alice', event_type: 'decision-made',
    distilled: true, archived: false, ttl_days: 30, created_at: '2026-08-01T00:00:00Z',
    payload: { scenario_id: 'quote', tier: 'NORMAL' } },
  { id: 'a2', layer: 'L-Workspace', topic: 'follow:deal1', kind: 'event', actor: 'alice', event_type: 'followup',
    distilled: false, archived: true, ttl_days: 30, created_at: '2026-07-01T00:00:00Z', payload: {} },
];
const NOTES = [
  { layer: 'L-User', topic: 'ui:import-export-pref', content: { fields: ['qty', 'price'] }, updated_at: '2026-08-20T00:00:00Z', archived: false },
  { layer: 'L-Workspace', topic: 'deal:recovery', content: { note: '预算卡在财务部' }, updated_at: '2026-08-21T00:00:00Z', archived: true },
];
const SNAPS = [
  { id: 's1', topic: 'approval:inst1', ref_id: 'inst-1', snapshot: { from: 'PENDING', to: 'APPROVED' }, created_at: '2026-08-02T00:00:00Z' },
];
const PRECS = [
  { precedent_id: 'dec-9', similarity: 0.92, referenced_times: 5 },
  { precedent_id: 'dec-2', similarity: 0.71, referenced_times: 2 },
];

test('常量：layers/kinds', () => {
  expect(LOG_LAYERS).toContain('L-Workspace');
  expect(LOG_KINDS).toContain('decision');
});

test('memorySummary 统计', () => {
  expect(memorySummary(LOGS, NOTES, SNAPS)).toEqual({ logs: 2, distilled: 1, archivedLogs: 1, notes: 2, snapshots: 1 });
});

test('renderMemoryLogs 表格含关键列与徽标', () => {
  const html = renderMemoryLogs(LOGS);
  expect(html).toContain('decision:abc');
  expect(html).toContain('已蒸馏');          // distilled 徽标
  expect(html).toContain('已归档');          // archived 徽标
  expect(html).toContain('L-Workspace');
});

test('renderMemoryLogs 空态', () => {
  expect(renderMemoryLogs([])).toContain('无记忆日志');
});

test('renderMemoryNotes 表格', () => {
  const html = renderMemoryNotes(NOTES);
  expect(html).toContain('ui:import-export-pref');
  expect(html).toContain('L-User');
  expect(html).toContain('已归档');
  expect(html).toContain('deal:recovery');
});

test('renderMemorySnapshots 表格', () => {
  const html = renderMemorySnapshots(SNAPS);
  expect(html).toContain('approval:inst1');
  expect(html).toContain('inst-1');
});

test('renderPrecedentPanel TopN 排序 + 相似度', () => {
  const html = renderPrecedentPanel(PRECS);
  // 按 referenced_times 降序：dec-9 在前
  expect(html.indexOf('dec-9')).toBeLessThan(html.indexOf('dec-2'));
  expect(html).toContain('92%');
});

test('renderDistillPanel dryRun 后展示计数', () => {
  const html = renderDistillPanel({ wouldDistill: 3, dryRun: true });
  expect(html).toContain('3');
});
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `cd /d/system/CRM-ai-native && node node_modules/vitest/vitest.mjs run test/web/memoryConfig.test.js 2>&1 | tail -15`
Expected: FAIL（`Cannot find module '../../src/portal/memoryConfigRender.js'`）

- [ ] **Step 3: 实现渲染纯函数**

```js
// src/portal/memoryConfigRender.js — 记忆/先例管理（第 26 项）渲染纯函数子模块
// 浏览器 ESM 可加载（零服务端 import）。服务端 Router 在 memoryConfig.js。
// 数据事实：memory_log（流水）/ memory_note（常驻）/ memory_snapshot（不可变）
//          / decision_precedent_rel（先例相似度网络）
// 红线：禁删（只读 + 蒸馏置 archived）；无写入表单（residue 铁律）
export const LOG_LAYERS = ['L-Workspace', 'L-User', 'L-Cloud'];
export const LOG_KINDS = ['decision', 'event', 'evidence', 'followup', 'note'];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const fmt = (d) => (d ? new Date(d).toLocaleString?.() || '' : '—');

export function memorySummary(logs = [], notes = [], snaps = []) {
  return {
    logs: logs.length,
    distilled: logs.filter((l) => l.distilled).length,
    archivedLogs: logs.filter((l) => l.archived).length,
    notes: notes.length,
    snapshots: snaps.length,
  };
}

export function renderMemoryLogs(logs = [], { q } = {}) {
  if (!logs.length) return '<div class="empty">无记忆日志（业务事件自动捕获，禁手写）</div>';
  const rows = logs
    .map((l) => `<tr class="log-row" data-id="${esc(l.id)}">
      <td class="mono">${esc(String(l.topic))}</td>
      <td>${esc(l.kind || '')}</td>
      <td>${esc(l.layer || '')}</td>
      <td>${esc(l.actor || '—')}</td>
      <td>${esc(l.event_type || '')}</td>
      <td>${l.distilled ? '<span class="badge ok">已蒸馏</span>' : ''} ${l.archived ? '<span class="badge off">已归档</span>' : ''}</td>
      <td class="mono">${fmt(l.created_at)}</td>
    </tr>`).join('');
  return `<table class="mem-tbl"><thead><tr><th>topic</th><th>kind</th><th>layer</th><th>actor</th><th>事件</th><th>状态</th><th>时间</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

export function renderMemoryNotes(notes = []) {
  if (!notes.length) return '<div class="empty">无常驻笔记</div>';
  const rows = notes.map((n) => `<tr class="note-row">
    <td>${esc(n.layer || '')}</td>
    <td>${esc(n.topic)}</td>
    <td class="mono">${esc(JSON.stringify(n.content))}</td>
    <td>${n.archived ? '<span class="badge off">已归档</span>' : '<span class="badge ok">活跃</span>'}</td>
    <td class="mono">${fmt(n.updated_at)}</td>
  </tr>`).join('');
  return `<table class="mem-tbl"><thead><tr><th>layer</th><th>topic</th><th>内容</th><th>状态</th><th>更新时间</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

export function renderMemorySnapshots(snaps = []) {
  if (!snaps.length) return '<div class="empty">无不可变快照</div>';
  const rows = snaps.map((s) => `<tr class="snap-row" data-id="${esc(s.id)}">
    <td>${esc(s.topic)}</td>
    <td class="mono">${esc(s.ref_id || '—')}</td>
    <td class="mono">${esc(String(s.id).slice(0, 8))}</td>
    <td class="mono">${fmt(s.created_at)}</td>
  </tr>`).join('');
  return `<table class="mem-tbl"><thead><tr><th>topic</th><th>ref_id</th><th>快照</th><th>时间</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

export function renderPrecedentPanel(precs = []) {
  if (!precs.length) return '<div class="empty">无先例引用（决策自动镜像）</div>';
  const rows = precs.map((p) => `<tr class="prec-row">
    <td class="mono">${esc(p.precedent_id)}</td>
    <td><div class="sim-bar"><span style="width:${Math.min(100, Math.round((p.similarity || 0) * 100))}%"></span></div></td>
    <td class="mono">${Math.round((p.similarity || 0) * 100)}%</td>
    <td>${p.referenced_times ?? 0} 次</td>
  </tr>`).join('');
  return `<table class="mem-tbl"><thead><tr><th>先例决策</th><th>相似度</th><th>%</th><th>被引用</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

export function renderDistillPanel(res = {}) {
  const n = res.wouldDistill ?? res.distilled ?? 0;
  const dry = res.dryRun;
  return `<div class="distill-panel">
    <p class="muted">${dry ? `预检：待蒸馏 ${n} 条流水` : `蒸馏完成：${n} 条流水标记 distilled（原始行保留）`}</p>
    <p class="muted">蒸馏=标 distilled 非删除 · 30 天周期 · 写经决策第 0 闸</p>
  </div>`;
}
```

- [ ] **Step 4: 运行测试确认 GREEN**

Run: `cd /d/system/CRM-ai-native && node node_modules/vitest/vitest.mjs run test/web/memoryConfig.test.js 2>&1 | tail -15`
Expected: PASS（8/8）

- [ ] **Step 5: 提交**

```bash
git add src/portal/memoryConfigRender.js test/web/memoryConfig.test.js
git commit -m "feat(memory-config): 渲染纯函数+8测试"
```

---

### Task 2: Router 工厂（GET 列表 + POST distill）+ handler 测试（RED→GREEN）

**Files:**
- Create: `src/portal/memoryConfig.js`
- Test: `test/web/memoryConfig.test.js`（追加）

- [ ] **Step 1: 追加失败 handler 测试**

```js
// 追加到 test/web/memoryConfig.test.js
import { createMemoryConfigRouter } from '../../src/portal/memoryConfig.js';
import { LOG_LAYERS } from '../../src/portal/memoryConfigRender.js';

function makeDeps(over = {}) {
  return {
    listLogs: async () => [],
    listNotes: async () => [],
    listSnapshots: async () => [],
    listPrecedents: async () => [],
    distill: async (ttlDays) => ({ ok: true }),
    distillDryRun: async () => ({ wouldDistill: 3 }),
    produceDecision: async (ctx) => ({ event_id: 'e-1' }),
    resolveMe: async () => ({ ok: true, role: 'admin' }),
    ...over,
  };
}

test('GET /api/memory 返回四段', async () => {
  const router = createMemoryConfigRouter(makeDeps());
  let body = null;
  const res = { json: (p) => { body = p; return res; }, status: () => res };
  await router.handlers.get({}, res);
  expect(body.logs).toBeDefined();
  expect(body.notes).toBeDefined();
  expect(body.snapshots).toBeDefined();
  expect(body.precedents).toBeDefined();
});

test('GET 非 sysadmin → 403', async () => {
  const router = createMemoryConfigRouter(makeDeps({ resolveMe: async () => ({ ok: true, role: 'sales' }) }));
  let code = 0, body = null;
  const res = { status: (c) => { code = c; return { json: (p) => { body = p; } }; }, json: (p) => { body = p; } };
  await router.handlers.get({}, res);
  expect(code).toBe(403);
});

test('POST /api/memory/distill dryRun=true → 不落决策', async () => {
  const deps = makeDeps();
  const router = createMemoryConfigRouter(deps);
  let code = 0, body = null;
  const res = { status: (c) => { code = c; return { json: (p) => { body = p; } }; }, json: (p) => { body = p; } };
  await router.handlers.post({ query: {}, body: { dryRun: true } }, res);
  expect(code).toBe(200);
  expect(body.wouldDistill).toBe(3);
  expect(deps.produceDecision).not.toHaveBeenCalled();
});

test('POST /api/memory/distill 执行 → 写决策事件', async () => {
  const deps = makeDeps();
  const router = createMemoryConfigRouter(deps);
  let code = 0, body = null;
  const res = { status: (c) => { code = c; return { json: (p) => { body = p; } }; }, json: (p) => { body = p; } };
  await router.handlers.post({ query: {}, body: {} }, res);
  expect(code).toBe(200);
  expect(body.ok).toBe(true);
  expect(body.decision).toBe('e-1');
  expect(deps.distill).toHaveBeenCalledWith(30);
});

test('无 DELETE 路由', () => {
  const router = createMemoryConfigRouter(makeDeps());
  expect(router.handlers.delete).toBeUndefined();
});
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `cd /d/system/CRM-ai-native && node node_modules/vitest/vitest.mjs run test/web/memoryConfig.test.js 2>&1 | tail -20`
Expected: FAIL（`createMemoryConfigRouter is not a function`）

- [ ] **Step 3: 实现 Router（注入式依赖，对齐 alertRuleConfig 范式）**

```js
// src/portal/memoryConfig.js — 记忆/先例管理（第 26 项）服务端 Router（只读 + 蒸馏触发）
// 渲染纯函数在 memoryConfigRender.js（浏览器可加载子模块）；本文件只服务端用。
// 红线：绝对禁删（蒸馏=标 distilled/archived，无 DELETE）；写经决策第 0 闸（config_change）
import { Router } from 'express';
import { query } from '../db.js';
import { recordDecisionEvent } from '../decision/decisionRepo.js';
import { resolveMe } from '../http/auth.js';
import { distillMemory } from '../memory/memoryLog.js';
// re-export 渲染纯函数（测试/旧页面兼容）
export {
  LOG_LAYERS, LOG_KINDS, memorySummary, renderMemoryLogs, renderMemoryNotes,
  renderMemorySnapshots, renderPrecedentPanel, renderDistillPanel,
} from './memoryConfigRender.js';

const defaultDeps = {
  listLogs: async (limit = 50) =>
    (await query(
      `SELECT id, layer, topic, kind, actor, event_type, distilled, archived, ttl_days, created_at, payload
       FROM crm.memory_log WHERE archived=false ORDER BY created_at DESC LIMIT $1`, [limit]
    )).rows,
  listNotes: async () =>
    (await query(`SELECT layer, topic, content, updated_at, archived FROM crm.memory_note ORDER BY updated_at DESC LIMIT 50`)).rows,
  listSnapshots: async () =>
    (await query(`SELECT id, topic, ref_id, snapshot, created_at FROM crm.memory_snapshot ORDER BY created_at DESC LIMIT 20`)).rows,
  // 先例网络 TopN：被引用最多的先例（相似度默认取该边最大）
  listPrecedents: async () =>
    (await query(
      `SELECT r.precedent_id, max(r.similarity)::real AS similarity, count(*)::int AS referenced_times
       FROM crm.decision_precedent_rel r GROUP BY r.precedent_id
       ORDER BY referenced_times DESC, similarity DESC LIMIT 20`
    )).rows,
  distill: async (ttlDays) => distillMemory({ ttlDays }),
  distillDryRun: async () => {
    const r = await query(`SELECT count(*)::int AS n FROM crm.memory_log WHERE archived=false AND distilled=false AND created_at < now() - '30 days'::interval`);
    return { wouldDistill: r.rows[0].n };
  },
  produceDecision: async (ctx) => {
    const row = await recordDecisionEvent('config_change', {
      type: 'memory_distill',
      trigger_context: ctx || {},
    });
    return { event_id: row?.event_id || null };
  },
  resolveMe,
};

export function createMemoryConfigRouter(deps = {}) {
  const D = { ...defaultDeps, ...deps };
  const router = Router();
  const forbid = (res) => res.status(403).json({ error: '需要 sysadmin 权限' });

  const handlers = {
    // GET /api/memory — 记忆四段聚合（只读）
    get: async (req, res) => {
      try {
        const me = await D.resolveMe(req);
        if (!me?.ok || me.role !== 'admin') return forbid(res);
        const [logs, notes, snapshots, precedents] = await Promise.all([
          D.listLogs(), D.listNotes(), D.listSnapshots(), D.listPrecedents(),
        ]);
        res.json({ logs, notes, snapshots, precedents });
      } catch (e) { res.status(500).json({ error: e.message }); }
    },
    // POST /api/memory/distill — dryRun 预检（不写）| 执行（标 distilled，写决策事件）
    post: async (req, res) => {
      try {
        const me = await D.resolveMe(req);
        if (!me?.ok || me.role !== 'admin') return forbid(res);
        const dryRun = req.query?.dryRun === '1' || req.body?.dryRun;
        if (dryRun) {
          return res.json({ dryRun: true, ...(await D.distillDryRun()) });
        }
        const decision = await D.produceDecision({ ttl_days: 30 });
        const d = await D.distill(30);
        res.json({ ok: !!d?.ok, decision: decision?.event_id || null });
      } catch (e) { res.status(500).json({ error: e.message }); }
    },
  };

  router.get('/api/memory', handlers.get);
  router.post('/api/memory/distill', handlers.post);
  router.handlers = handlers; // 无 delete
  return router;
}
```

- [ ] **Step 4: 运行测试确认 GREEN**

Run: `cd /d/system/CRM-ai-native && node node_modules/vitest/vitest.mjs run test/web/memoryConfig.test.js 2>&1 | tail -15`
Expected: PASS（13/13）

- [ ] **Step 5: 提交**

```bash
git add src/portal/memoryConfig.js test/web/memoryConfig.test.js
git commit -m "feat(memory-config): Router 工厂+13测试"
```

---

### Task 3: routes.js 挂载 + 页路由 + 静态段

**Files:**
- Modify: `src/http/routes.js`

- [ ] **Step 1: import 新增 Router（`createSystemSettingsRouter` import 之后）**

```js
import { createMemoryConfigRouter } from '../portal/memoryConfig.js';
```

- [ ] **Step 2: 挂载 Router（第 85 行 createAgentConfigRouter 挂载旁）**

```js
  app.use(createMemoryConfigRouter({}));
```

- [ ] **Step 3: 页路由 + 静态段（在 `/system.html` 等页路由旁追加）**

```js
  // 记忆/先例管理（第 26 项）
  app.get('/memory.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/memory.html', import.meta.url))));
  app.get('/memory', (req, res) => res.redirect('/memory.html'));
  app.get('/portal/memoryConfigRender.js', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../portal/memoryConfigRender.js', import.meta.url)), { headers: { 'Content-Type': 'text/javascript' } }));
  app.get('/portal/memoryConfig.js', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../portal/memoryConfig.js', import.meta.url)), { headers: { 'Content-Type': 'text/javascript' } }));
```

- [ ] **Step 4: 语法冒烟**

Run: `cd /d/system/CRM-ai-native && node --input-type=module -e "import('./src/http/routes.js').then(()=>console.log('routes OK')).catch(e=>{console.error(e.message);process.exit(1)})" 2>&1 | tail -15`
Expected: `routes OK`

- [ ] **Step 5: 提交**

```bash
git add src/http/routes.js
git commit -m "feat(memory-config): 路由挂载+页路由+静态段"
```

---

### Task 4: memory.html 管理页

**Files:**
- Create: `src/web/memory.html`

- [ ] **Step 1: 创建页面（GET 四段 → 渲染；蒸馏 dryRun 预检 + 执行；15s 轮询日志）**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>记忆/先例管理</title>
  <style>
    body { font-family: -apple-system, "Microsoft YaHei", sans-serif; margin: 24px; background: #f7f8fa; color: #1f2329; }
    h1 { font-size: 20px; }
    .note { background: #fff7e6; border: 1px solid #ffd591; padding: 8px 12px; border-radius: 6px; font-size: 13px; margin: 8px 0 16px; }
    table { border-collapse: collapse; width: 100%; background: #fff; margin: 8px 0 20px; }
    th, td { border: 1px solid #e5e6eb; padding: 6px 8px; text-align: left; vertical-align: top; font-size: 13px; }
    th { background: #f2f3f5; }
    .badge { display: inline-block; padding: 1px 7px; border-radius: 9px; font-size: 11px; }
    .badge.ok { background: #e6fffb; color: #08979c; }
    .badge.off { background: #fff1f0; color: #cf1322; }
    .mono { font-family: ui-monospace, Consolas, monospace; }
    .muted { color: #86909c; font-size: 13px; }
    .sim-bar { width: 80px; height: 8px; background: #f0f0f0; border-radius: 4px; }
    .sim-bar span { display: block; height: 100%; background: #165dff; border-radius: 4px; }
    button { padding: 6px 14px; border: none; border-radius: 6px; background: #165dff; color: #fff; cursor: pointer; }
    button.ghost { background: #e8f3ff; color: #165dff; }
    .distill-box { background: #fff; border: 1px solid #e5e6eb; border-radius: 8px; padding: 12px 16px; margin: 8px 0 16px; }
    .sec-title { font-size: 15px; margin: 16px 0 4px; }
  </style>
</head>
<body>
  <h1>🧠 记忆 / 先例管理</h1>
  <div class="note">⚠️ 只读管理视图：记忆由业务事件自动捕获（residue 铁律，无手写入口）；<b>绝对禁删</b>——蒸馏仅标记，原始行保留。写（蒸馏触发）经决策第 0 闸。</div>
  <div id="app">加载中…</div>

  <script type="module">
    import { renderMemoryLogs, renderMemoryNotes, renderMemorySnapshots, renderPrecedentPanel, renderDistillPanel, memorySummary } from '/portal/memoryConfigRender.js';
    import '/web/nav.js';

    const TOKEN = localStorage.getItem('crm_token');
    const app = document.getElementById('app');
    if (!TOKEN) location.href = '/home.html';

    async function load() {
      try {
        const r = await fetch('/api/memory', { headers: { Authorization: `Bearer ${TOKEN}` } });
        const j = await r.json();
        if (!r.ok) { app.innerHTML = `<p class="muted">加载失败：${j.error || r.status}</p>`; return; }
        const s = memorySummary(j.logs, j.notes, j.snapshots);
        app.innerHTML = `
          <p class="muted">日志 ${s.logs}（蒸馏 ${s.distilled} · 归档 ${s.archivedLogs}）· 笔记 ${s.notes} · 快照 ${s.snapshots} · ${new Date().toLocaleTimeString()}</p>
          <h3 class="sec-title">记忆流水（memory_log · append-only）</h3>
          ${renderMemoryLogs(j.logs)}
          <h3 class="sec-title">常驻笔记（memory_note）</h3>
          ${renderMemoryNotes(j.notes)}
          <h3 class="sec-title">不可变快照（memory_snapshot）</h3>
          ${renderMemorySnapshots(j.snapshots)}
          <h3 class="sec-title">先例网络（decision_precedent_rel · Top 相似度被引用）</h3>
          ${renderPrecedentPanel(j.precedents)}
          <h3 class="sec-title">30 天蒸馏</h3>
          <div class="distill-box" id="distill">
            <button id="dry">预检</button> <button id="run" class="ghost">执行蒸馏</button> <span class="muted" id="dres"></span>
          </div>`;
        bind();
      } catch (e) { app.innerHTML = `<p class="muted">${e.message}</p>`; }
    }

    async function bind() {
      const dres = document.getElementById('dres');
      document.getElementById('dry').addEventListener('click', async () => {
        const r = await fetch('/api/memory/distill?dryRun=1', { headers: { Authorization: `Bearer ${TOKEN}` } });
        const j = await r.json();
        dres.textContent = j.dryRun ? `预检：待蒸馏 ${j.wouldDistill} 条` : (j.error || '预检失败');
      });
      document.getElementById('run').addEventListener('click', async () => {
        const r = await fetch('/api/memory/distill', {
          method: 'POST',
          headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        const j = await r.json();
        dres.textContent = j.ok ? `蒸馏完成（决策 ${String(j.decision || '').slice(0, 8)}…）` : (j.error || '蒸馏失败');
        load();
      });
    }

    load();
    setInterval(() => { if (TOKEN) load(); }, 15000);
  </script>
</body>
</html>
```

- [ ] **Step 2: 提交**

```bash
git add src/web/memory.html
git commit -m "feat(memory-config): 管理页"
```

---

### Task 5: 配置中心第 26 项翻 ready

**Files:**
- Modify: `src/portal/configCenter.js`（第 24 行）
- Modify: `src/web/nav.js`（追加入口）
- Test: `test/web/configCenter.test.js`（如该项有 pending 断言需同步）

- [ ] **Step 1: 翻第 26 项**

```js
  { id: 26, name: '记忆 / 先例管理', group: '治理', status: 'ready', page: '/memory.html', endpoint: '/api/memory', note: '记忆三构件（日志/笔记/快照）只读管理+先例网络+30天蒸馏（标 distilled 非删除），写经决策第0闸+sysadmin' },
```
> 替换原 `{ id: 26, name: '记忆 / 先例管理', group: '治理', status: 'pending', page: null, endpoint: null, note: 'memory_log 表+蒸馏无管理页' }`

- [ ] **Step 2: nav.js 追加入口（`/memory.html`「🧠 记忆管理」）**

```js
  { href: '/memory.html', label: '🧠 记忆管理' },
```

- [ ] **Step 3: 运行配置中心测试确认无回归**

Run: `cd /d/system/CRM-ai-native && node node_modules/vitest/vitest.mjs run test/web/configCenter.test.js 2>&1 | tail -15`
Expected: PASS（8/8）

- [ ] **Step 4: 提交**

```bash
git add src/portal/configCenter.js src/web/nav.js
git commit -m "feat(config-center): 第26项翻ready+导航入口"
```

---

### Task 6: 全量 web 测试 + 冒烟 + 工作日志

**Files:**
- 读/写: `.workbuddy/memory/2026-08-28.md`

- [ ] **Step 1: 运行 test/web 全量（基线 155 + 13 = 168 绿）**

Run: `cd /d/system/CRM-ai-native && node node_modules/vitest/vitest.mjs run test/web/ 2>&1 | tail -25`
Expected: PASS（168/168，不含已知 db 连接池 exit 1 非阻塞项）

- [ ] **Step 2: 路由加载冒烟**

Run: `cd /d/system/CRM-ai-native && node --input-type=module -e "import('./src/http/routes.js').then(()=>console.log('routes OK')).catch(e=>{console.error(e.message);process.exit(1)})" 2>&1 | tail -5`
Expected: `routes OK`

- [ ] **Step 3: 既有 memory 相关测试不受影响**

Run: `cd /d/system/CRM-ai-native && node node_modules/vitest/vitest.mjs run test/web/decisionScenario.test.js test/memory.test.js 2>&1 | tail -15`
Expected: 全绿（若 memory.test.js 存在；否则仅 decisionScenario）

- [ ] **Step 4: 追加工作日志**（见 Task 6 验证口径段，写 `.workbuddy/memory/2026-08-28.md`）

```markdown
## item 26 记忆/先例管理配置页（2026-08-28，内联执行 TDD）
- 交付：src/portal/memoryConfigRender.js（渲染纯函数）+ src/portal/memoryConfig.js（Router：GET /api/memory 四段聚合 + POST /api/memory/distill dryRun/执行）+ src/web/memory.html + routes.js 挂载 + configCenter 第26项 ready + nav 入口。
- 验证：test/web/memoryConfig.test.js 13/13；test/web 全量 168/168（基线155+13）。
- 红线：禁删（蒸馏置 distilled/archived 原始行保留，无 DELETE）；写经决策第0闸（config_change）；页面 import Render 子模块。
- 范围外：记忆写入/笔记编辑/先例边改（residue：记忆是业务副作用自动捕获）。
- 待提交：按 Task 1–5 五笔 commit（沙箱无凭证）。
```

---

## 验收口径

- `test/web/memoryConfig.test.js` **13/13 绿**；`test/web/` 全量 **168/168**（基线 155 + 13）
- `/memory` 可读 4 段（日志/笔记/快照/先例）；蒸馏 dryRun 预检 + 执行（写决策事件）；**无 DELETE**
- `configCenter` 第 26 项 `ready`、可跳转；nav 有新入口
- 页面 import `memoryConfigRender.js`（浏览器 ESM 可加载）；`memoryConfig.js` 仍服务端 Router + re-export
- 既有 `memoryLog/note/snapshot` 语义未动（本页只读 + 触发既有 distillMemory）

## 已知限制（写入 spec 交底）

- 记忆日志列表默认过滤 `archived=true`（活跃区），归档原始行仍在库中可查。
- 先例面板取「被引用 Top20」+ 该先例最高相似度；完整多跳链看 `/decision-graph`。
- 蒸馏触发依赖既有 `distillMemory`（memory_log 标 distilled + 归档超 60 天行；memory_note 按 ttl 归档）；`memory_snapshot` 不参与蒸馏（不可变永久保留）。
- 首页/门户仍可经 `/api/memory/distill` 旧端点触发（本页是新管理入口，未删旧端点的行为）。