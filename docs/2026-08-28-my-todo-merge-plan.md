# 合并两套待办页 →「我的待办」中心 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: 使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 按 Task 逐步实施。步骤用 checkbox（`- [ ]`）跟踪。
>
> 设计来源：`docs/2026-08-28-my-todo-merge-design.md`（已批准）。本计划是其编码落地版，含完整代码、测试与每 Task 提交。

**Goal:** 把重叠的 `todo.html`(S05) 与 `workbench.html`(S33) 合并为单一「我的待办」中心 `/my-todo.html`（五视角），并修复 `workbenchRouter.js` 的 actor 角色匹配 bug + `TODO` 大小写不一致 bug，使 admin 登录后开箱即有数据。

**Architecture:** 新增统一路由 `GET /api/my-todo?view=approval|processing|initiated|cc|follow`（复用既有 `workbenchRouter` 注入式结构，扩展 `follow` 视角合并 S05 业务跟进数据）；旧 `/api/workbench`、`/api/page/todo` 保留为兼容代理；菜单仅留「我的待办」；旧 URL 301 重定向。

**Tech Stack:** Node 22 + Express 4 + vitest 3（注入式测试，不依赖真实 PG）；粒子底座 `crm.particles`；受控渲染器 `renderPage`。

---

## 文件结构（变更清单）

| 操作 | 文件 | 职责 |
|---|---|---|
| Modify | `src/http/workbenchRouter.js` | ① `currentActor` 返回 `{username, roles}` ② `matchApprover(approver, actor)` 支持 `role:xxx` ③ approval 过滤兼容 `TODO`/`todo` 大小写 ④ 新增 `queryFollowSource` dep + `follow` 视角 ⑤ 路由双挂 `/api/workbench`+`/api/my-todo` |
| Modify | `src/http/routes.js` | 旧 `/workbench.html`/`/todo.html` → `res.redirect(301,'/my-todo.html')`；`/api/workbench` 由 `createWorkbenchRouter` 提供（无需改）；新增 `/my-todo.html` sendFile |
| Modify | `src/portal/layoutMenu.js` | 「审批」+「待办」两项 → 合并「我的待办」→ `/my-todo.html` |
| Modify | `src/pages/S33-workbench.schema.js` | 四视角 → 五视角（加 `follow`）；`navigation.to='/my-todo'` |
| Modify | `src/page/schema.js` | `CANONICAL_NAV` 中 `'/todo'` → `'/my-todo'` |
| Create | `src/web/my-todo.html` | 5 tab 成品页（复用 workbench.html 框架，链 `tokens.css`+`common.css`+SSE） |
| Modify | `db/seed.sql` | 追加演示审批任务（`status='todo'`、`approver=role:admin/role:sales`）+ 对应 instance |
| Modify | `test/http/workbench-routes.test.js` | `currentActor` 注入对象化；新增角色匹配 + `follow` + `TODO` 大小写用例 |
| Modify | `test/page/workbench.schema.test.js` | 断言 5 视角 + `/my-todo` 导航 |
| Create | `test/page/my-todo-page.test.js` | 新成品页契约（5 视角 + `fetch /api/my-todo`） |
| Delete | `test/page/workbench-page.test.js` | 旧页已弃用，由上面取代（或改写为指向 my-todo） |

**兼容性铁律：** 审批流 engine（`src/approval/engine.js`）的 `CRM_APPROVAL_*` 写入逻辑**不在本次范围**，不改动。

---

## Task 1 — 修复 actor 角色匹配 + TODO 大小写兼容

**Files:**
- Modify: `src/http/workbenchRouter.js`（currentActor / matchApprover / approval 过滤）
- Modify: `test/http/workbench-routes.test.js`

- [ ] **Step 1: 扩展失败测试（先让既有用例适配新契约 + 新增两个失败项）**

在 `test/http/workbench-routes.test.js` 中：
1. 把 `makeDeps` 的 `currentActor` 改为返回对象（新契约）；
2. 新增用例"role:admin 匹配 admin 用户"与"引擎大写 TODO 仍被待我审批捕获"。

替换 `makeDeps` 中的 `currentActor` 行（L29）为：
```js
    currentActor: async () => ({ username: 'sales', roles: ['sales'] }),
```
并在 `describe` 内新增两条 `it`（放在用例 ① 之后）：
```js
  it('①b GET /workbench?view=approval：role:admin 匹配 admin 用户（角色集匹配）', async () => {
    const router = createWorkbenchRouter({ deps: makeDeps({ currentActor: async () => ({ username: 'admin', roles: ['admin'] }) }) });
    const res = { statusCode: 200, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (o) => { res.body = o; return res; };
    await router.handlers.get({ query: { view: 'approval' } }, res);
    const rows = res.body.data.components?.table?.rows || [];
    // 种子 at-4 的 approver='role:admin' 应命中 admin 用户
    expect(rows.some((r) => r.id === 'at-4')).toBe(true);
  });

  it('①c 引擎大写 TODO 仍被待我审批捕获（大小写兼容）', async () => {
    const deps = makeDeps({ currentActor: async () => ({ username: 'admin', roles: ['admin'] }) });
    // 注入一条 approver=role:admin 且 status 大写的任务
    deps.queryApprovalTasks = async () => ([
      { id: 'at-u', payload: { instance_id: 'i-u', approver: 'role:admin', status: 'TODO', seq: 1, title: '大写TODO任务' } },
    ]);
    const router = createWorkbenchRouter({ deps });
    const res = { statusCode: 200, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (o) => { res.body = o; return res; };
    await router.handlers.get({ query: { view: 'approval' } }, res);
    const rows = res.body.data.components?.table?.rows || [];
    expect(rows.some((r) => r.id === 'at-u')).toBe(true);
  });
```
同时在 `makeDeps` 的 `approval-tasks` 数组新增一条供 ①b 使用（在 at-3 之后追加）：
```js
      { id: 'at-4', payload: { instance_id: 'i-4', approver: 'role:admin', status: 'todo', seq: 1, title: '管理员待审报价' } },
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/http/workbench-routes.test.js`
Expected: ①b、①c 失败（`at-4`/`at-u` 不在 rows）；既有 ① 仍可能因 `matchApprover` 旧签名抛错而失败（断言 `r.id==='at-2'`——旧 `sales` 裸名匹配仍在，但 `currentActor` 改为对象后 `matchApprover(approver, actor)` 的 `actor` 变成对象，`approver===actor` 恒 false 导致 at-2 也漏 → ① 失败，符合预期）。

- [ ] **Step 3: 实现最小修复（workbenchRouter.js）**

替换 `defaultDeps.currentActor`（L30-36）为返回对象：
```js
  currentActor: async (req) => {
    try {
      const me = resolveMe(req);
      if (me.ok) return { username: me.username, roles: [me.role] };
    } catch { /* 未登录/坏 token → system */ }
    return { username: 'system', roles: ['system'] };
  },
```

替换 `matchApprover`（L44-52）为：
```js
// approver 形如 'role:xxx'（按角色）或裸人名（按人）；actor 为 {username, roles}
function matchApprover(approver, actor) {
  if (!approver) return false;
  if (approver.startsWith('role:')) {
    return (actor?.roles || []).includes(approver.slice('role:'.length));
  }
  return approver === actor?.username;
}
```

替换 `buildViewRows` 的 `approval` case（L62-74）过滤行，兼容 `TODO`/`todo` 大小写：
```js
    case 'approval': {
      const rows = approvalTasks
        .filter((t) => (t.payload?.status || 'todo').toString().toLowerCase() === 'todo'
          && matchApprover(t.payload?.approver, actor))
        .map((t) => ({
          id: t.id,
          title: t.payload?.title || t.payload?.instance_id || t.id,
          approver: t.payload?.approver,
          seq: t.payload?.seq ?? '',
          status: t.payload?.status,
          created_at: t.created_at || '',
        }));
      return rows;
    }
```
其余 case（`processing`/`initiated`/`cc`）把 `actor` 改用 `actor.username`（原 `actor` 现为对象）：
```js
    case 'processing': {
      const rows = kanbanTasks
        .filter((t) => t.status === 'running' && (t.payload?.actor || '') === actor.username)
        .map((t) => ({
          id: t.id, title: t.title || t.id,
          actor: t.payload?.actor || '', chain_id: t.chain_id || '', status: t.status, created_at: t.created_at || '',
        }));
      return rows;
    }
    case 'initiated': {
      const rows = instances
        .filter((i) => i.payload?.submitter === actor.username)
        .map((i) => ({
          id: i.id, title: i.payload?.title || i.id, submitter: i.payload?.submitter,
          status: i.payload?.status, current_node_name: i.payload?.current_node_name || '', created_at: i.created_at || '',
        }));
      return rows;
    }
    case 'cc': {
      const rows = instances
        .filter((i) => Array.isArray(i.payload?.cc) && i.payload.cc.includes(actor.username))
        .map((i) => ({
          id: i.id, title: i.payload?.title || i.id, cc: (i.payload?.cc || []).join(', '),
          status: i.payload?.status, created_at: i.created_at || '',
        }));
      return rows;
    }
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/http/workbench-routes.test.js`
Expected: ①～①c、②～⑥ 全 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/http/workbenchRouter.js test/http/workbench-routes.test.js
git commit -m "fix(workbench): actor 角色匹配 + TODO 大小写兼容（待我审批恒空根因 R1）"
```

---

## Task 2 — 新增 follow 视角（合并 S05 业务跟进）

**Files:**
- Modify: `src/http/workbenchRouter.js`（新增 `queryFollowSource` dep + `follow` case + `VIEW_ALIASES`/`VIEWS` + 路由双挂）
- Modify: `test/http/workbench-routes.test.js`（follow 用例）

- [ ] **Step 1: 写失败测试（follow 视角）**

在 `test/http/workbench-routes.test.js` 的 `describe` 末尾新增：
```js
  it('⑦ GET /workbench?view=follow 200 + 待跟进（CRM_DEAL lead/opportunity + 审批单 submitted）', async () => {
    const deps = makeDeps({
      queryFollowSource: async () => ([
        { id: 'd-lead', type: 'CRM_DEAL', payload: { name: '彩盒打样', customer: '甲', stage: 'lead' } },
        { id: 'q-1', type: 'CRM_QUOTATION', payload: { name: '报价A', customer: '乙', status: 'submitted' } },
        { id: 'p-1', type: 'CRM_PAYMENT_PLAN', payload: { name: '回款A', customer: '丙', status: 'pending' } },
      ]),
    });
    const router = createWorkbenchRouter({ deps });
    const res = { statusCode: 200, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (o) => { res.body = o; return res; };
    await router.handlers.get({ query: { view: 'follow' } }, res);
    expect(res.statusCode).toBe(200);
    const rows = res.body.data.components?.table?.rows || [];
    expect(rows.length).toBe(3);
    expect(rows.every((r) => ['跟进', '审批', '核对'].includes(r.action))).toBe(true);
  });
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/http/workbench-routes.test.js -t "follow"`
Expected: FAIL（`view='follow'` 返回空 rows，因 `buildViewRows` default 分支）。

- [ ] **Step 3: 实现 follow 视角**

在 `workbenchRouter.js` 的 `defaultDeps` 新增 `queryFollowSource`（聚合 S05 的业务粒子源，复用 `/api/page/todo` 的 ①②③ 逻辑）：
```js
  queryFollowSource: async () => {
    const types = ['CRM_DEAL', 'CRM_QUOTATION', 'CRM_CONTRACT', 'CRM_INVOICE', 'CRM_ORDER', 'CRM_PAYMENT_PLAN', 'CRM_PAYMENT_RECORD'];
    const out = [];
    for (const t of types) {
      const rows = await queryParticles({ type: t, tenantId: 'system', limit: 200 }).catch(() => []);
      out.push(...rows);
    }
    return out;
  },
```

在 `VIEW_ALIASES`（L19-24）新增 `follow`，并扩展 `VIEWS`（L25）：
```js
export const VIEW_ALIASES = {
  approval: '待我审批',
  processing: '我处理的',
  initiated: '我发起的',
  cc: '抄送我的',
  follow: '待跟进',
};
export const VIEWS = Object.keys(VIEW_ALIASES);
```

在 `buildViewRows` 的 `switch` 中（在 `cc` case 之后、`default` 之前）新增 `follow` case（逻辑迁移自 `routes.js:586` 的 `/api/page/todo`）：
```js
    case 'follow': {
      // 待跟进：业务粒子（商机 lead/opportunity + 审批单 submitted + 回款 pending/submitted）
      const APPROVAL_TYPES = { CRM_QUOTATION: '报价', CRM_CONTRACT: '合同', CRM_INVOICE: '发票', CRM_ORDER: '订单' };
      const todos = [];
      for (const p of followSource) {
        const t = p.type;
        if (APPROVAL_TYPES[t] && p.payload?.status === 'submitted') {
          todos.push({ deal: `${APPROVAL_TYPES[t]}单 ${p.payload?.name || p.slug || p.id}`, customer: p.payload?.customer || p.payload?.account_name || '—', stage: '待审批', due: '待审批', action: '审批' });
        } else if (t === 'CRM_DEAL') {
          const st = p.payload?.stage || 'lead';
          if (st === 'lead' || st === 'opportunity') todos.push({ deal: p.payload?.name || p.slug || '商机', customer: p.payload?.customer || p.payload?.account_name || '—', stage: st, due: '跟进', action: '跟进' });
        } else if (t === 'CRM_PAYMENT_PLAN' || t === 'CRM_PAYMENT_RECORD') {
          if (p.payload?.status === 'submitted' || p.payload?.status === 'pending') todos.push({ deal: `${t === 'CRM_PAYMENT_PLAN' ? '回款计划' : '回款记录'} ${p.payload?.name || p.slug || p.id}`, customer: p.payload?.customer || '—', stage: p.payload?.status, due: '应收', action: '核对' });
        }
      }
      return todos;
    }
```
并在 `buildViewRows` 顶部 `Promise.all` 增加 `followSource`：
```js
  const [approvalTasks, instances, kanbanTasks, followSource] = await Promise.all([
    deps.queryApprovalTasks(),
    deps.queryApprovalInstances(),
    deps.queryKanbanTasks(),
    deps.queryFollowSource(),
  ]);
```

在 `createWorkbenchRouter` 内给 router 双挂 `/api/my-todo`（复用 handlers.get）：
```js
  router.get('/api/workbench', handlers.get);
  router.get('/api/my-todo', handlers.get);
  router.handlers = handlers;
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/http/workbench-routes.test.js`
Expected: ⑦ PASS，全部用例 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/http/workbenchRouter.js test/http/workbench-routes.test.js
git commit -m "feat(workbench): 新增 follow 视角合并 S05 待跟进数据 + /api/my-todo 路由"
```

---

## Task 3 — 菜单合并 + schema 导航更新

**Files:**
- Modify: `src/portal/layoutMenu.js`
- Modify: `src/pages/S33-workbench.schema.js`
- Modify: `src/page/schema.js`
- Modify: `test/page/workbench.schema.test.js`

- [ ] **Step 1: 写失败测试（schema 断言 5 视角 + /my-todo 导航）**

修改 `test/page/workbench.schema.test.js`：
- 用例 ①：`expect(schema.navigation.to).toBe('/my-todo')`；`expect(CANONICAL_NAV).toContain('/my-todo')`
- 用例 ②：新增 `expect(kinds).toContain('table:follow')`

- [ ] **Step 2: 运行测试，确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/page/workbench.schema.test.js`
Expected: ①、② 失败（导航仍为 `/todo`、缺 follow 组件）。

- [ ] **Step 3: 实现**

`src/portal/layoutMenu.js` — 把 L6-L7 两项合并为一项：
```js
  { group: '协同', label: '我的待办', href: '/my-todo.html' },
```

`src/pages/S33-workbench.schema.js` — 在 `viewTables` 数组末尾（cc 组件之后）新增 follow 组件，并改导航：
```js
  {
    kind: 'table',
    view: 'follow',
    title: '待跟进',
    dataBinding: {
      source: 'particle', particleType: 'CRM_DEAL',
      filters: [],
      columns: ['deal', 'customer', 'stage', 'due', 'action'], metrics: [],
    },
  },
```
并把 `export const schema` 的 `navigation: { to: '/todo' }` 改为 `navigation: { to: '/my-todo' }`。

`src/page/schema.js` — 把 L53 的 `'/todo'` 改为 `'/my-todo'`（CANONICAL_NAV 中该元素）。

- [ ] **Step 4: 运行测试，确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/page/workbench.schema.test.js`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/portal/layoutMenu.js src/pages/S33-workbench.schema.js src/page/schema.js test/page/workbench.schema.test.js
git commit -m "refactor(menu): 协同分组合并「我的待办」+ schema 导航切到 /my-todo"
```

---

## Task 4 — 新建 my-todo.html（5 tab 成品页）

**Files:**
- Create: `src/web/my-todo.html`
- Create: `test/page/my-todo-page.test.js`

- [ ] **Step 1: 写失败测试（新成品页契约）**

新建 `test/page/my-todo-page.test.js`：
```js
// test/page/my-todo-page.test.js — 「我的待办」五视角成品页契约
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PAGE = fileURLToPath(new URL('../../src/web/my-todo.html', import.meta.url));

describe('「我的待办」成品页', () => {
  it('① 成品页存在且含标题与五视角 tab', () => {
    expect(existsSync(PAGE)).toBe(true);
    const html = readFileSync(PAGE, 'utf8');
    expect(html).toContain('我的待办');
    for (const v of ['approval', 'processing', 'initiated', 'cc', 'follow']) {
      expect(html).toContain(`data-view="${v}"`);
    }
    expect(html).toContain('待我审批');
    expect(html).toContain('待跟进');
  });
  it('② 切换调用 /api/my-todo?view=<view> + 注入渲染器 HTML + SSE', () => {
    const html = readFileSync(PAGE, 'utf8');
    expect(html).toContain('fetch(`/api/my-todo?view=${view}`)');
    expect(html).toContain('wb-container');
    expect(html).toContain('j.html');
    expect(html).toContain("EventSource('/events')");
  });
  it('③ 链接 tokens.css 与 common.css（前端渲染硬性依赖，缺失会样式乱码）', () => {
    const html = readFileSync(PAGE, 'utf8');
    expect(html).toContain('/portal/tokens.css');
    expect(html).toContain('/portal/common.css');
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/page/my-todo-page.test.js`
Expected: FAIL（`my-todo.html` 不存在）。

- [ ] **Step 3: 创建 `src/web/my-todo.html`**

复制 `workbench.html` 结构，扩展为 5 个 tab（加 `follow`），标题改为「我的待办」，fetch 改为 `/api/my-todo`。完整文件：
```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>我的待办 · 五视角</title>
<style>
  body { font-family: system-ui; margin: 24px; background:var(--bg); color: var(--ink); }
  h2 { margin: 0 0 6px; }
  .sub { color: var(--mut); font-size: 13px; margin-bottom: 14px; }
  .tabs { display: flex; gap: 6px; margin-bottom: 16px; border-bottom: 1px solid var(--line); padding-bottom: 8px; }
  .tab { padding: 6px 14px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); cursor: pointer; font-size: 13px; color: var(--mut); }
  .tab.active { background: var(--ac); border-color: var(--ac); color:#fff; font-weight: 600; }
  #view-title { font-size: 16px; font-weight: 600; margin-bottom: 10px; }
  #view-count { font-size: 12px; color: var(--mut); margin-bottom: 8px; }
  #wb-container { border: 1px solid var(--line); border-radius: 8px; background: var(--panel); padding: 14px; min-height: 120px; }
  .pg-page h2 { display: none; }
  .pg-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .pg-table th { text-align: left; padding: 6px 8px; border-bottom: 2px solid var(--line); color: var(--mut); }
  .pg-table td { padding: 6px 8px; border-bottom: 1px solid var(--panel); }
  .pg-state { padding: 16px; text-align: center; color: var(--mut); font-size: 13px; }
  #sse-status { font-size: 11px; color: var(--mut); margin-top: 10px; }
</style>
  <link rel="stylesheet" href="/portal/tokens.css">
  <link rel="stylesheet" href="/portal/common.css">
</head>
<body>
<h2>📋 我的待办</h2>
<div class="sub">五视角（待我审批 / 我处理的 / 我发起的 / 抄送我的 / 待跟进）——服务端按当前人过滤，复用受控渲染器产出 HTML。SSE 实时刷新（task/approval 事件）。</div>

<div class="tabs" id="tabs">
  <button class="tab active" data-view="approval">待我审批</button>
  <button class="tab" data-view="processing">我处理的</button>
  <button class="tab" data-view="initiated">我发起的</button>
  <button class="tab" data-view="cc">抄送我的</button>
  <button class="tab" data-view="follow">待跟进</button>
</div>

<div id="view-title">待我审批</div>
<div id="view-count"></div>
<div id="wb-container">加载中…</div>
<div id="sse-status">SSE 未连接</div>

<script>
const VIEW_ORDER = ['approval', 'processing', 'initiated', 'cc', 'follow'];
let currentView = 'approval';

async function loadView(view) {
  currentView = view;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === view));
  const title = document.querySelector(`.tab[data-view="${view}"]`).textContent;
  document.getElementById('view-title').textContent = title;
  document.getElementById('wb-container').textContent = '加载中…';
  try {
    const r = await fetch(`/api/my-todo?view=${view}`);
    const j = await r.json();
    if (!r.ok) { document.getElementById('wb-container').innerHTML = `<div class="pg-state" data-state="error">${j.error || '加载失败'}</div>`; return; }
    const rows = j.data?.components?.table?.rows || [];
    document.getElementById('view-count').textContent = `${j.alias || title} · ${rows.length} 条`;
    document.getElementById('wb-container').innerHTML = j.html || '<div class="pg-state">暂无数据</div>';
  } catch (e) {
    document.getElementById('wb-container').innerHTML = `<div class="pg-state" data-state="error">请求失败：${e.message}</div>`;
  }
}

document.getElementById('tabs').addEventListener('click', (ev) => {
  const view = ev.target.dataset.view;
  if (view) loadView(view);
});

function connectSse() {
  const es = new EventSource('/events');
  es.onopen = () => { document.getElementById('sse-status').textContent = 'SSE 已连接（实时刷新）'; };
  es.onerror = () => { document.getElementById('sse-status').textContent = 'SSE 连接中断（重试中）'; };
  es.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (['task', 'approval'].includes(msg.domain)) loadView(currentView);
    } catch (e) { /* 忽略非 JSON 心跳 */ }
  };
}

loadView('approval');
connectSse();
</script>
<script type="module">
  import { injectLayout } from '/portal/layout.js';
  injectLayout();
</script>
</body>
</html>
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/page/my-todo-page.test.js`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/web/my-todo.html test/page/my-todo-page.test.js
git commit -m "feat(web): 新建「我的待办」五视角成品页 /my-todo.html"
```

---

## Task 5 — 旧 URL 301 重定向 + 删除旧页测试

**Files:**
- Modify: `src/http/routes.js`（L1286-1288、L1461-1464）
- Delete: `test/page/workbench-page.test.js`（由 Task 4 的 my-todo-page.test.js 取代）

- [ ] **Step 1: 写失败测试（重定向）**

新建 `test/http/legacy-redirect.test.js`：
```js
import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import { createApp } from '../../src/http/routes.js'; // 若 routes.js 未导出，则改为集成测试见 Step 3 说明

// 若 routes.js 不便直接实例化，用 supertest 风格跳过；此处仅断言路由源码含 301。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const SRC = readFileSync(fileURLToPath(new URL('../../src/http/routes.js', import.meta.url)), 'utf8');
describe('旧待办 URL 301 重定向', () => {
  it('/workbench.html 与 /todo.html 重定向到 /my-todo.html（301）', () => {
    expect(SRC).toMatch(/res\.redirect\(301,\s*'\/my-todo\.html'\)/);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/http/legacy-redirect.test.js`
Expected: FAIL（源码仍为 `sendFile(...workbench.html)`）。

- [ ] **Step 3: 实现 301 重定向**

`src/http/routes.js` L1286-1288 改为：
```js
  app.get('/workbench.html', (req, res) => res.redirect(301, '/my-todo.html'));
  app.get('/workbench', (req, res) => res.redirect(301, '/my-todo.html'));
```
L1461-1464 改为：
```js
  // ─── S05 待办工作台（已合并入 /my-todo.html，旧 URL 301 兼容）───
  app.get('/todo.html', (req, res) => res.redirect(301, '/my-todo.html'));
  app.get('/todo', (req, res) => res.redirect(301, '/my-todo.html'));
```
> 注：若 `routes.js` 不便单元测试实例化，Step 1 的源码断言即足够；集成验证放在 Task 9 浏览器步骤。

- [ ] **Step 4: 删除旧页测试并运行**

```bash
rm test/page/workbench-page.test.js
```
Run: `node node_modules/vitest/vitest.mjs run test/http/legacy-redirect.test.js test/page/my-todo-page.test.js`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/http/routes.js test/http/legacy-redirect.test.js
git rm test/page/workbench-page.test.js
git commit -m "refactor(routes): /workbench.html、/todo.html 301 重定向到 /my-todo.html"
```

---

## Task 6 — 演示种子数据对齐（D1）

**Files:**
- Modify: `db/seed.sql`（末尾追加 CRM_APPROVAL_INSTANCE + CRM_APPROVAL_TASK）

- [ ] **Step 1: 在 seed.sql 末尾追加演示审批数据**

在 `db/seed.sql` 文件最后追加（沿用其字段顺序 `(id, tenant_id, type, slug, title, state, payload, created_at, updated_at)` + 固定 UUID + `ON CONFLICT (id) DO NOTHING` 幂等约定）：
```sql
-- ============ 演示审批流（D1：让「我的待办·待我审批」开箱有数据）============
-- 说明：status 用小写 'todo'（与 schema.js:75 / workbenchRouter 过滤约定一致）；
--       approver 用 role:admin（admin 主演示可见）+ role:sales（alice 可见）；
--       不新增账号、不改密码体系。
INSERT INTO crm.particles (id, tenant_id, type, slug, title, state, payload, created_at, updated_at) VALUES
  ('a9000000-0000-0000-0000-000000000001', 'system', 'CRM_APPROVAL_INSTANCE', 'demo-inst-1',
   '报价单-演示审批', 'ACTIVE',
   '{"flow_id":"demo-flow","business_type":"CRM_QUOTATION","business_id":"f1111111-1111-1111-1111-111111111111","submitter":"alice","status":"approving","current_node":"n1","current_node_name":"经理审批","node_mode":"ANY","approvers":{"role:admin":true},"ctx":{}}',
   now(), now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO crm.particles (id, tenant_id, type, slug, title, state, payload, created_at, updated_at) VALUES
  ('a9000000-0000-0000-0000-000000000011', 'system', 'CRM_APPROVAL_TASK', 'demo-task-admin',
   '管理员待审演示报价', 'ACTIVE',
   '{"instance_id":"a9000000-0000-0000-0000-000000000001","node_id":"n1","approver":"role:admin","status":"todo","opinion":null,"seq":1}',
   now(), now()),
  ('a9000000-0000-0000-0000-000000000012', 'system', 'CRM_APPROVAL_TASK', 'demo-task-sales',
   '销售待审演示合同', 'ACTIVE',
   '{"instance_id":"a9000000-0000-0000-0000-000000000001","node_id":"n1","approver":"role:sales","status":"todo","opinion":null,"seq":2}',
   now(), now())
ON CONFLICT (id) DO NOTHING;
```

- [ ] **Step 2: 运行 seed 并验证**

Run:
```bash
npm run seed
```
Expected: 无报错（幂等，重跑安全）。

Run（验证数据）：
```bash
node --input-type=module -e "import { query } from './src/db.js'; const r = await query(\"SELECT payload->>'approver' approver, payload->>'status' status, count(*)::int n FROM crm.particles WHERE type='CRM_APPROVAL_TASK' AND payload->>'status'='todo' GROUP BY 1,2\"); console.log(JSON.stringify(r.rows)); process.exit(0);"
```
Expected: 输出含 `{approver:'role:admin',status:'todo',n:1}` 与 `{approver:'role:sales',status:'todo',n:1}`。

- [ ] **Step 3: 提交**

```bash
git add db/seed.sql
git commit -m "feat(seed): 演示审批任务（role:admin/role:sales，status=todo）开箱可见"
```

---

## Task 7 — 全量回归 + 浏览器验证（收尾）

**Files:** 无新增（验证动作）

- [ ] **Step 1: 全量测试，确认无新增回归**

Run: `node node_modules/vitest/vitest.mjs run`
Expected: 与基线对比，本次改动相关套件（workbench-routes / workbench-schema / my-todo-page / legacy-redirect）全绿；其他既有失败（db.js/auditHook 等并行线问题）不计入本计划回归。

- [ ] **Step 2: 浏览器端到端验证（admin 视角）**

使用 agent-browser（或手动）：
1. 打开 `http://localhost:3000/home.html`，用 `admin / admin123` 登录；
2. 进入菜单「协同 › 我的待办」→ `/my-todo.html`；
3. 断言：五个 tab（待我审批/我处理的/我发起的/抄送我的/待跟进）均可点击；「待我审批」含 2 条 `demo-task-*`（role:admin 命中）；
4. 旧 URL 验证：浏览器访问 `http://localhost:3000/workbench.html` 与 `/todo.html` 均 301 跳转到 `/my-todo.html`；
5. SSE：在另一会话推进一条审批后，当前页「待我审批」实时刷新。

- [ ] **Step 3: 提交（本次计划总收口，可选）**

若需把本计划的多个 commit 统一说明，追加一条空提交或合并说明（按团队规范）：
```bash
git log --oneline -6
```
确认 6 个 commit（Task1–Task6）就位。

---

## 自检（writing-plans Self-Review）

1. **Spec 覆盖**：§5 五视角 → Task1(approval修复)+Task2(follow)；§6 数据面 → Task1/2 过滤条件；§7 actor 修复 → Task1；§8 D1 种子 → Task6；§9 前端/菜单 → Task3/4/5；§10 验收 → Task7。全覆盖。
2. **占位符扫描**：无 `TBD`/`TODO`/「类似 Task N」。每个代码步骤给完整片段或完整文件（`my-todo.html` 给全文件）。
3. **类型一致性**：`currentActor` 全程返回 `{username, roles}`；`matchApprover(approver, actor)` 第二参为对象；`buildViewRows(view, actor, deps)` 的 `actor.username`/`actor.roles` 在 Task1 已统一；`queryFollowSource` 在 defaultDeps 与测试注入命名一致；`VIEW_ALIASES`/`VIEWS` 在 Task2 同步扩展，schema 的 `view:'follow'` 组件与 router 的 `follow` case 同名。
4. **已知遗漏提示**：`src/web/layout.js` 或门户壳中若有硬编码 `/workbench.html`、`/todo.html` 链接，需同步改为 `/my-todo.html`（Task 3 已覆盖 layoutMenu；若 home.html/壳另有硬链，按 Task 3 同法补改，不另立 Task）。`/api/page/todo`（S05 旧接口）按 §5 保留为兼容代理，未删除。
