# S02 三卡钻取 + 文案语义校准 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让首页（S02 AI 作战室）三张「今日优先」指标卡（FIT/TIMING/CONN）可点击钻取到对应商机清单，并将副标题文案校准为精准语义。

**Architecture:** 纯前端/端点层加法改造，不改三卡计数算法（routes.js:562-564 已验证 3/1/3）。渲染器 `renderMetricCard`/`renderTable` 增加受控导航能力（组件级 `navigation.to` / `dataBinding.rowLink`），S02 schema 三卡挂导航+口径文案，业务看板端点读 `?focus` 过滤高亮，FIT 跳新建明细页。所有出片经 `renderPage` 单源，不写旁路 HTML。

**Tech Stack:** Node 22 + ESM + Express 4（`src/http/routes.js`）+ 受控渲染器（`src/page/renderer.js` / `validator.js` / `schema.js`）+ 前端壳（`src/web/*.html`，统一设计系统 `/portal/{tokens,common,page}.css`）。

**设计基准：** `docs/2026-08-29-s02-metric-drillthrough-design.md`（已批准 2026-08-29）

---

## 文件结构（改造清单）

| 文件 | 动作 | 责任 |
|---|---|---|
| `src/page/renderer.js` | Modify (`:104-113` `renderMetricCard` + `:192-203` `renderTable`) | 通用导航能力：metric-card→`<a>`；table→行级 `rowLink` |
| `src/pages/S02.schema.js` | Modify (`:20-34`) | 三 metric-card 加 `navigation.to` + 精准 `metrics[].label` |
| `src/http/routes.js` | Modify (`:502` 业务看板端点 + 新增 today-priority 端点 + `:1877` 附近加 html 路由 + `:79` 附近加 S34 import) | focus 过滤高亮 + FIT 明细端点 + 静态壳路由 |
| `src/web/business-board.html` | Modify (`:34` fetch) | 转发 `?focus` query 到 `/api/page/business-board` |
| `src/web/today-priority.html` | Create | FIT 明细页壳（token 守卫 + 注入 renderPage 产物） |
| `src/pages/S34.schema.js` | Create | FIT 明细页 schema（table + `rowLink` + 口径 header） |
| `test/page/renderer-nav.test.js` | Create | 渲染器导航单测（metric-card `<a>` + table rowLink） |

**约束确认（已探查）：**
- `validator.js:19` 仅校验 **schema 级** `navigation.to`；**组件级** `navigation` 不受 `CANONICAL_NAV` 约束（validator 对未知属性忽略），可自由加。
- `CANONICAL_NAV`（schema.js:62-74）含 `/home` / `/business-board` 等 → S34 schema 用 `navigation.to:'/home'`。
- `deal-detail.html`（routes.js:1811）+ `GET /api/page/deal-detail`（971）已存在 → FIT 明细行直链，无需新建详情页。
- `queryParticles` 返回粒子含 `id` 字段（S02 dealRows 用 `p.id`，routes.js:557）→ `rowLink.href` 模板 `{id}` 有效。

---

## Task 1: 渲染器通用导航能力（metric-card `<a>` + table rowLink）

**Files:**
- Modify: `src/page/renderer.js:104-113`（`renderMetricCard`）
- Modify: `src/page/renderer.js:192-203`（`renderTable`）
- Test: `test/page/renderer-nav.test.js`

- [ ] **Step 1: 写失败测试**

`test/page/renderer-nav.test.js`：
```js
import { describe, it, expect } from 'vitest';
import { renderPage } from '../../src/page/renderer.js';

const navSchema = {
  type: 'dashboard', title: 'T', navigation: { to: '/home' },
  layout: { columns: 1, theme: 'light' },
  components: [
    { kind: 'metric-card', title: 'CARD', navigation: { to: '/x.html?focus=quoted' },
      dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [{ field: null, agg: 'count', label: '口径' }] } },
    { kind: 'table', title: 'TBL',
      dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [],
        columns: ['name'], rowLink: { textField: 'name', idField: 'id', href: '/deal-detail.html?id={id}' } }, metrics: [] },
  ],
};
const navData = { components: {
  'metric-card': { 'CARD': { value: 3 } },
  table: { 'TBL': { rows: [{ id: 'd1', name: '商机A' }] } },
} };

describe('renderer navigation', () => {
  it('metric-card with navigation.to 渲染为 <a href>', () => {
    const { html } = renderPage(navSchema, navData);
    expect(html).toContain('<a class="pg-metric-card" href="/x.html?focus=quoted"');
    expect(html).toContain('口径'); // 该用例 CARD 的 label 为'口径'，校验口径文案落片
  });
  it('table rowLink 把 textField 渲染为 <a href> 带 id', () => {
    const { html } = renderPage(navSchema, navData);
    expect(html).toContain('<a href="/deal-detail.html?id=d1">商机A</a>');
  });
  it('无 navigation 的 metric-card 维持 <div>（回归安全）', () => {
    const plain = { ...navSchema, components: [navSchema.components[0]] };
    delete plain.components[0].navigation;
    const { html } = renderPage(plain, navData);
    expect(html).toContain('<div class="pg-metric-card"');
    expect(html).not.toContain('<a class="pg-metric-card"');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**
Run: `node node_modules/vitest/vitest.mjs run test/page/renderer-nav.test.js`
Expected: FAIL（当前 `renderMetricCard` 输出 `<div>`，`renderTable` 无 `<a>`）

- [ ] **Step 3: 改 `renderMetricCard`（renderer.js:104-113）**
替换为：
```js
function renderMetricCard(comp, data) {
  const m = comp.dataBinding?.metrics?.[0] || {};
  const val = data?.value ?? data ?? null;
  const hl = comp.style?.highlight;
  const hlAttr = hl ? ` data-highlight="${hl.color}" data-highlight-op="${hl.when.op}" data-highlight-val="${escapeHtml(hl.when.value)}"` : '';
  const focusAttr = data?.highlight ? ' data-highlight="active"' : '';
  const valHtml = val === null || val === undefined
    ? '<span class="pg-value" data-state="partial">—</span>'
    : `<span class="pg-value">${escapeHtml(typeof val === 'number' ? val.toFixed(2) : val)}</span>`;
  const inner = `<h3>${escapeHtml(comp.title || '')}</h3>${valHtml}${m.label ? `<p>${escapeHtml(m.label)}</p>` : ''}`;
  const navTo = comp.navigation?.to;
  if (navTo) return `<a class="pg-metric-card" href="${escapeHtml(navTo)}"${hlAttr}${focusAttr}>${inner}</a>`;
  return `<div class="pg-metric-card"${hlAttr}${focusAttr}>${inner}</div>`;
}
```

- [ ] **Step 4: 改 `renderTable`（renderer.js:192-203）加 rowLink**
替换为：
```js
function renderTable(comp, data) {
  const rows = Array.isArray(data?.rows) ? data.rows : [];
  const cols = comp.dataBinding?.columns || [];
  const rowLink = comp.dataBinding?.rowLink; // 可选：{ textField, idField, href }
  const title = comp.title ? `<h3 class="pg-comp-title">${escapeHtml(comp.title)}</h3>` : '';
  if (!rows.length) {
    return `<div class="pg-table pg-table-empty">${title}<div class="pg-state" data-state="empty">暂无数据</div></div>`;
  }
  const head = cols.map(c => `<th>${escapeHtml(colLabel(c))}</th>`).join('');
  const body = rows.map(r => {
    const cells = cols.map(c => {
      let txt = escapeHtml(r?.[c] ?? '');
      if (rowLink && c === rowLink.textField && r?.[rowLink.idField] != null) {
        const href = rowLink.href.replace(/\{id\}/g, encodeURIComponent(String(r[rowLink.idField])));
        txt = `<a href="${escapeHtml(href)}">${txt}</a>`;
      }
      return `<td>${txt}</td>`;
    }).join('');
    return `<tr>${cells}</tr>`;
  }).join('');
  return `<table class="pg-table" data-state="partial"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}
```

- [ ] **Step 5: 为 focus 高亮补 CSS（page.css）**
在 `src/web/page.css` 末尾追加（复用设计系统 `--ac` 强调色）：
```css
.pg-metric-card[data-highlight="active"]{outline:2px solid var(--ac);box-shadow:0 0 0 3px color-mix(in srgb,var(--ac) 22%,transparent)}
```
（若 `--ac` 不存在，改为 `outline:2px solid #4f46e5;`）

- [ ] **Step 6: 跑测试确认通过**
Run: `node node_modules/vitest/vitest.mjs run test/page/renderer-nav.test.js`
Expected: PASS（3 用例）

- [ ] **Step 7: 提交**
```bash
git add src/page/renderer.js src/web/page.css test/page/renderer-nav.test.js
git commit -m "feat(render): metric-card 支持 navigation.to + table 行级 rowLink"
```

---

## Task 2: S02 三卡加 navigation + 精准口径文案

**Files:**
- Modify: `src/pages/S02.schema.js:20-34`

- [ ] **Step 1: 改三 metric-card（S02.schema.js:20-34）**
将三块替换为（保留其余组件不动）：
```js
    {
      kind: 'metric-card',
      title: '今日优先 · FIT',
      navigation: { to: '/today-priority.html?dim=FIT' },
      dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [{ field: null, agg: 'count', label: '赢率≥60% 的高匹配商机' }] },
    },
    {
      kind: 'metric-card',
      title: '今日优先 · TIMING',
      navigation: { to: '/business-board.html?focus=quoted' },
      dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [{ field: null, agg: 'count', label: '报价阶段待跟进' }] },
    },
    {
      kind: 'metric-card',
      title: '今日优先 · CONN',
      navigation: { to: '/business-board.html?focus=contracted' },
      dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [{ field: null, agg: 'count', label: '合同阶段待接触' }] },
    },
```

- [ ] **Step 2: 启动校验 schema 合法（启动即抛错机制）**
Run: `node -e "import('./src/pages/S02.schema.js').then(()=>console.log('S02 OK')).catch(e=>{console.error(e.message);process.exit(1)})"`
Expected: 输出 `S02 OK`（无 validator 报错）

- [ ] **Step 3: 提交**
```bash
git add src/pages/S02.schema.js
git commit -m "feat(s02): 三卡挂钻取导航 + 精准口径文案"
```

---

## Task 3: 业务看板 focus 高亮 + 过滤

**Files:**
- Modify: `src/http/routes.js:502-535`（`/api/page/business-board`）
- Modify: `src/web/business-board.html:34`（fetch 转发 focus）

- [ ] **Step 1: 改业务看板端点（routes.js:502-535）**
将整个 handler 替换为：
```js
  app.get('/api/page/business-board', async (req, res) => {
    try {
      const focus = req.query.focus; // 'quoted' | 'contracted' | undefined
      const types = ['CRM_DEAL', 'CRM_QUOTATION', 'CRM_CONTRACT', 'CRM_ORDER', 'CRM_PAYMENT_RECORD', 'CRM_ACCOUNT'];
      const items = [];
      for (const t of types) {
        const rows = await queryParticles({ type: t, tenantId: 'system', limit: 100 }).catch(() => []);
        items.push(...rows);
      }
      const grouped = {};
      for (const p of items) (grouped[p.type] ||= []).push(p);
      const deals = grouped.CRM_DEAL || [];
      const leadCount = deals.filter(d => (d.payload?.stage || d.state) === 'lead').length;
      const oppCount = deals.length - leadCount;
      const data = {
        components: {
          'metric-card': {
            线索: { value: leadCount },
            商机: { value: oppCount },
            报价: { value: (grouped.CRM_QUOTATION || []).length, ...(focus === 'quoted' ? { highlight: true } : {}) },
            合同: { value: (grouped.CRM_CONTRACT || []).length, ...(focus === 'contracted' ? { highlight: true } : {}) },
            订单: { value: (grouped.CRM_ORDER || []).length },
            回款: { value: (grouped.CRM_PAYMENT_RECORD || []).length },
          },
          table: {
            rows: (focus
              ? deals.filter(d => (d.payload?.stage || d.state) === focus)
              : deals
            ).map(d => ({ stage: d.payload?.stage || d.state || 'lead', name: d.payload?.name || d.title || '商机', amount: d.payload?.amount ?? '' })),
          },
        },
      };
      const rendered = renderPage(S15_SCHEMA, data);
      res.json({ schema: S15_SCHEMA, data, html: rendered.html, warnings: rendered.warnings });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
```

- [ ] **Step 2: 改 business-board.html 转发 focus（:34）**
将 fetch 行替换为：
```js
        const focus = new URLSearchParams(location.search).get('focus') || '';
        const bbUrl = '/api/page/business-board' + (focus ? `?focus=${encodeURIComponent(focus)}` : '');
        const res = await fetch(bbUrl, { headers: { Authorization: `Bearer ${localStorage.getItem('crm_token') || ''}` } });
```

- [ ] **Step 3: 提交**
```bash
git add src/http/routes.js src/web/business-board.html
git commit -m "feat(board): 业务看板支持 ?focus=quoted|contracted 过滤高亮"
```

---

## Task 4: 新建今日优先明细页（FIT 钻取目标）

**Files:**
- Create: `src/pages/S34.schema.js`
- Modify: `src/http/routes.js`（`:79` 附近加 import；新增端点；`:1877` 附近加 html 路由）
- Create: `src/web/today-priority.html`

- [ ] **Step 1: 建 S34 schema**
`src/pages/S34.schema.js`：
```js
// src/pages/S34.schema.js — S34 今日优先·高匹配商机明细（FIT 钻取目标）
// 数据面：CRM_DEAL 中 payload.probability >= 0.6；行级 rowLink → /deal-detail.html?id={id}
import { validatePageSchema } from '../page/validator.js';

export const schema = {
  type: 'dashboard',
  title: '今日优先 · 高匹配商机',
  navigation: { to: '/home' },
  layout: { columns: 1, theme: 'light' },
  components: [
    {
      kind: 'table',
      title: '赢率≥60% 的高匹配商机',
      dataBinding: {
        source: 'particle', particleType: 'CRM_DEAL', filters: [],
        columns: ['name', 'stage', 'probability', 'amount', 'owner'],
        rowLink: { textField: 'name', idField: 'id', href: '/deal-detail.html?id={id}' },
      },
      metrics: [],
    },
  ],
};

const v = validatePageSchema(schema);
if (!v.ok) throw new Error('S34 schema 非法: ' + v.errors[0]);
```

- [ ] **Step 2: 加 S34 import（routes.js，紧邻 S02 导入 :79）**
```js
  import { schema as S34_SCHEMA } from '../pages/S34.schema.js';
```

- [ ] **Step 3: 加 today-priority 端点（routes.js，放在 `/api/page/home` 端点 :605 之后）**
```js
  // ─── S34 今日优先·高匹配商机明细（FIT 钻取目标）───
  // 契约：GET /api/page/today-priority?dim=FIT → { schema:S34, data, html }；html=renderPage 产物
  app.get('/api/page/today-priority', async (req, res) => {
    try {
      const dim = req.query.dim;
      const rows = await queryParticles({ type: 'CRM_DEAL', tenantId: 'system', limit: 100 }).catch(() => []);
      const fitRows = (dim === 'FIT' ? rows.filter(d => (d.payload?.probability ?? 0) >= 0.6) : rows)
        .map(d => ({
          id: d.id,
          name: d.payload?.name || d.title || '商机',
          stage: d.payload?.stage || 'lead',
          probability: d.payload?.probability ?? '',
          amount: d.payload?.expected_amount ?? d.payload?.amount ?? '',
          owner: d.payload?.owner ?? '',
        }));
      const data = { components: { table: { '赢率≥60% 的高匹配商机': { rows: fitRows } } } };
      const rendered = renderPage(S34_SCHEMA, data);
      res.json({ schema: S34_SCHEMA, data, html: rendered.html, warnings: rendered.warnings });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
```

- [ ] **Step 4: 加静态壳路由（routes.js，紧邻 `/home.html` :1877）**
```js
  app.get('/today-priority.html', (req, res) => res.sendFile(fileURLToPath(new URL('../web/today-priority.html', import.meta.url))));
```

- [ ] **Step 5: 建 today-priority.html 壳**
`src/web/today-priority.html`：
```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"><title>今日优先 · 高匹配商机</title>
<link rel="stylesheet" href="/portal/tokens.css">
<link rel="stylesheet" href="/portal/common.css">
<link rel="stylesheet" href="/portal/page.css">
<script type="module" src="/portal/components.js"></script>
</head>
<body>
<div id="tp-root" data-schema="S34"><div class="pg-state" data-state="loading">加载中…</div></div>
<script type="module">
import { injectLayout } from '/portal/layout.js';
const token = localStorage.getItem('crm_token');
if (!token) { location.href = '/home.html'; }
injectLayout();
const root = document.getElementById('tp-root');
(async () => {
  try {
    const dim = new URLSearchParams(location.search).get('dim') || 'FIT';
    const res = await fetch('/api/page/today-priority?dim=' + encodeURIComponent(dim), { headers: { Authorization: `Bearer ${token}` } });
    const j = await res.json();
    if (j.html) root.innerHTML = j.html;
    else root.innerHTML = '<div class="pg-state" data-state="error">出片为空</div>';
  } catch (e) {
    root.innerHTML = `<div class="pg-state" data-state="error">加载失败：${String(e.message)}</div>`;
  }
})();
</script>
</body></html>
```

- [ ] **Step 6: 校验 S34 schema 合法 + 端点返回 3 行**
Run: `node -e "import('./src/pages/S34.schema.js').then(()=>console.log('S34 OK')).catch(e=>{console.error(e.message);process.exit(1)})"`
Expected: `S34 OK`
（端点返回需启动 server 在 Task 5 实测；此处仅 schema 静态校验）

- [ ] **Step 7: 提交**
```bash
git add src/pages/S34.schema.js src/http/routes.js src/web/today-priority.html
git commit -m "feat(s21): 今日优先·高匹配商机明细页（FIT 钻取目标）"
```

---

## Task 5: 端到端验证（启动 server 实测三卡钻取）

**Files:** 无新增，验证用

- [ ] **Step 1: 启动 server**
Run（后台）: `node src/http/server.js` （或用仓库启动脚本；确认 `routes.js` 改动已加载——routes.js 启动时加载，改后须重启）
- [ ] **Step 2: 验证 FIT 钻取**
浏览器/ curl：`GET /api/page/today-priority?dim=FIT` → 期望 3 行（食品礼盒全年框架 / 年报精装印刷 / 药品说明书画册），每行 name 为 `<a href="/deal-detail.html?id=...">`
- [ ] **Step 3: 验证 TIMING 钻取**
`GET /api/page/business-board?focus=quoted` → table 仅 quoted 行（药品说明书画册 1 条），「报价」卡 `data-highlight="active"`
- [ ] **Step 4: 验证 CONN 钻取**
`GET /api/page/business-board?focus=contracted` → table 仅 contracted 行（3 条），「合同」卡高亮
- [ ] **Step 5: 验证首页三卡出片**
`GET /api/page/home` → html 中三卡为 `<a class="pg-metric-card" href=...>`，副标题分别为「赢率≥60% 的高匹配商机」「报价阶段待跟进」「合同阶段待接触」；无 `navigation` 的其它页（S15 默认无 focus）不破
- [ ] **Step 6: 全量回归测试**
Run: `node node_modules/vitest/vitest.mjs run`（仅单进程；勿并发两 vitest）

---

## 自审（Self-Review）

**1. 规格覆盖：**
- FIT 点数字→明细页 ✓ Task 4；TIMING/CONN→看板 focus ✓ Task 3；文案校准 ✓ Task 2；渲染器导航 ✓ Task 1。
- 设计文档 §3 四任务全部映射，无遗漏。

**2. 占位符扫描：** 无 TBD/TODO；每步含完整代码与命令。

**3. 类型一致性：**
- `rowLink = { textField, idField, href }` 在 S34 schema 与 renderer.js 一致。
- `navigation.to` 在 S02/S34 schema 与 renderer 读取 `comp.navigation?.to` 一致。
- `data.highlight` 旗标：业务看板端点写 `highlight:true`（Task 3），renderer 读 `data?.highlight`（Task 1）一致。
- `focus` query 名在端点（req.query.focus）、business-board.html 转发、设计文档三处一致。

**4. 已知风险：**
- page.css 的 `--ac` 变量名需 Step 5 实测确认；若缺失按备注降级为 `#4f46e5`。
- routes.js 启动加载：改后必须重启 server（Task 5 Step 1 注明）。
- 测试库 vs 生产库：单元/集成测试走 vitest（plm_test）；端点返回 3 行验证用生产库只读。
