# 告警模块复用·挪出「指名客户管理」 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「指名客户管理 → 告警提醒」里的两类告警（🔴应访未访 / 🟠长期失联）抽为复用渲染纯函数，分别展示在工作台首页（`/`）客户跟踪业务区顶部的 4 张 KPI 卡，以及客户跟踪页（`/named-accounts.html`）顶部的完整告警表格。

**Architecture:** 新增浏览器+vitest 共用的零 DB 渲染纯函数模块 `src/portal/followReminder.js`（范式对齐 `alertRuleConfigRender.js`）。工作台与客户跟踪页经 `/portal/followReminder.js` ESM 加载该模块，各自 fetch 既有端点 `/api/board/named-account-manage` 取数据填充。S02 受控渲染因 renderer 不支持“裸 mount 节点”组件，改为在 `index.html` 客户端脚本注入 KPI 挂载区（守住“零新增渲染代码”铁律）。

**Tech Stack:** Node 22 ESM + Express 4 + vitest 3（同源测试范式 `createApp().fetch`）。前端：原生 ESM 浏览器模块 + tokens.css 语义变量（零硬编码色值铁律）。

---

## 设计偏差声明（必须阅读）

设计文档 `docs/2026-08-31-follow-reminder-extract-design.md` §4 列了 7 个文件含 `src/pages/S02.schema.js` 的修改。实施时**不修改 `S02.schema.js`**，原因：

- S02 是受控渲染 schema，`renderPage` 的 `renderCollapse`（`src/page/renderer.js:286`）只把 `comp.title/components` 渲染成 `<details class="pg-collapse"><summary>…</summary><div class="pg-collapse-body">…</div></details>`，**没有“原生 HTML 挂载节点”组件 kind**。往 schema 里加裸 `<div id="follow-kpi-mount">` 会被 renderer 忽略（未知字段不落 DOM）。
- 工作记忆铁律：“渲染器原生支持 kpi-strip/pipeline/progress-card/collapse/table，零新增渲染代码”。新增组件 kind 需改 renderer，违反此铁律。

**替代方案（本计划采用，用户可见结果等价）：** 在 `src/web/index.html` 客户端脚本里，待 S02 HTML 注入 `#home-root` 后，用 JS 找到“客户跟踪”collapse 并向其 `.pg-collapse-body` 最前插入 KPI 挂载区。这是 faithful 的“客户跟踪业务区最前嵌入 KPI 卡”实现，且不触碰受控渲染内核。

`named-account-manage.html` 的既有 `renderAlerts` **不重构**（仍自用，避免回归）；新模块供 `index.html` 与 `named-accounts.html` 复用，未来可统一。

---

## 文件结构

| 文件 | 操作 | 职责 |
|---|---|---|
| `src/portal/followReminder.js` | 新建 | `renderFollowKpis(j)` 4 张 KPI 卡 + `renderFollowTable(rows)` 两类告警表；零 DB / 零服务端 import；内联 `esc` |
| `test/portal/follow-reminder.test.js` | 新建 | 纯函数单测：KPI 4 卡 / 表格两类去重 / 零数据退化 / HTML 转义 |
| `src/http/routes.js` | 修改 | 在 `alertRuleConfigRender.js` 静态映射（~2502）后追加 `/portal/followReminder.js`（`Content-Type: text/javascript`） |
| `test/http/follow-reminder-mount.test.js` | 新建 | 路由可达 200 + 跨页契约（named-accounts.html 含 `follow-table-host`、index.html 引用模块、home 无回归） |
| `src/web/index.html` | 修改 | import 模块 + 注入 KPI 挂载区 + fetch 填充 |
| `src/web/named-accounts.html` | 修改 | `<section id="follow-table-host">` + import 模块 + `mountFollowTable()` 填充 |

---

## Task 1: 新建 `followReminder.js` 渲染纯函数 + 单测

**Files:**
- Create: `src/portal/followReminder.js`
- Test: `test/portal/follow-reminder.test.js`

- [ ] **Step 1: 写失败单测**

```js
// test/portal/follow-reminder.test.js
import { describe, it, expect } from 'vitest';
import { renderFollowKpis, renderFollowTable } from '../../src/portal/followReminder.js';

const row = (over) => ({
  id: 'a1', name: '客户甲', owner: 'alice', tier: '重点',
  alert: over ? 'red' : null, overdueDays: over ? 12 : 0,
  visitDue: '2026-08-01', visitTarget: 2, visits30: 0,
  lostContact: !over, lastContactDays: !over ? 95 : null,
});

describe('renderFollowKpis', () => {
  it('应访未访>0 时红卡 + 跳指名客户管理', () => {
    const html = renderFollowKpis({ rows: [row(true)], lostContactCount: 0 });
    expect(html).toContain('应访未访');
    expect(html).toContain('class="fkpi warn"');
    expect(html).toContain('href="/named-account-manage.html"');
  });
  it('失联>0 时橙卡计数', () => {
    const html = renderFollowKpis({ rows: [row(false)], lostContactCount: 1 });
    expect(html).toContain('长期失联');
    expect(html).toContain('>1<');
  });
  it('最近逾期 = 多红取 max(overdueDays)', () => {
    const html = renderFollowKpis({ rows: [row(true), { ...row(true), overdueDays: 30 }], lostContactCount: 0 });
    expect(html).toContain('30 天');
  });
  it('查看完整卡恒存在并跳 named-accounts', () => {
    const html = renderFollowKpis({ rows: [], lostContactCount: 0 });
    expect(html).toContain('查看完整');
    expect(html).toContain('href="/named-accounts.html"');
  });
  it('零数据退化为达标灰（无 warn 类）', () => {
    const html = renderFollowKpis({ rows: [], lostContactCount: 0 });
    expect(html).not.toContain('class="fkpi warn"');
  });
});

describe('renderFollowTable', () => {
  it('两类子表 + 去重（既红又失联只进红）', () => {
    const both = { id: 'x', name: '双告警', owner: 'alice', tier: '重点', alert: 'red', overdueDays: 5, visitDue: '2026-08-01', visitTarget: 2, visits30: 0, lostContact: true, lastContactDays: 99 };
    const html = renderFollowTable([both, row(false)]);
    expect(html).toContain('🔴 应访未访');
    expect(html).toContain('🟠 长期失联');
    // 双告警客户只出现一次（在红表），失联表只剩 row(false) 共 2 行 → 客户甲/双告警/客户乙
    const count = (html.match(/<tr>/g) || []).length;
    expect(count).toBe(2);
  });
  it('零告警返回空态', () => {
    expect(renderFollowTable([])).toContain('暂无逾期');
  });
  it('HTML 转义客户名', () => {
    const html = renderFollowTable([{ id: 'x', name: '<b>evil</b>', owner: 'a', alert: 'red', overdueDays: 1 }]);
    expect(html).not.toContain('<b>evil</b>');
    expect(html).toContain('&lt;b&gt;evil&lt;/b&gt;');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/portal/follow-reminder.test.js`
Expected: FAIL（模块不存在 → 导入错误）

- [ ] **Step 3: 实现模块**

```js
// src/portal/followReminder.js — 客户跟踪告警复用渲染纯函数（浏览器 + vitest 共用，零 DB / 零服务端 import）
// 复用范式：alertRuleConfigRender.js（仅渲染纯函数，页面经 /portal/followReminder.js ESM 加载）
// 数据契约：GET /api/board/named-account-manage → { rows, followReminders, lostContactCount }
//   rows[].{ id, name, owner, tier, alert('red'|'yellow'|null), overdueDays, visitDue,
//            visitTarget, visits30, lostContact, lastContactDays }
// 色值一律走 tokens 语义变量（--err / --ok / --ink / --mut / --panel / --line），零硬编码。

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 4 张 KPI 摘要卡（工作台客户跟踪业务区顶部）
// 语义：>0 染色 + 跳链；0/无数据退化为达标灰
export function renderFollowKpis(j = {}) {
  const rows = Array.isArray(j.rows) ? j.rows : [];
  const redCount = rows.filter((r) => r.alert === 'red').length;
  const lostCount = Number(j.lostContactCount || 0);
  const overdues = rows.filter((r) => r.alert === 'red').map((r) => Number(r.overdueDays || 0));
  const maxOverdue = overdues.length ? Math.max(...overdues) : 0;
  const card = (icon, label, val, cls, href) =>
    `<a class="fkpi ${cls}" ${href ? `href="${href}"` : ''}>` +
      `<div class="k-label">${icon} ${esc(label)}</div>` +
      `<div class="k-val">${esc(val)}</div>` +
    `</a>`;
  return [
    card('🔴', '应访未访', redCount, redCount > 0 ? 'warn' : '', '/named-account-manage.html'),
    card('🟠', '长期失联', lostCount, lostCount > 0 ? 'warn' : '', '/named-account-manage.html'),
    card('⏰', '最近逾期', maxOverdue > 0 ? maxOverdue + ' 天' : '无', maxOverdue > 0 ? 'warn' : '', '/named-account-manage.html'),
    `<a class="fkpi" href="/named-accounts.html"><div class="k-label">📋 查看完整</div><div class="k-val" style="font-size:14px">前往 →</div></a>`,
  ].join('');
}

// 完整告警表格（两类子表：🔴 应访未访 / 🟠 长期失联）
// 去重：既逾期又失联只进红（与端点 followReminders 去重口径一致）
export function renderFollowTable(rows = []) {
  const list = Array.isArray(rows) ? rows : [];
  const reds = list.filter((r) => r.alert === 'red');
  const losts = list.filter((r) => r.lostContact && r.alert !== 'red');
  if (!reds.length && !losts.length) return '<div class="muted">暂无逾期 / 失联提醒</div>';
  const rowHtml = (r, kind) => `<tr>
    <td><a href="/account-360.html?id=${esc(r.id)}">${esc(r.name)}</a></td>
    <td>${esc(r.owner)}</td>
    <td>${kind === 'red'
      ? `<span class="warn">逾期 ${r.overdueDays != null ? esc(r.overdueDays) + ' 天' : '—'}</span>`
      : `<span class="warn">失联 ${r.lastContactDays != null ? esc(r.lastContactDays) + ' 天无拜访' : '—'}</span>`}</td>
    <td>${r.visitDue ? new Date(r.visitDue).toLocaleDateString('zh-CN') : '—'}</td>
    <td>${r.visitTarget != null ? esc(r.visitTarget) + ' 次' : '—'} / 实际 ${r.visits30 ?? 0}</td>
    <td><a href="/account-360.html?id=${esc(r.id)}">去拜访 →</a></td>
  </tr>`;
  const table = (title, items, kind) => (items.length
    ? `<h4 class="muted" style="margin:14px 0 6px">${title}（${items.length}）</h4>
       <table><thead><tr><th>客户</th><th>销售</th><th>状态</th><th>应访日</th><th>应访/实际</th><th>操作</th></tr></thead>
       <tbody>${items.map((r) => rowHtml(r, kind)).join('')}</tbody></table>`
    : '');
  return table('🔴 应访未访', reds, 'red') + table('🟠 长期失联', losts, 'lost');
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/portal/follow-reminder.test.js`
Expected: PASS（9 用例全绿）

- [ ] **Step 5: 提交**

```bash
git add src/portal/followReminder.js test/portal/follow-reminder.test.js
git commit -m "feat(follow-reminder): 新增复用渲染纯函数 renderFollowKpis/renderFollowTable"
```

---

## Task 2: 注册 `/portal/followReminder.js` 静态路由

**Files:**
- Modify: `src/http/routes.js`（在 `app.get('/portal/alertRuleConfigRender.js', …)` 之后，~2503 行）
- Test: `test/http/follow-reminder-mount.test.js`（本 Task 先写路由检查部分）

> ⚠️ **server 重启铁律**：`app.get` 在 `createApp()` 时一次性注册进内存。本 Task 改 `routes.js` 新增路由，**部署后必须重启 server**，否则 `GET /portal/followReminder.js` 404。改 `src/portal/*.js` 源文件本身不需重启（走 `sendFile` 读磁盘）。

- [ ] **Step 1: 写失败路由测试（先建文件，仅路由检查）**

```js
// test/http/follow-reminder-mount.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import { createApp } from '../../src/http/server.js';

let app;
beforeAll(() => { app = createApp(); });

describe('GET /portal/followReminder.js 静态可达', () => {
  it('返回 200 且 Content-Type 为 text/javascript', async () => {
    const res = await app.fetch('/portal/followReminder.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') || '').toContain('text/javascript');
    const body = await res.text();
    expect(body).toContain('renderFollowKpis');
    expect(body).toContain('renderFollowTable');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/http/follow-reminder-mount.test.js`
Expected: FAIL（404）

- [ ] **Step 3: 在 routes.js 注册静态映射**

在 `src/http/routes.js` 的 `app.get('/portal/alertRuleConfigRender.js', …)` 之后插入：

```js
  // 客户跟踪告警复用渲染纯函数（2026-08-31 抽离：工作台 + 客户跟踪页共用）
  app.get('/portal/followReminder.js', (req, res) => {
    res.sendFile(fileURLToPath(new URL('../portal/followReminder.js', import.meta.url)), { headers: { 'Content-Type': 'text/javascript' } });
  });
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run test/http/follow-reminder-mount.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/http/routes.js test/http/follow-reminder-mount.test.js
git commit -m "feat(follow-reminder): 注册 /portal/followReminder.js 静态路由"
```

---

## Task 3: 工作台首页（`/`）KPI 卡挂载

**Files:**
- Modify: `src/web/index.html`（`<script type="module">` 段 + `<style>` 段）

- [ ] **Step 1: 在 `<style>` 段追加 KPI 卡样式（零硬编码，走 tokens）**

在 `index.html` 的 `<style>`（第 9–24 行之间）追加：

```css
 /* 客户跟踪告警 KPI 卡（2026-08-31 抽离复用） */
 .follow-kpi-panel{margin:10px 0 6px}
 .follow-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
 .fkpi{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px;color:var(--ink);text-decoration:none;display:block}
 .fkpi .k-label{font-size:12px;color:var(--mut)}
 .fkpi .k-val{font-size:24px;font-weight:700;margin-top:4px}
 .fkpi.warn .k-val{color:var(--err)}
 .fkpi.ok .k-val{color:var(--ok)}
```

- [ ] **Step 2: 在模块脚本顶部追加 import**

把第 49–50 行：
```js
import { get, post, put } from '/portal/api.js';
import { injectLayout } from '/portal/layout.js';
```
改为：
```js
import { get, post, put } from '/portal/api.js';
import { injectLayout } from '/portal/layout.js';
import { renderFollowKpis } from '/portal/followReminder.js';
```

- [ ] **Step 3: 注入 + 填充逻辑（放在 `escapeHtml` 函数之后）**

在 `function escapeHtml(v) { … }` 之后追加：

```js
// ── 客户跟踪告警 KPI 卡（2026-08-31 抽离复用）──
// 受控渲染 renderer 不支持裸 mount 节点 → 客户端注入到 S02「客户跟踪」collapse 最前
function injectFollowKpiPanel() {
  const root = document.getElementById('home-root');
  if (!root) return;
  if (document.getElementById('follow-kpi-mount')) return; // 幂等
  const details = [...root.querySelectorAll('details.pg-collapse')]
    .find((d) => (d.querySelector('summary')?.textContent || '').includes('客户跟踪'));
  if (!details) return;
  const body = details.querySelector('.pg-collapse-body');
  if (!body) return;
  const sec = document.createElement('section');
  sec.className = 'follow-kpi-panel';
  sec.innerHTML = '<h3 class="pg-comp-title">🔔 客户跟踪告警</h3><div class="follow-kpis" id="follow-kpi-mount"></div>';
  body.insertBefore(sec, body.firstChild);
}
async function mountFollowKpis() {
  const host = document.getElementById('follow-kpi-mount');
  if (!host) return;
  try {
    const j = await get('/api/board/named-account-manage');
    host.innerHTML = renderFollowKpis(j);
  } catch { /* 静默：未登录/异常不破坏 S02 既有内容 */ }
}
```

- [ ] **Step 4: 在 home-root 注入后调用**

把第 70–79 行的 home-root IIFE：
```js
(async () => {
  const root = document.getElementById('home-root');
  try {
    const j = await get('/api/page/home');
    if (j.html) root.innerHTML = j.html;
    else root.innerHTML = '<div class="pg-state" data-state="error">首页出片为空</div>';
  } catch (e) {
    root.innerHTML = `<div class="pg-state" data-state="error">首页受控渲染失败：${escapeHtml(e.message)}</div>`;
  }
})();
```
改为（在 `root.innerHTML = j.html` 之后调用注入+填充）：
```js
(async () => {
  const root = document.getElementById('home-root');
  try {
    const j = await get('/api/page/home');
    if (j.html) { root.innerHTML = j.html; injectFollowKpiPanel(); await mountFollowKpis(); }
    else root.innerHTML = '<div class="pg-state" data-state="error">首页出片为空</div>';
  } catch (e) {
    root.innerHTML = `<div class="pg-state" data-state="error">首页受控渲染失败：${escapeHtml(e.message)}</div>`;
  }
})();
```

- [ ] **Step 5: 回归 S02 首页测试**

Run: `npx vitest run test/http/home-page.test.js`
Expected: PASS（S02 受控渲染无回归）

- [ ] **Step 6: 提交**

```bash
git add src/web/index.html
git commit -m "feat(follow-reminder): 工作台首页客户跟踪区挂载 4 张告警 KPI 卡"
```

---

## Task 4: 客户跟踪页（`/named-accounts.html`）顶部告警表

**Files:**
- Modify: `src/web/named-accounts.html`（`<body>` 结构 + `<script>` 段）

- [ ] **Step 1: 在 `page-head` 与 `nav.tabs` 之间插入挂载区**

把第 102–111 行：
```html
  </header>

  <nav class="tabs">
```
改为：
```html
  </header>

  <section id="follow-table-host" class="follow-host"></section>

  <nav class="tabs">
```

- [ ] **Step 2: 在模块脚本顶部追加 import**

把第 139–140 行：
```js
  import { injectLayout } from '/portal/layout.js';
  import { api, me } from '/portal/api.js';
```
改为：
```js
  import { injectLayout } from '/portal/layout.js';
  import { api, me } from '/portal/api.js';
  import { renderFollowTable } from '/portal/followReminder.js';
```

- [ ] **Step 3: 新增 `mountFollowTable()` 并在 `load()` 内调用**

在 `function esc(s) { … }` 之后追加：
```js
  // 客户跟踪页顶部告警表（2026-08-31 抽离复用，数据源 = /api/board/named-account-manage）
  async function mountFollowTable() {
    const host = document.getElementById('follow-table-host');
    if (!host) return;
    try {
      const j = await api('/api/board/named-account-manage');
      host.innerHTML = renderFollowTable(j.rows);
    } catch { host.innerHTML = '<div class="muted">告警加载失败</div>'; }
  }
```

在 `load()` 的 try 块内、`renderBoard(currentRows, lastSummary);` 之后（第 413 行附近）追加一行：
```js
      renderBoard(currentRows, lastSummary);
      mountFollowTable(); // 顶部告警表（独立于主看板，并行填充）
```

- [ ] **Step 4: 回归客户跟踪页相关测试**

Run: `npx vitest run test/http/named-accounts-cov.test.js test/http/named-account-manage-board.test.js`
Expected: PASS（既有契约无回归；新挂载区是纯前端增量）

- [ ] **Step 5: 提交**

```bash
git add src/web/named-accounts.html
git commit -m "feat(follow-reminder): 客户跟踪页顶部插入完整告警表格"
```

---

## Task 5: 跨页契约 + 回归测试补全

**Files:**
- Modify: `test/http/follow-reminder-mount.test.js`（在 Task 2 的路由检查后追加跨页/回归断言）

- [ ] **Step 1: 追加跨页契约与回归用例**

在 `test/http/follow-reminder-mount.test.js` 末尾追加：

```js
describe('跨页契约', () => {
  it('客户跟踪页含 follow-table-host 挂载区', async () => {
    const res = await app.fetch('/named-accounts.html');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="follow-table-host"');
    expect(html).toContain('/portal/followReminder.js'); // 已 import 复用模块
  });
  it('工作台首页引用复用模块', async () => {
    const res = await app.fetch('/');
    const html = await res.text();
    expect(html).toContain('/portal/followReminder.js');
  });
  it('S02 首页受控渲染无回归（客户跟踪 collapse 仍在）', async () => {
    const res = await app.fetch('/api/page/home');
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.html).toContain('客户跟踪');
  });
});
```

- [ ] **Step 2: 运行全部本计划新增测试**

Run: `npx vitest run test/portal/follow-reminder.test.js test/http/follow-reminder-mount.test.js`
Expected: PASS（全部）

- [ ] **Step 3: 提交**

```bash
git add test/http/follow-reminder-mount.test.js
git commit -m "test(follow-reminder): 跨页契约 + S02 回归守卫"
```

---

## Task 6: 全量回归 + 交付核对

**Files:** 无新增（仅运行 + 报告）

- [ ] **Step 1: 运行相关回归套件（避免并发会话污染伪象）**

Run:
```bash
npx vitest run test/portal/follow-reminder.test.js test/http/follow-reminder-mount.test.js test/http/home-page.test.js test/http/named-account-manage-board.test.js test/http/named-accounts-cov.test.js
```
Expected: 全绿。若其它文件出现 `failed`，先单独重跑该文件确认是否为并发会话种子污染伪象（与本计划零交集）。

- [ ] **Step 2: 部署提醒（铁律）**

告知用户：本计划改了 `src/http/routes.js`（新增 `/portal/followReminder.js` 路由），**部署后必须重启 server**（npm start / 进程重启），否则浏览器 `import '/portal/followReminder.js'` 报 404、KPI 卡与顶部告警表不渲染。改 `src/portal/followReminder.js` / `src/web/*.html` 源文件本身不需重启（走 `sendFile` 读磁盘）。

---

## 自检（Self-Review）

**1. 设计覆盖**
- §1.2 复用渲染纯函数 → Task 1 ✅
- §2 工作台集成（4 KPI 卡）→ Task 3 ✅（S02.schema.js 偏差已声明并等价替代）
- §3 客户跟踪页集成（顶部完整表）→ Task 4 ✅
- §4 文件清单 → 7 文件对应 6 Task（S02.schema.js 偏差声明）✅
- §6 验收：首页 KPI 卡 / 跳链 / 客户跟踪页顶部表 / 纯函数单测 / 路由可达 / 视觉 tokens / 全量回归 → Task 1/2/3/4/5/6 覆盖 ✅

**2. 占位符扫描**：无 TBD/TODO/“后续补充”。每个 Step 含实际代码或命令。

**3. 类型一致性**：`renderFollowKpis(j)` / `renderFollowTable(rows)` 签名在 Task1 定义、Task3/4 调用一致；端点字段 `rows[].alert/overdueDays/lostContact/lastContactDays/visitDue/visitTarget/visits30/id/name/owner` 与 `namedAccountBoard.js:accountRow` 输出及 `named-account-manage.html:renderAlerts` 同源 ✅。

**4. 已知风险**：
- server 重启（Task 2/6 已强调）。
- `injectFollowKpiPanel` 依赖 S02 summary 文本含“客户跟踪”——该文案在 `S02.schema.js:75` 写死，稳定。
- `named-accounts.html` 顶部表多一次 `/api/board/named-account-manage` fetch（与既有 `named-accounts` fetch 并行，无阻塞）。
