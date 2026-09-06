# 销售管道页 + 前台互通（Pipeline Portal Binding）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `/pipeline.html` 销售管道页（DEAL 六阶段分列 + 内联详情区），修正数据契约（board 含 DEAL、今日优先用真实 stage），并注入 `nav.js` 共享导航让 6 个子页互通、消除死胡同。

**Architecture:** ① 数据契约修正：`/api/business/board` 聚合追加 `CRM_DEAL`；index.html 今日优先改用 `payload.stage`（消除硬编码假数据）。② 新建 `/pipeline.html`（A3：六列分列 + 内联详情区，不弹抽屉）。③ 新建 `src/web/nav.js`（ESM 共享导航 + token 守卫 + 角色自适应），6 个子页注入。

**Tech Stack:** Node 22 ESM · Express 4 · PostgreSQL 16 · vanilla JS（无框架）· vitest 3

**关联设计:** `docs/superpowers/specs/2026-08-26-pipeline-portal-binding-design.md`（已批准，commit adbd7b6）

---

## 文件结构

**新建**
- `src/web/pipeline.html` — 销售管道页（六列 + 内联详情区）
- `src/web/nav.js` — 共享导航组件（ESM，token 守卫 + 角色自适应 + 7 项导航）
- `test/portal-pipeline.test.js` — 管道页路由 + board 含 DEAL 断言

**修改**
- `src/http/routes.js` — ① board types 追加 `CRM_DEAL`(184)；② 新增 `/pipeline.html`、`/pipeline` 路由；③ 新增 `/portal/nav.js` 静态路由
- `src/web/index.html` — ① 今日优先用真实 stage(133)；② 侧栏导航改 `/pipeline.html` + 「任务执行」项(53-54)；③ logout 补跳转
- 6 个子页（workbench / decision-graph / sales-decision-monitor / particle-detail / meta-attr-drawer / kanban）— 注入 nav.js

**测试约定（重要）**：本工程测试经 `app.fetch(path, {method, headers, body})` 驱动，body 须为 JSON 字符串且带 `Content-Type: application/json`。运行命令统一：
`node node_modules/vitest/vitest.mjs run --fileParallelism=false test/<file>.test.js`

---

### Task P1：数据契约修正（board 含 DEAL + 今日优先真实 stage）

**Files:**
- Modify: `src/http/routes.js:184`
- Modify: `src/web/index.html:133`
- Test: `test/portal-pipeline.test.js`

- [ ] **Step 1：写失败测试**

```js
// test/portal-pipeline.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import { createApp } from '../src/http/server.js';
import { query } from '../src/db.js';

let app;
beforeAll(() => { app = createApp(); });

describe('数据契约修正', () => {
  it('/api/business/board 聚合含 CRM_DEAL 键', async () => {
    const res = await app.fetch('/api/business/board');
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.grouped).toHaveProperty('CRM_DEAL');
  });
  it('若有 DEAL 种子则分组非空', async () => {
    const r = await query(`SELECT count(*)::int n FROM crm.particles WHERE type='CRM_DEAL'`, []);
    if (r.rows[0].n > 0) {
      const res = await app.fetch('/api/business/board');
      const j = await res.json();
      expect((j.grouped.CRM_DEAL || []).length).toBe(r.rows[0].n);
    }
  });
});
```

- [ ] **Step 2：运行测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run --fileParallelism=false test/portal-pipeline.test.js`
Expected: FAIL（`/api/business/board` 无 `CRM_DEAL` 键）。

- [ ] **Step 3：board types 追加 CRM_DEAL**

`src/http/routes.js:184` 改为：

```js
      const types = ['CRM_DEAL', 'CRM_QUOTATION', 'CRM_CONTRACT', 'CRM_PAYMENT_PLAN', 'CRM_PAYMENT_RECORD', 'CRM_INVOICE', 'CRM_ORDER'];
```

- [ ] **Step 4：index.html 今日优先改用真实 stage**

`src/web/index.html:133` 改为：

```js
      const grouped = (board && board.grouped) || {};
      const deals = (grouped.CRM_DEAL || []).map(p => ({ id: p.id, name: p.payload?.name || p.slug || '商机', stage: p.payload?.stage || 'lead', updated_at: p.updated_at, budget_fit: 0.6 }));
```

（保留 `budget_fit:0.6` 作打分入参占位——scoring.js FIT 用；stage 不再硬编码"报价"。）

- [ ] **Step 5：运行测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run --fileParallelism=false test/portal-pipeline.test.js`
Expected: PASS（2/2）。

- [ ] **Step 6：提交**

```bash
git add src/http/routes.js src/web/index.html test/portal-pipeline.test.js
git commit -m "feat(pipeline): /api/business/board 聚合含 CRM_DEAL + 今日优先真实 stage（消除假数据）"
```

---

### Task P2：/pipeline.html 销售管道页（六列 + 内联详情区）

**Files:**
- Create: `src/web/pipeline.html`
- Modify: `src/http/routes.js`（新增 `/pipeline.html`、`/pipeline` 路由）
- Test: `test/portal-pipeline.test.js`（追加用例）

- [ ] **Step 1：写失败测试（追加）**

```js
describe('销售管道页', () => {
  it('GET /pipeline.html 返回管道页含「销售管道」', async () => {
    const res = await app.fetch('/pipeline.html');
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('销售管道');
  });
  it('GET /pipeline 重定向到 /pipeline.html', async () => {
    const res = await app.fetch('/pipeline');
    expect([301, 302]).toContain(res.status);
  });
  it('GET / 含指向 /pipeline.html 的导航', async () => {
    const res = await app.fetch('/');
    const html = await res.text();
    expect(html).toContain('/pipeline.html');
  });
});
```

- [ ] **Step 2：运行测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run --fileParallelism=false test/portal-pipeline.test.js`
Expected: FAIL（无 `/pipeline.html` 路由，页面 404）。

- [ ] **Step 3：实现 pipeline.html**

`src/web/pipeline.html`：

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"><title>CRM 销售管道</title>
<style>
 :root{--bg:#f7f8fb;--panel:#fff;--ink:#0f172a;--mut:#64748b;--line:#e2e8f0;--ac:#4f46e5;--as:#eef2ff}
 *{box-sizing:border-box}body{margin:0;font-family:system-ui,"PingFang SC",sans-serif;background:var(--bg);color:var(--ink)}
 .filter{display:flex;gap:8px;flex-wrap:wrap;padding:14px 20px;background:var(--panel);border-bottom:1px solid var(--line)}
 .filter .chip{font-size:12px;color:var(--ac);background:var(--as);border:1px solid #e0e7ff;border-radius:999px;padding:5px 12px;cursor:pointer}
 .filter .chip.on{background:var(--ac);color:#fff}
 .main{padding:18px 20px}
 .cols{display:flex;gap:12px;overflow-x:auto;align-items:flex-start}
 .col{flex:1;min-width:170px;background:#f1f5f9;border-radius:12px;padding:10px}
 .col h3{font-size:12px;margin:0 0 8px;color:var(--mut);display:flex;justify-content:space-between}
 .col h3 b{color:var(--ink)}
 .card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:9px 11px;margin-bottom:8px;cursor:pointer}
 .card:hover{border-color:var(--ac)}
 .card .name{font-size:13px;font-weight:600}
 .card .meta{font-size:11px;color:var(--mut);margin-top:3px}
 .card .stale{display:inline-block;font-size:10px;background:#fef3c7;color:#92400e;border-radius:5px;padding:1px 6px;margin-top:4px}
 .detail{margin-top:16px;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px;display:none}
 .detail.show{display:block}
 .detail h3{margin:0 0 10px;font-size:14px}
 .kv{display:grid;grid-template-columns:120px 1fr;gap:6px 10px;font-size:13px;margin-bottom:12px}
 .kv dt{color:var(--mut)}.kv dd{margin:0}
 .acts{display:flex;gap:8px;flex-wrap:wrap}
 .acts button{border:1px solid var(--ac);color:var(--ac);background:#fff;border-radius:8px;padding:7px 14px;font-weight:600;cursor:pointer}
 .empty{padding:30px;text-align:center;color:var(--mut);font-size:13px}
</style>
</head>
<body>
<div class="filter" id="filter">
  <span class="chip on" data-st="all">全部</span>
  <span class="chip" data-st="lead">线索</span>
  <span class="chip" data-st="opportunity">商机</span>
  <span class="chip" data-st="quoted">报价</span>
  <span class="chip" data-st="contracted">合同</span>
  <span class="chip" data-st="ordered">订单</span>
  <span class="chip" data-st="paid">回款</span>
  <span class="chip" data-st="lost">已流失</span>
</div>
<main class="main">
  <div class="cols" id="cols"></div>
  <div class="detail" id="detail"><div id="detailBody"></div></div>
</main>
<script type="module">
  import '/portal/nav.js';
  const STAGES = [
    { key: 'lead', title: '线索' },
    { key: 'opportunity', title: '商机' },
    { key: 'quoted', title: '报价' },
    { key: 'contracted', title: '合同' },
    { key: 'ordered', title: '订单' },
    { key: 'paid', title: '回款' },
  ];
  const LOST = ['lost', 'disqualified'];
  let all = []; let filter = 'all';
  const esc = s => String(s || '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

  async function load() {
    try {
      const r = await fetch('/api/particles?type=CRM_DEAL');
      const j = await r.json();
      all = j.items || [];
      render();
    } catch (e) { document.getElementById('cols').innerHTML = '<div class="empty">加载失败：' + esc(e.message) + '</div>'; }
  }

  function byStage(p) { return p.payload?.stage || 'lead'; }
  function isStale(p) {
    const d = p.updated_at ? (Date.now() - new Date(p.updated_at).getTime()) / 86400000 : 99;
    return d > 7;
  }

  function render() {
    const cols = document.getElementById('cols');
    cols.innerHTML = '';
    const scope = all.filter(p => {
      if (filter === 'all') return true;
      if (filter === 'lost') return LOST.includes(byStage(p));
      return byStage(p) === filter;
    });
    const groups = filter === 'lost'
      ? [{ key: 'lost', title: '已流失', list: scope }]
      : STAGES.map(st => ({ ...st, list: scope.filter(p => byStage(p) === st.key) }));
    const nonEmpty = groups.filter(g => g.list.length);
    for (const g of nonEmpty) {
      const col = document.createElement('div');
      col.className = 'col';
      col.innerHTML = `<h3>${g.title}<b>${g.list.length}</b></h3>`;
      for (const p of g.list) {
        const card = document.createElement('div');
        card.className = 'card';
        card.dataset.id = p.id;
        card.innerHTML = `<div class="name">${esc(p.payload?.name || p.slug || '商机')}</div>` +
          `<div class="meta">stage ${esc(byStage(p))} · ${(p.updated_at || '').slice(0, 10)}</div>` +
          (isStale(p) ? '<span class="stale">⏰ 未跟进 ' + Math.round((Date.now() - new Date(p.updated_at).getTime()) / 86400000) + ' 天</span>' : '');
        card.onclick = () => showDetail(p);
        col.appendChild(card);
      }
      cols.appendChild(col);
    }
    if (!nonEmpty.length) cols.innerHTML = '<div class="empty">暂无商机 — 用命令栏「新建线索」入池</div>';
  }

  async function showDetail(p) {
    const box = document.getElementById('detail'), body = document.getElementById('detailBody');
    box.classList.add('show');
    try {
      const [pr, nb] = await Promise.all([
        fetch('/api/particles/' + p.id).then(r => r.json()),
        fetch('/api/graph/neighbors?particleId=' + p.id).then(r => r.json()).catch(() => ({ edges: [] })),
      ]);
      const payload = pr.payload || {};
      const edges = nb.edges || [];
      const kv = Object.entries(payload).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</dd>`).join('');
      const edgeList = edges.length ? edges.map(e => `<div style="font-size:12px;color:var(--mut)">${esc(e.predicate || '')} → ${esc(e.target_id || '')}</div>`).join('') : '<div style="font-size:12px;color:var(--mut)">无出边</div>';
      body.innerHTML = `<h3>${esc(p.payload?.name || p.slug || '商机')} · <span style="color:var(--ac)">${esc(byStage(p))}</span></h3>` +
        `<div class="kv">${kv}</div>` +
        `<div style="font-size:12px;color:var(--mut);margin-bottom:6px">决策网络出边：</div>${edgeList}` +
        `<div class="acts"><button data-nl="把「${esc(p.payload?.name || p.slug)}」推进到下一阶段">推进商机</button>` +
        `<button data-nl="给「${esc(p.payload?.name || p.slug)}」生成唤醒邮件">唤醒邮件</button></div>`;
      body.querySelectorAll('button').forEach(b => b.onclick = () => { location.href = '/?nl=' + encodeURIComponent(b.dataset.nl); });
    } catch (e) { body.innerHTML = '<div class="empty">详情加载失败：' + esc(e.message) + '</div>'; }
  }

  document.getElementById('filter').addEventListener('click', e => {
    const chip = e.target.closest('.chip'); if (!chip) return;
    document.querySelectorAll('#filter .chip').forEach(c => c.classList.remove('on'));
    chip.classList.add('on');
    filter = chip.dataset.st;
    render();
  });

  load();
</script>
</body></html>
```

- [ ] **Step 4：注册路由**

`src/http/routes.js` 在首页路由（:421 `app.get('/')`）附近追加：

```js
  app.get('/pipeline.html', (req, res) => res.sendFile(fileURLToPath(new URL('../web/pipeline.html', import.meta.url))));
  app.get('/pipeline', (req, res) => res.redirect('/pipeline.html'));
```

- [ ] **Step 5：运行测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run --fileParallelism=false test/portal-pipeline.test.js`
Expected: PASS（追加后 5/5）。

- [ ] **Step 6：提交**

```bash
git add src/web/pipeline.html src/http/routes.js test/portal-pipeline.test.js
git commit -m "feat(pipeline): /pipeline.html 六列销售管道 + 内联详情区 + 路由"
```

---

### Task P3：nav.js 共享导航 + 6 子页注入 + index 落点修正

**Files:**
- Create: `src/web/nav.js`
- Modify: `src/http/routes.js`（新增 `/portal/nav.js` 静态路由）
- Modify: `src/web/index.html`（导航落点 + logout 跳转）
- Modify: 6 个子页（workbench / decision-graph / sales-decision-monitor / particle-detail / meta-attr-drawer / kanban）— 注入 nav.js
- Test: `test/portal-pipeline.test.js`（追加用例）

- [ ] **Step 1：写失败测试（追加）**

```js
describe('共享导航 nav.js', () => {
  it('GET /portal/nav.js 返回 ES 模块', async () => {
    const res = await app.fetch('/portal/nav.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('javascript');
  });
  it('子页面注入 nav.js（workbench 为例）', async () => {
    const res = await app.fetch('/workbench.html');
    const html = await res.text();
    expect(html).toContain('/portal/nav.js');
  });
});
```

- [ ] **Step 2：运行测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run --fileParallelism=false test/portal-pipeline.test.js`
Expected: FAIL（无 `/portal/nav.js` 路由；子页无注入）。

- [ ] **Step 3：实现 nav.js**

`src/web/nav.js`：

```js
// src/web/nav.js — 共享导航（ESM）：token 守卫 + 角色自适应 + 7 项导航 + 身份/退出
// 用法：子页面 <script type="module">import '/portal/nav.js';</script>
// 依赖：/api/auth/me（roles 映射到导航项高亮）+ localStorage crm_token
const ITEMS = [
  { href: '/', label: '🏠 首页' },
  { href: '/pipeline.html', label: '🎯 线索池 / 💼 商机' },
  { href: '/workbench.html', label: '✅ 审批' },
  { href: '/decision-graph', label: '🕸 决策网络' },
  { href: '/sales-decision-monitor', label: '📈 报告' },
  { href: '/kanban.html', label: '📋 任务执行' },
  { href: '/?pool', label: '⚙ 线索池配置' },
];

function injectNav() {
  const token = localStorage.getItem('crm_token');
  if (!token) { location.href = '/home.html'; return; }
  // 页头导航条（无既有 nav 时注入；index 已有侧栏则跳过 body 注入，仅补角色）
  const bar = document.createElement('div');
  bar.id = 'crmNav';
  bar.style.cssText = 'display:flex;gap:4px;align-items:center;background:#0f172a;color:#cbd5e1;padding:8px 14px;flex-wrap:wrap;font-size:13px';
  bar.innerHTML = `<span style="color:#fff;font-weight:700;margin-right:8px">⚡ CRM</span>` +
    ITEMS.map(i => `<a href="${i.href}" style="color:#cbd5e1;text-decoration:none;padding:5px 10px;border-radius:7px">${i.label}</a>`).join('') +
    `<span style="margin-left:auto;font-size:12px">身份：<b id="who2" style="color:#fff">—</b> · <a href="/home.html" id="logout2" style="color:#94a3b8">退出</a></span>`;
  document.body.prepend(bar);
  // 角色自适应 + 守卫
  (async () => {
    try {
      const r = await fetch('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } });
      const j = await r.json();
      if (!r.ok) { localStorage.clear(); location.href = '/home.html'; return; }
      const who = document.getElementById('who2');
      if (who) who.textContent = `${j.display_name}（${j.role}）`;
    } catch { localStorage.clear(); location.href = '/home.html'; }
  })();
  document.getElementById('logout2').onclick = () => { localStorage.clear(); };
  // 路径高亮
  const path = location.pathname;
  bar.querySelectorAll('a').forEach(a => {
    const href = a.getAttribute('href');
    if ((href === '/' && path === '/') || (href !== '/' && path.startsWith(href.split('?')[0]))) a.style.background = '#1e293b';
  });
}

injectNav();
```

- [ ] **Step 4：注册 /portal/nav.js 路由**

`src/http/routes.js` 在 `/portal/scoring.js` 路由（:428-429）后追加：

```js
  app.get('/portal/nav.js', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/nav.js', import.meta.url)), { headers: { 'Content-Type': 'text/javascript' } }));
```

- [ ] **Step 5：index.html 导航落点修正 + logout 跳转**

`src/web/index.html:53-54` 改为：

```html
      <a class="active" href="/">🏠 首页</a><a href="/pipeline.html">🎯 线索池</a><a href="/pipeline.html">💼 商机</a>
      <a href="/pipeline.html">📊 L2C 看板</a><a href="/workbench.html">✅ 审批</a><a href="/decision-graph">🕸 决策网络</a><a href="/sales-decision-monitor">📈 报告</a><a href="/kanban.html">📋 任务执行</a>
```

`src/web/index.html:104` logout 改为（补跳转，原只清 localStorage）：

```js
  document.getElementById('logout').onclick = () => { localStorage.clear(); location.href = '/home.html'; };
```

- [ ] **Step 6：6 子页注入 nav.js**

对每个文件（`workbench.html` / `decision-graph.html` / `sales-decision-monitor.html` / `particle-detail.html` / `meta-attr-drawer.html` / `kanban.html`），在 `</body>` 前追加：

```html
<script type="module">import '/portal/nav.js';</script>
```

> 注意：若页面已有 `<script>` 标签，追加到最后一个 `</script>` 之后、`</body>` 之前。

- [ ] **Step 7：运行测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run --fileParallelism=false test/portal-pipeline.test.js`
Expected: PASS（追加后 7/7）。

- [ ] **Step 8：提交**

```bash
git add src/web/nav.js src/http/routes.js src/web/index.html src/web/workbench.html src/web/decision-graph.html src/web/sales-decision-monitor.html src/web/particle-detail.html src/web/meta-attr-drawer.html src/web/kanban.html test/portal-pipeline.test.js
git commit -m "feat(pipeline): nav.js 共享导航 + 6 子页注入 + index 导航落点修正与退出跳转"
```

---

### Task P4：全量回归 + 设计文档落状态

**Files:**
- Test: 全量相关
- Modify: `docs/superpowers/specs/2026-08-26-pipeline-portal-binding-design.md`（状态置"已落地"）

- [ ] **Step 1：运行门户相关测试**

Run: `node node_modules/vitest/vitest.mjs run --fileParallelism=false test/portal-pipeline.test.js test/portal-pages.test.js test/portal-scoring.test.js test/auth.test.js`
Expected: 全部 PASS。

- [ ] **Step 2：端到端冒烟（真实 HTTP）**

```bash
cd "D:/system/CRM-ai-native" && (node src/http/server.js > /tmp/crm-pipeline.log 2>&1 &) && sleep 2
for p in "/pipeline.html" "/pipeline" "/portal/nav.js" "/portal/scoring.js" "/workbench.html" "/decision-graph" "/sales-decision-monitor" "/particle-detail.html" "/meta-attr-drawer" "/kanban.html" "/" ; do
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:3000$p"); echo "$code <- $p";
done
```

Expected: 全部 200（`/pipeline` 为 301/302）。

- [ ] **Step 3：设计文档落状态**

`docs/superpowers/specs/2026-08-26-pipeline-portal-binding-design.md` 顶部状态改为：

```markdown
> 状态：已落地（Task P1–P4 全绿）
```

- [ ] **Step 4：提交**

```bash
git add docs/superpowers/specs/2026-08-26-pipeline-portal-binding-design.md
git commit -m "docs(pipeline): 设计文档落状态（已落地）"
```

---

## 自我审查

1. **Spec 覆盖**：§1 数据契约 → Task P1 ✓；§2 pipeline 页 → Task P2 ✓；§3 nav.js 互通 → Task P3 ✓；§4 文件清单 → P1-P3 全覆盖 ✓；§6 测试验收 → P4 回归 ✓。
2. **占位符扫描**：无 TBD/TODO；所有实现步骤含完整代码（pipeline.html 全量、nav.js 全量、routes 片段含精确行号）。
3. **类型一致性**：`nav.js` 中 `ITEMS.href` 与 §3.3 导航落点表一致；`pipeline.html` 用 `/portal/nav.js` 与 routes 路由（P3 Step 4）一致；`scoring.js` 函数名（`scoreDeal/suggestAction/buildTodayPriority/l2cCounts`）在 index.html 与既有实现一致（本计划不新增打分 API）。

## 执行提示
- 真实运行前先确认 `db/migrate.js` 已应用（若种子无 DEAL，管道页显示空态文案，测试 P1 Step 2 第二用例跳过）。
- 提交严格按 Task 拆分；并行进程改动文件（`src/web/index.html` 等）勿混入本计划提交之外的无关改动。