# S03 两 TAB 任务监控与执行追踪 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 S03 智能体工作台拆成两 TAB——TAB1 全局任务监控（哪些任务在跑），TAB2 单任务实时执行追踪（三段思考链 + 事件流）。

**Architecture:** 服务端 `renderPage` 新增 `tabs` 布局组件（参考既有 `collapse` 递归渲染子组件）+ `task-monitor` 任务清单组件；`reasoning-trace` 改为 `live` 模式由前端按 `taskId` 订阅 SSE `trace` 域 + 回放端点 `/api/agent-monitor/trace/:taskId` 驱动。不改 `from-nl` 提交行为。全为读操作，无需决策第 0 闸。

**Tech Stack:** Node 22 ESM + Express + vitest；前端原生 ES Module + EventSource SSE。

---

## File Structure

| 文件 | 责任 |
|------|------|
| `src/agent/agentLoop.js` | 补 `agent-intent-parsed` emit + recordEpisode（三段①数据源） |
| `src/page/schema.js` | `COMPONENT_KINDS` 登记 `tabs`/`task-monitor` |
| `src/page/validator.js` | `tabs`/`task-monitor` 跳过粒子四护栏 |
| `src/page/renderer.js` | 新增 `renderTabs`/`renderTaskMonitor`；`reasoning-trace` 支持 `live` |
| `src/pages/S03.schema.js` | 重构为单 `tabs` 组件（monitor/detail 两子页） |
| `src/http/routes.js` | S03 data 加 `taskList`；新增 `GET /api/agent-monitor/trace/:taskId` |
| `src/web/agent-workbench.html` | 两 TAB 切换 + 任务行点击 + SSE `trace`/`task` 处理 + 回放拉取 |
| `test/page/renderTabs.test.js` | 渲染器单测（纯函数，无 DB） |

---

## Task 1: agentLoop 补 intent-parsed 事件

**Files:**
- Modify: `src/agent/agentLoop.js:38-43`

- [ ] **Step 1: 在 `startedAt` 之后、`buildContextBlock` 之前插入意图解析事件**

```js
  const startedAt = Date.now();
  // ① 意图解析：skill 路由决策即"意图"，emit 供工作台 reasoning-trace 三段①驱动（B-γ 详情 TAB）
  emit('trace', 'agent-intent-parsed', { taskId: task.id, intent: skillSlug, action: task.action_name });
  recordEpisode({
    agent_id: ctx?.actor || 'agent', phase: 'intent-parsed',
    context_facts: { intent: skillSlug, contract_task_id: ctId },
    payload: { taskId: task.id, intent: skillSlug },
  }).catch(() => {});
  // 上下文分层：组装 L1-L4 块并注入（降级不抛，result 由 executeSkill 消费）
  const { block: contextBlock, bundle } = await buildContextBlock(task, ctx).catch(() => ({ block: '', bundle: { layers: {}, missing: {} } }));
```

- [ ] **Step 2: 验证落库 + emit（集成，手动）**

Run: 先 `node scripts/seed-test-config.mjs` 保证测试库；起 server 后 pump 一个 ready 任务，再查：
```bash
PGDATABASE=plm node -e "import('/src/db.js').then(async ({query})=>{const d=await query(\"SELECT event_type,payload FROM crm.monitor_event WHERE payload->>'taskId' IS NOT NULL ORDER BY created_at DESC LIMIT 5\");console.log(JSON.stringify(d.rows,null,1))})"
```
Expected: 最新事件含 `agent-intent-parsed` 且 `payload.taskId` 非空。

- [ ] **Step 3: Commit（用户本地执行）**

```bash
git add src/agent/agentLoop.js
git commit -m "feat(agentLoop): emit intent-parsed trace for reasoning-trace step1"
```

---

## Task 2: 注册 tabs / task-monitor 组件种类

**Files:**
- Modify: `src/page/schema.js:11-13`
- Modify: `src/page/validator.js:39-50`（collapse 分支之后）

- [ ] **Step 1: schema.js 登记新 kind**

```js
export const COMPONENT_KINDS = [
  'metric-card', 'table', 'goal-form', 'result-card', 'reasoning-trace', 'subtable', 'select', 'attr-field',
  'kpi-strip', 'pipeline', 'progress-card', 'collapse', 'contract-matrix', 'tabs', 'task-monitor',
];
```

- [ ] **Step 2: validator.js 跳过粒子护栏（仿 collapse）**

在 `if (comp.kind === 'collapse')` 分支（validator.js:41-46）之后新增：

```js
    // 两 TAB 任务监控（2026-08-29）：tabs 纯布局容器（仿 collapse），task-monitor 自定义数据源，均跳过粒子四护栏
    if (comp.kind === 'tabs') {
      if (!Array.isArray(comp.tabs) || !comp.tabs.length) {
        errors.push(`组件[${i}] tabs 须包含非空 tabs 子组件数组`);
      }
      continue;
    }
    if (comp.kind === 'task-monitor') {
      continue; // 自定义数据源（crm.tasks），不绑定粒子
    }
```

- [ ] **Step 3: 验证 schema 校验通过（手动）**

Run:
```bash
node -e "import('/src/pages/S03.schema.js').then(m=>console.log('S03 schema loaded ok')).catch(e=>{console.error('FAIL',e.message);process.exit(1)})"
```
Expected: 打印 `S03 schema loaded ok`（S03.schema.js 末尾 `validatePageSchema` 校验通过才不抛）。

- [ ] **Step 4: Commit（用户本地执行）**

```bash
git add src/page/schema.js src/page/validator.js
git commit -m "feat(schema): register tabs + task-monitor component kinds"
```

---

## Task 3: renderer 新增 tabs / task-monitor + live reasoning-trace

**Files:**
- Modify: `src/page/renderer.js`（`renderComponent` switch 内，紧邻 `collapse` 分支与 `reasoning-trace` 分支）
- Test: `test/page/renderTabs.test.js`

- [ ] **Step 1: 写失败测试（renderPage 含新结构）**

`test/page/renderTabs.test.js`：
```js
import { test, expect } from 'vitest';
import { renderPage } from '../../src/page/renderer.js';
import { S03_SCHEMA } from '../../src/pages/S03.schema.js';

const data = {
  components: {
    'goal-form': {},
    'task-monitor': { rows: [
      { task_id: 'T1', title: '跟进商机', action: 'followup', status: 'running', owner: 'host-a', updated_at: '2026-08-29 14:00' },
    ] },
    'reasoning-trace': { steps: [ { label: '意图解析' }, { label: '上下文装配' }, { label: '动作编排' } ] },
    'result-card': { items: [ { label: '智能体', value: '4 个' } ] },
    'contract-matrix': { rows: [] },
    'attr-field': {},
  },
};

test('S03 渲染出两 TAB + 任务行 + live 三段', () => {
  const { html, warnings } = renderPage(S03_SCHEMA, data);
  expect(warnings).toEqual([]);
  expect(html).toContain('pg-tab-btn');
  expect(html).toContain('data-tab-panel="monitor"');
  expect(html).toContain('data-tab-panel="detail"');
  expect(html).toContain('data-task-id="T1"');
  expect(html).toContain('data-step="intent"');
  expect(html).toContain('data-step="context"');
  expect(html).toContain('data-step="action"');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/page/renderTabs.test.js`
Expected: FAIL（当前 S03 无 tabs / renderer 无 renderTabs / reasoning-trace 无 live）。

- [ ] **Step 3: 实现 renderTabs + renderTaskMonitor（在 renderer.js 顶部 renderComponent 之前新增函数）**

在 `function renderComponent(comp, data) {` 之前插入：
```js
// 两 TAB 任务监控（2026-08-29）：tabs 布局容器（仿 collapse 递归渲染子组件，透传全量 data）
function renderTabs(comp, data) {
  const tabs = Array.isArray(comp.tabs) ? comp.tabs : [];
  const nav = tabs.map((t, i) =>
    `<button class="pg-tab-btn" type="button" data-tab-btn="${escapeHtml(t.key)}"${i === 0 ? ' data-active="true"' : ''}>${escapeHtml(t.label || t.key)}</button>`
  ).join('');
  const panels = tabs.map((t, i) => {
    const inner = Array.isArray(t.components)
      ? t.components.map((c) => renderComponent(c, resolveDatum(c, data)) + renderActions(c)).join('\n')
      : '';
    return `<div class="pg-tab-panel" data-tab-panel="${escapeHtml(t.key)}"${i === 0 ? '' : ' hidden'}>${inner}</div>`;
  }).join('');
  return `<div class="pg-tabs" style="grid-column:1/-1">
    <div class="pg-tab-nav">${nav}</div>${panels}</div>`;
}

// 任务监控清单（TAB1）：data.rows[] = {task_id,title,action,status,owner,updated_at}；行可点击进入 TAB2
function renderTaskMonitor(comp, data) {
  const rows = Array.isArray(data?.rows) ? data.rows : [];
  const title = comp.title ? `<h3 class="pg-comp-title">${escapeHtml(comp.title)}</h3>` : '';
  if (!rows.length) return `<div class="pg-task-monitor">${title}${stateBlock('empty')}</div>`;
  const cols = ['task_id', 'title', 'action', 'status', 'owner', 'updated_at'];
  const head = cols.map((c) => `<th>${escapeHtml(colLabel(c))}</th>`).join('');
  const body = rows.map((r) =>
    `<tr data-task-id="${escapeHtml(r.task_id || '')}" class="pg-task-row" style="cursor:pointer">
      <td>${escapeHtml(r.task_id || '')}</td><td>${escapeHtml(r.title || '')}</td><td>${escapeHtml(r.action || '')}</td>
      <td data-status-cell>${escapeHtml(r.status || '')}</td><td>${escapeHtml(r.owner || '')}</td><td>${escapeHtml(r.updated_at || '')}</td>
    </tr>`
  ).join('');
  return `<div class="pg-task-monitor">${title}
    <table class="pg-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
    <div class="pg-hint">点击任务行查看执行详情</div></div>`;
}
```

- [ ] **Step 4: 在 renderComponent switch 接入 tabs / task-monitor，改 reasoning-trace 为 live**

`renderComponent` 内：
1. 在 `case 'collapse':` 之后加：
```js
    case 'tabs': return renderTabs(comp, data);
    case 'task-monitor': return renderTaskMonitor(comp, data);
```
2. 改 `case 'reasoning-trace':` 分支为：
```js
    case 'reasoning-trace':
      if (comp.live) {
        const steps = [
          { step: 'intent', label: comp.steps?.[0]?.label || '意图解析' },
          { step: 'context', label: comp.steps?.[1]?.label || '上下文装配' },
          { step: 'action', label: comp.steps?.[2]?.label || '动作编排' },
        ];
        return `<div class="pg-trace-wrap" data-kind="reasoning-trace">
          <h3 class="pg-comp-title">${escapeHtml(comp.title || '思考链执行过程')}</h3>
          <ol class="pg-trace">${steps.map((s) =>
            `<li data-trace-step data-step="${s.step}" data-status="idle">${escapeHtml(s.label)}<span class="pg-dot"></span></li>`
          ).join('')}</ol>
          <div class="pg-trace-meta" data-task-id=""></div>
          <div class="pg-event-log" data-event-log></div>
        </div>`;
      }
      return `<ol class="pg-trace">${(comp.steps || []).map((s) => `<li data-trace-step="${escapeHtml(s.status || '')}">${escapeHtml(s.label || '')}</li>`).join('') || '<li>（空 trace）</li>'}</ol>`;
```

- [ ] **Step 5: renderPage 让 tabs 透传全量 data（仿 collapse）**

改 `src/page/renderer.js:397`：
```js
    const cd = (comp.kind === 'collapse' || comp.kind === 'tabs') ? data : resolveDatum(comp, data);
```

- [ ] **Step 6: 运行测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/page/renderTabs.test.js`
Expected: PASS。

- [ ] **Step 7: Commit（用户本地执行）**

```bash
git add src/page/renderer.js test/page/renderTabs.test.js
git commit -m "feat(renderer): tabs + task-monitor + live reasoning-trace"
```

---

## Task 4: S03.schema.js 重构为两 TAB

**Files:**
- Modify: `src/pages/S03.schema.js`（整体替换为单 `tabs` 组件）

- [ ] **Step 1: 替换 schema.components 为 tabs 结构**

完整文件内容（保留顶部 import/校验）：
```js
// src/pages/S03.schema.js — S03 智能体工作台（/workspace）
// 2026-08-29 重构：两 TAB（任务监控台 / 任务执行详情）；详见 docs/2026-08-29-agent-workbench-twotab-trace-design.md
// TAB1 任务监控台：goal-form(指令→/api/page/from-nl) + task-monitor(运行中任务) + contract-matrix(合规) + result-card + attr-field
// TAB2 任务执行详情：reasoning-trace(live，按 taskId 订阅 SSE trace + 回放端点)
import { validatePageSchema } from '../page/validator.js';

export const schema = {
  type: 'workspace',
  title: '智能体工作台',
  navigation: { to: '/workspace' },
  layout: { columns: 1, theme: 'light' },
  components: [
    {
      kind: 'tabs',
      tabs: [
        {
          key: 'monitor',
          label: '任务监控台',
          components: [
            {
              kind: 'goal-form',
              action: 'POST /api/page/from-nl',
              placeholder: '向智能体下达指令（如：跟进本周逾期商机）',
              label: '指令输入',
            },
            {
              kind: 'task-monitor',
              title: '运行中的任务',
              dataBinding: { source: 'task' },
            },
            {
              kind: 'contract-matrix',
              title: '契约合规矩阵',
              dataBinding: { source: 'contract', columns: ['task', 'agent', 'skill_ok', 'memory_ok', 'success', 'op'] },
            },
            {
              kind: 'result-card',
              title: '最近动作结果',
            },
            {
              kind: 'attr-field',
              attrSlug: 'deal_note',
              attrType: 'text',
              label: '商机备注（表单注入）',
              attr: { slug: 'deal_note', data_origin: 'manual' },
            },
          ],
        },
        {
          key: 'detail',
          label: '任务执行详情',
          components: [
            {
              kind: 'reasoning-trace',
              live: true,
              title: '思考链执行过程',
              steps: [
                { label: '意图解析' },
                { label: '上下文装配' },
                { label: '动作编排' },
              ],
            },
          ],
        },
      ],
    },
  ],
};

const v = validatePageSchema(schema);
if (!v.ok) throw new Error('S03 schema 非法: ' + v.errors[0]);
```

- [ ] **Step 2: 确认 schema 加载通过**

Run: `node -e "import('/src/pages/S03.schema.js').then(()=>console.log('ok')).catch(e=>{console.error(e.message);process.exit(1)})"`
Expected: `ok`。

- [ ] **Step 3: Commit（用户本地执行）**

```bash
git add src/pages/S03.schema.js
git commit -m "feat(S03): restructure into two-tab task monitor + detail"
```

---

## Task 5: routes 加 taskList + 回放端点

**Files:**
- Modify: `src/http/routes.js:639-673`（S03 data 加 taskList）
- Modify: `src/http/routes.js`（在 contract-matrix 端点之后新增 trace 回放端点）

依赖：`query` 已在 routes.js 顶层导入（读池）。`listTasks` 已导入（routes.js:5）。

- [ ] **Step 1: S03 data 增加 taskList（活跃优先排序）**

改 `src/http/routes.js` 的 `/api/page/agent-workbench` 处理器，在 `const tasks = await listTasks(...)` 之后新增 taskList 构造，并在 `data.components` 增加 `'task-monitor'`：

```js
      const tasks = await listTasks({ tenantId: 'system' });
      const ACTIVE = ['ready', 'running', 'awaiting_confirm', 'blocked'];
      const taskList = tasks
        .map((t) => ({
          task_id: t.id,
          title: t.title || '',
          action: t.action_name || t.step || '',
          status: t.status || '',
          owner: t.worker_host || '—',
          updated_at: t.updated_at ? String(t.updated_at).slice(0, 19) : '',
        }))
        .sort((a, b) => (ACTIVE.includes(b.status) ? 1 : 0) - (ACTIVE.includes(a.status) ? 1 : 0));
      const asm = await assertAgentAssembly();
      const agentKeys = Object.keys(agentSpecs);
      let matrixRows = [];
      try { matrixRows = await computeCompliance(DEFAULT_CONTRACT_DOC); } catch {}
      const rows = tasks.map((t) => ({
        task_id: t.id,
        type: t.action_name || t.step || '',
        status: t.status || '',
        created_at: t.created_at ? String(t.updated_at).slice(0, 19) : '',
      }));
      const data = {
        components: {
          'goal-form': {},
          'task-monitor': { rows: taskList },
          'reasoning-trace': { steps: S03_SCHEMA.components.find((c) => c.kind === 'tabs')?.tabs?.find((t) => t.key === 'detail')?.components?.find((x) => x.kind === 'reasoning-trace')?.steps || [] },
          'result-card': {
            items: [
              { label: '智能体', value: `${agentKeys.length} 个` },
              { label: '装配状态', value: asm && asm.ok ? '健康' : '异常' },
              { label: '活跃任务', value: `${taskList.filter((t) => ACTIVE.includes(t.status)).length} 条` },
            ],
          },
          table: { rows },
          'attr-field': {},
          'contract-matrix': { rows: matrixRows },
        },
      };
```

- [ ] **Step 2: 新增 trace 回放端点（紧跟 `/api/agent-monitor/success` 之后）**

```js
  // 单任务 trace 回放（B-γ 详情 TAB）：从 monitor_event 按 payload.taskId 回放历史阶段 + 当前任务状态
  app.get('/api/agent-monitor/trace/:taskId', async (req, res) => {
    try {
      const { taskId } = req.params;
      const evs = await query(
        `SELECT event_type, payload, created_at FROM crm.monitor_event WHERE payload->>'taskId'=$1 ORDER BY created_at`,
        [taskId]
      );
      const t = await query('SELECT status FROM crm.tasks WHERE id=$1', [taskId]);
      const phases = evs.rows.map((r) => ({
        phase: r.event_type,
        taskId: r.payload?.taskId,
        ts: String(r.created_at).slice(0, 19),
      }));
      res.json({ ok: true, taskId, status: t.rows[0]?.status || 'unknown', phases });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
```

- [ ] **Step 3: 验证端点（手动）**

Run（server 已起）：`curl -s "http://localhost:3000/api/agent-monitor/trace/<某 taskId>" | head -c 400`
Expected: 返回 `{ok:true,taskId,status,phases:[...]}`，phases 含 intent-parsed/context-injected/loop-*。

- [ ] **Step 4: Commit（用户本地执行）**

```bash
git add src/http/routes.js
git commit -m "feat(routes): S03 taskList + trace replay endpoint"
```

---

## Task 6: 前端两 TAB 交互 + SSE

**Files:**
- Modify: `src/web/agent-workbench.html`（在现有 `<script>` 内扩展；保留 goal-form / contract-matrix 标记逻辑）

- [ ] **Step 1: 在 `connectSse()` 之前新增 tab 切换 + 任务行点击 + 回放逻辑**

在 `load();` 之后、`connectSse();` 之前插入：
```js
let selectedTaskId = null;
let activeTab = 'monitor';

// TAB 切换（声明式 data-tab-btn）
document.addEventListener('click', (e) => {
  const btn = e.target.closest && e.target.closest('[data-tab-btn]');
  if (!btn) return;
  activeTab = btn.getAttribute('data-tab-btn');
  document.querySelectorAll('[data-tab-btn]').forEach((b) => b.toggleAttribute('data-active', b === btn));
  document.querySelectorAll('[data-tab-panel]').forEach((p) =>
    (p.hidden = p.getAttribute('data-tab-panel') !== activeTab));
});

// 任务行点击 → 进入详情 TAB + 拉回放
document.addEventListener('click', (e) => {
  const row = e.target.closest && e.target.closest('[data-task-id]');
  if (!row) return;
  selectedTaskId = row.getAttribute('data-task-id');
  if (!selectedTaskId) return;
  activeTab = 'detail';
  document.querySelectorAll('[data-tab-btn]').forEach((b) => b.toggleAttribute('data-active', b.getAttribute('data-tab-btn') === 'detail'));
  document.querySelectorAll('[data-tab-panel]').forEach((p) => (p.hidden = p.getAttribute('data-tab-panel') !== 'detail'));
  loadTrace(selectedTaskId);
});

// 回放历史阶段 + 初始填充（补漏 SSE 内存总线已发生事件）
async function loadTrace(taskId) {
  const wrap = document.querySelector('.pg-trace-wrap');
  const meta = document.querySelector('.pg-trace-meta');
  const log = document.querySelector('[data-event-log]');
  if (meta) meta.setAttribute('data-task-id', taskId);
  if (log) log.innerHTML = '';
  try {
    const r = await fetch('/api/agent-monitor/trace/' + encodeURIComponent(taskId));
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    if (meta) meta.textContent = `任务 ${taskId} · 状态 ${j.status || 'unknown'}`;
    (j.phases || []).forEach((p) => applyPhase(p.phase, p.ts, log));
  } catch (err) {
    if (meta) meta.textContent = '回放失败: ' + err.message;
  }
}

// 阶段 → 三段上色（①intent ②context ③action）
function applyPhase(phase, ts, log) {
  const map = {
    'agent-intent-parsed': 'intent',
    'agent-context-injected': 'context',
    'agent-loop-started': 'action',
    'agent-loop-done': 'action',
    'agent-loop-failed': 'action',
  };
  const step = map[phase];
  if (step) {
    const li = document.querySelector(`.pg-trace li[data-step="${step}"]`);
    if (li) {
      if (phase === 'agent-loop-failed') li.setAttribute('data-status', 'failed');
      else if (phase === 'agent-loop-done') li.setAttribute('data-status', 'ok');
      else if (step === 'action' && phase === 'agent-loop-started') li.setAttribute('data-status', 'running');
      else li.setAttribute('data-status', 'ok');
    }
  }
  if (log) {
    const line = document.createElement('div');
    line.className = 'pg-event-line';
    line.textContent = `${ts || ''} · ${phase}`;
    log.appendChild(line);
  }
}
```

- [ ] **Step 2: 扩展 SSE 处理（task 域补状态 + trace 域实时上色）**

替换 `connectSse()` 内 `es.onmessage`：
```js
  es.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.domain === 'trace' && selectedTaskId && msg.payload?.taskId === selectedTaskId) {
        applyPhase(msg.type, new Date().toISOString().slice(0, 19).replace('T', ' '), document.querySelector('[data-event-log]'));
        return;
      }
      if (msg.domain === 'task') {
        // 补 TAB1 状态格（避免全量 reload 丢失 TAB2 选择）
        const row = document.querySelector(`[data-task-id="${msg.payload?.id}"]`);
        if (row) { const c = row.querySelector('[data-status-cell]'); if (c && msg.type) c.textContent = msg.type; }
        if (activeTab === 'monitor' && !selectedTaskId) load();
        return;
      }
    } catch (e) { /* 忽略心跳 */ }
  };
```

- [ ] **Step 3: 加两 TAB 样式（在 `<style>` 内追加）**

在 `</style>` 前追加：
```css
  .pg-tabs { border: 1px solid var(--line); border-radius: 8px; background: var(--panel); padding: 10px; }
  .pg-tab-nav { display: flex; gap: 8px; margin-bottom: 10px; border-bottom: 1px solid var(--line); padding-bottom: 8px; }
  .pg-tab-btn { padding: 6px 14px; border: 1px solid var(--line); background: var(--bg); border-radius: 6px; cursor: pointer; font-size: 13px; }
  .pg-tab-btn[data-active="true"] { background: var(--ac); color: #fff; border-color: var(--ac); }
  .pg-tab-panel[hidden] { display: none; }
  .pg-task-row:hover { background: var(--bg); }
  .pg-hint { font-size: 12px; color: var(--mut); margin-top: 6px; }
  .pg-trace li { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px dashed var(--panel); }
  .pg-trace li[data-status="idle"] { color: var(--mut); }
  .pg-trace li[data-status="ok"] { color: #16a34a; }
  .pg-trace li[data-status="running"] { color: #2563eb; }
  .pg-trace li[data-status="failed"] { color: #dc2626; }
  .pg-trace .pg-dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; margin-left: auto; }
  .pg-trace-meta { font-size: 13px; color: var(--mut); margin: 6px 0; }
  .pg-event-log { font-size: 12px; color: var(--mut); max-height: 160px; overflow: auto; border-top: 1px solid var(--line); padding-top: 6px; }
  .pg-event-line { padding: 2px 0; }
```

- [ ] **Step 4: 验证（手动浏览器）**

Run: 起 server，打开 `/workspace`（agent-workbench.html），确认：
- TAB1 显示任务清单 + 契约矩阵；TAB2 显示三段（灰）。
- 点某 running 任务行 → 切到 TAB2，三段随 trace 实时亮/灰/红，事件流追加。

- [ ] **Step 5: Commit（用户本地执行）**

```bash
git add src/web/agent-workbench.html
git commit -m "feat(ui): S03 two-tab switching + live task trace via SSE"
```

---

## Task 7: 端到端验证

- [ ] **Step 1: 跑 renderer 单测**
```bash
node node_modules/vitest/vitest.mjs run test/page/renderTabs.test.js
```
Expected: PASS。

- [ ] **Step 2: 跑 S03 schema 加载**
```bash
node -e "import('/src/pages/S03.schema.js').then(()=>console.log('S03 ok')).catch(e=>{console.error(e.message);process.exit(1)})"
```
Expected: `S03 ok`。

- [ ] **Step 3: 起 server + 浏览器验证两 TAB（按 Task 6 Step 4）**

- [ ] **Step 4: 确认契约矩阵未回归（目标 1）**
打开 `/workspace` TAB1 契约合规矩阵应为 4 行全绿（目标 1 已验证，本改动不应破坏）。

---

## Self-Review（已执行）

1. **Spec 覆盖**：§2 两 TAB → Task 4/6；§3 三段映射 → Task 1(intent-parsed)+Task 6(applyPhase)；§4 改动清单 #1-#6 → Task 1/2/3/4/5/6；§5 回放端点 → Task 5；§6 前端 → Task 6；§7 验证 → Task 7。无遗漏。
2. **Placeholder 扫描**：无 TBD/TODO；每步含完整代码与命令。
3. **类型一致性**：`applyPhase` 的 `map` 键与 agentLoop emit 事件名一致（intent-parsed/context-injected/loop-started/done/failed）；`data-task-id` 在 renderer(task-monitor) 与前端(click/SSE) 一致；回放端点 `payload->>'taskId'` 与 agentEpisodes 写入 `payload:{taskId}` 一致。
