# 7 类业务详情页（扩展 particle-detail）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有通用 `particle-detail.html` 之上，为 7 类真实业务粒子（CRM_DEAL / CRM_QUOTATION / CRM_CONTRACT / CRM_ORDER / CRM_PAYMENT_PLAN / CRM_PAYMENT_RECORD / CRM_INVOICE）注入类型专属只读视图，并补齐深链别名与导航入口，闭环 A 组"7 类详情页待设计"缺口。

**Architecture:** 单页复用 + 新增浏览器 ESM 模块 `src/portal/detailSections.js`（纯函数 `renderBusinessSections(particle, edges, related)`，返回 HTML 字符串，无 DOM 依赖，可被 vitest 直测）。`particle-detail.html` 在通用 `renderAttrs` 之上按 `particle.type` 调用注入业务 section；类型未知时降级为现有通用 dump。不新增任何后端端点（完全复用 `/api/particles/:id` + edges + related）。`routes.js` 仅补深链别名（复用同一 HTML）。

**Tech Stack:** 原生 HTML + 浏览器 ESM（`type="module"` 注入全局），Node 22 + vitest 3（environment: node），Express 4（仅 `sendFile` 静态深链）。

**关键事实（已核验，避免凭空设计）：**
- `CRM_LEAD` 非真实粒子（`src/alerts/alertRegistry.js:17` / `src/sales/pool.js:3` 明确：线索 = `CRM_DEAL` 的 `lead` 阶段）。故"线索"与"商机"共用 `CRM_DEAL` 渲染器（L2C 进度条 stage=lead 即线索）。
- 7 类粒子 payload 字段取自 `src/particles/particleModel.js:6-135`：
  - CRM_DEAL: `name, stage(lead/opportunity/quoted/contracted/ordered/paid/lost/disqualified), amount, expected_close`
  - CRM_QUOTATION: `name, deal_id(record-ref), valid_until, amount, items([{product_id,qty,unit_price,discount,tax}]), approval_status`
  - CRM_CONTRACT: `contract_no, deal_id, quotation_id, amount, start_date, end_date, approval_status`
  - CRM_ORDER: `order_no, deal_id, contract_id, amount, status`
  - CRM_PAYMENT_PLAN: `contract_id, plan_amount, plan_end, plan_status`
  - CRM_PAYMENT_RECORD: `contract_id, paid_amount, paid_at, voucher(url)`
  - CRM_INVOICE: `invoice_no, invoice_type, invoice_amount, invoice_date, contract_id, reconcile_status`
- 数据端点返回结构（`src/http/routes.js:100-115`）：`{ particle:{id,type,payload,state}, outEdges:[{edgeType,targetType,targetId,meta}], related:{[targetId]:name} }`。
- 前端模块挂载约定：`src/portal/scoring.js` 经 `app.get('/portal/scoring.js')` 服务；`src/web/nav.js` 经 `app.get('/portal/nav.js')` 服务（`routes.js:679-684`）。同类新增 `/portal/detailSections.js`。
- 测试范式：`test/portal-scoring.test.js` 在 node 环境 `import { ... } from '../src/portal/scoring.js'` 直测 ESM 纯函数。

---

### Task 1: 写失败测试（detailSections 7 类 + 未知降级）

**Files:**
- Create: `test/web/detailSections.test.js`

- [ ] **Step 1: 写失败测试**

```js
// test/web/detailSections.test.js — 7 类业务详情 section 渲染单测（纯函数，node 环境）
import { describe, it, expect } from 'vitest';
import { renderBusinessSections, hasBusinessSection } from '../src/portal/detailSections.js';

const base = (type, payload = {}) => ({ id: 'p1', type, payload, state: 'active' });

describe('hasBusinessSection', () => {
  it('7 类真实粒子返回 true', () => {
    for (const t of ['CRM_DEAL','CRM_QUOTATION','CRM_CONTRACT','CRM_ORDER','CRM_PAYMENT_PLAN','CRM_PAYMENT_RECORD','CRM_INVOICE'])
      expect(hasBusinessSection(t)).toBe(true);
  });
  it('未知类型返回 false（降级通用 dump）', () => {
    expect(hasBusinessSection('CRM_ACCOUNT')).toBe(false);
    expect(hasBusinessSection('FOO')).toBe(false);
  });
});

describe('renderBusinessSections — CRM_DEAL', () => {
  it('输出 L2C 进度条与金额', () => {
    const html = renderBusinessSections(base('CRM_DEAL', { name: 'X', stage: 'opportunity', amount: 100000 }), [], {});
    expect(html).toContain('data-section="l2c"');
    expect(html).toContain('商机');           // 当前阶段标签
    expect(html).toContain('¥100,000');
  });
  it('stage=lead 显示「线索」', () => {
    const html = renderBusinessSections(base('CRM_DEAL', { stage: 'lead' }), [], {});
    expect(html).toContain('线索');
  });
});

describe('renderBusinessSections — CRM_QUOTATION', () => {
  it('渲染明细子表与关联商机链接', () => {
    const html = renderBusinessSections(
      base('CRM_QUOTATION', { name: 'Q1', deal_id: 'd1', amount: 5000, items: [{ product_id: 'pr1', qty: 2, unit_price: 2500 }] }),
      [], {});
    expect(html).toContain('data-section="quotation"');
    expect(html).toContain('pg-subtable');     // 明细子表
    expect(html).toContain('/deals/d1');        // 关联商机深链
    expect(html).toContain('¥5,000');
  });
});

describe('renderBusinessSections — CRM_CONTRACT', () => {
  it('渲染合同要素与关联深链', () => {
    const html = renderBusinessSections(
      base('CRM_CONTRACT', { contract_no: 'C1', deal_id: 'd1', quotation_id: 'q1', amount: 8000 }), [], {});
    expect(html).toContain('data-section="contract"');
    expect(html).toContain('C1');
    expect(html).toContain('/deals/d1');
    expect(html).toContain('/quotes/q1');
  });
});

describe('renderBusinessSections — CRM_ORDER', () => {
  it('渲染订单要素与关联合同/商机', () => {
    const html = renderBusinessSections(
      base('CRM_ORDER', { order_no: 'O1', deal_id: 'd1', contract_id: 'c1', amount: 8000, status: 'confirmed' }), [], {});
    expect(html).toContain('data-section="order"');
    expect(html).toContain('O1');
    expect(html).toContain('/contracts/c1');
  });
});

describe('renderBusinessSections — CRM_PAYMENT_PLAN', () => {
  it('渲染回款计划要素', () => {
    const html = renderBusinessSections(
      base('CRM_PAYMENT_PLAN', { contract_id: 'c1', plan_amount: 4000, plan_end: '2026-09-01', plan_status: 'pending' }), [], {});
    expect(html).toContain('data-section="payment-plan"');
    expect(html).toContain('¥4,000');
    expect(html).toContain('/contracts/c1');
  });
});

describe('renderBusinessSections — CRM_PAYMENT_RECORD', () => {
  it('渲染回款记录要素', () => {
    const html = renderBusinessSections(
      base('CRM_PAYMENT_RECORD', { contract_id: 'c1', paid_amount: 4000, paid_at: '2026-08-20' }), [], {});
    expect(html).toContain('data-section="payment-record"');
    expect(html).toContain('¥4,000');
    expect(html).toContain('/contracts/c1');
  });
});

describe('renderBusinessSections — CRM_INVOICE', () => {
  it('渲染发票要素与关联合同', () => {
    const html = renderBusinessSections(
      base('CRM_INVOICE', { invoice_no: 'INV1', contract_id: 'c1', invoice_amount: 8000, reconcile_status: 'open' }), [], {});
    expect(html).toContain('data-section="invoice"');
    expect(html).toContain('INV1');
    expect(html).toContain('/contracts/c1');
  });
});

describe('renderBusinessSections — 未知类型降级', () => {
  it('返回空串（页面仅渲染通用 dump）', () => {
    expect(renderBusinessSections(base('CRM_ACCOUNT'), [], {})).toBe('');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /d/system/CRM-ai-native && node node_modules/vitest/vitest.mjs run test/web/detailSections.test.js`
Expected: FAIL（`Cannot find module '../src/portal/detailSections.js'` 或 `renderBusinessSections is not exported`）。

- [ ] **Step 3: （占位，Task 2 实现后通过）**

- [ ] **Step 4: 提交**

```bash
git add test/web/detailSections.test.js
git commit -m "test: 7 类业务详情 section 渲染纯函数单测（RED）"
```

---

### Task 2: 实现 detailSections.js（7 类 section 渲染器）

**Files:**
- Create: `src/portal/detailSections.js`

- [ ] **Step 1: 写实现（含 7 类渲染 + 未知降级 + 关联边链接）**

```js
// src/portal/detailSections.js — 7 类业务粒子专属只读视图（浏览器 + vitest 共用 ESM，无 DOM 依赖）
// 用法：particle-detail.html 经 <script type="module"> 注入 window.renderBusinessSections 后调用。
// 数据：particle={id,type,payload,state}；edges=outEdges[{edgeType,targetType,targetId,meta}]；related={[targetId]:name}

const TYPE_BY_PATH = {
  CRM_DEAL: 'deals', CRM_QUOTATION: 'quotes', CRM_CONTRACT: 'contracts',
  CRM_ORDER: 'orders', CRM_PAYMENT_PLAN: 'payments', CRM_PAYMENT_RECORD: 'payments',
  CRM_INVOICE: 'invoices', CRM_ACCOUNT: 'accounts', CRM_TECHNICAL_PROPOSAL: 'particle-detail.html?id',
};
const SUPPORTED = new Set(Object.keys(TYPE_BY_PATH).filter(t => t.startsWith('CRM_')));
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c] || c);
const money = (n) => {
  const v = Number(n); if (!Number.isFinite(v)) return esc(n ?? '—');
  return '¥' + v.toLocaleString('zh-CN');
};
const date = (s) => (s ? esc(String(s).slice(0, 10)) : '—');
// 关联链接：优先 outEdge.targetType→path；其次 payload 中 *id record-reference 字段
function relatedLinks(particle, edges, related) {
  const out = (edges || [])
    .filter((e) => TYPE_BY_PATH[e.targetType])
    .map((e) => {
      const p = TYPE_BY_PATH[e.targetType];
      const href = p.startsWith('/') ? `${p}=${esc(e.targetId)}` : `/${p}/${esc(e.targetId)}`;
      const label = related?.[e.targetId] || e.targetType;
      return `<a href="${href}">${esc(label)}</a>`;
    });
  const fromPayload = Object.entries(particle.payload || {})
    .filter(([k, v]) => /_id$/.test(k) && typeof v === 'string' && v && TYPE_BY_PATH[foreignType(k)])
    .map(([k, v]) => {
      const t = foreignType(k); const p = TYPE_BY_PATH[t];
      const href = p.startsWith('/') ? `${p}=${esc(v)}` : `/${p}/${esc(v)}`;
      return `<a href="${href}">${esc(labelOf(k))} ${esc(v)}</a>`;
    });
  const all = [...out, ...fromPayload];
  return all.length ? `<div class="edge">关联：${all.join(' · ')}</div>` : '';
}
const FK = { deal_id: 'CRM_DEAL', quotation_id: 'CRM_QUOTATION', contract_id: 'CRM_CONTRACT', order_id: 'CRM_ORDER', account_id: 'CRM_ACCOUNT' };
const foreignType = (k) => FK[k];
const labelOf = (k) => ({ deal_id: '商机', quotation_id: '报价', contract_id: '合同', order_id: '订单', account_id: '客户' }[k] || k);

const L2C = [
  ['lead', '线索'], ['opportunity', '商机'], ['quoted', '报价'],
  ['contracted', '合同'], ['ordered', '订单'], ['paid', '回款'],
];
function dealSection(p) {
  const stage = p.payload.stage || 'lead';
  const idx = L2C.findIndex(([s]) => s === stage);
  const steps = L2C.map(([s, label], i) => {
    const cls = i < idx ? 'done' : i === idx ? 'cur' : 'todo';
    return `<span class="l2c-step ${cls}">${label}</span>`;
  }).join('<span class="l2c-sep">›</span>');
  const term = (stage === 'lost' || stage === 'disqualified')
    ? `<span class="badge b-rule">已终止（${esc(stage)}）</span>` : '';
  const facts = [
    ['金额', money(p.payload.amount)],
    ['预计成交', date(p.payload.expected_close)],
    ['状态', esc(p.state)],
  ].map(([k, v]) => `<div class="attr"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('');
  return `<div class="card" data-section="l2c"><h3>L2C 阶段进度</h3>
    <div class="l2c">${steps}</div>${term}
    <div style="margin-top:8px">${facts}</div></div>`;
}
function quotationSection(p, edges, related) {
  const items = Array.isArray(p.payload.items) ? p.payload.items : [];
  const rows = items.length ? items.map((it) => {
    const amt = (Number(it.qty) || 0) * (Number(it.unit_price) || 0);
    return `<tr><td>${esc(it.product_id)}</td><td>${esc(it.qty)}</td><td>${money(it.unit_price)}</td><td>${money(it.discount || 0)}</td><td>${money(amt)}</td></tr>`;
  }).join('') : '<tr><td colspan="5" class="none">无明细行</td></tr>';
  return `<div class="card" data-section="quotation"><h3>报价单</h3>
    <div class="attr"><span class="k">状态</span><span class="badge b-manual">${esc(p.payload.approval_status || p.state)}</span></div>
    <div class="attr"><span class="k">有效期至</span><span class="v">${date(p.payload.valid_until)}</span></div>
    <div class="attr"><span class="k">总金额</span><span class="v">${money(p.payload.amount)}</span></div>
    <table class="pg-subtable"><thead><tr><th>产品</th><th>数量</th><th>单价</th><th>折扣</th><th>小计</th></tr></thead><tbody>${rows}</tbody></table>
    ${relatedLinks(p, edges, related)}</div>`;
}
function contractSection(p, edges, related) {
  const facts = [
    ['合同号', esc(p.payload.contract_no)], ['金额', money(p.payload.amount)],
    ['生效', date(p.payload.start_date)], ['到期', date(p.payload.end_date)],
    ['审批', esc(p.payload.approval_status || p.state)],
  ].map(([k, v]) => `<div class="attr"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('');
  return `<div class="card" data-section="contract"><h3>合同</h3>${facts}${relatedLinks(p, edges, related)}</div>`;
}
function orderSection(p, edges, related) {
  const facts = [
    ['订单号', esc(p.payload.order_no)], ['金额', money(p.payload.amount)],
    ['状态', esc(p.payload.status || p.state)],
  ].map(([k, v]) => `<div class="attr"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('');
  return `<div class="card" data-section="order"><h3>订单</h3>${facts}${relatedLinks(p, edges, related)}</div>`;
}
function paymentPlanSection(p, edges, related) {
  const facts = [
    ['计划金额', money(p.payload.plan_amount)], ['到期', date(p.payload.plan_end)],
    ['状态', esc(p.payload.plan_status || p.state)],
  ].map(([k, v]) => `<div class="attr"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('');
  return `<div class="card" data-section="payment-plan"><h3>回款计划</h3>${facts}${relatedLinks(p, edges, related)}</div>`;
}
function paymentRecordSection(p, edges, related) {
  const facts = [
    ['实收金额', money(p.payload.paid_amount)], ['收款日期', date(p.payload.paid_at)],
    ['凭证', p.payload.voucher ? `<a href="${esc(p.payload.voucher)}">查看</a>` : '—'],
  ].map(([k, v]) => `<div class="attr"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('');
  return `<div class="card" data-section="payment-record"><h3>回款记录</h3>${facts}${relatedLinks(p, edges, related)}</div>`;
}
function invoiceSection(p, edges, related) {
  const facts = [
    ['发票号', esc(p.payload.invoice_no)], ['类型', esc(p.payload.invoice_type)],
    ['金额', money(p.payload.invoice_amount)], ['开票日期', date(p.payload.invoice_date)],
    ['核销', esc(p.payload.reconcile_status || p.state)],
  ].map(([k, v]) => `<div class="attr"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('');
  return `<div class="card" data-section="invoice"><h3>发票</h3>${facts}${relatedLinks(p, edges, related)}</div>`;
}

const RENDERERS = {
  CRM_DEAL: dealSection, CRM_QUOTATION: quotationSection, CRM_CONTRACT: contractSection,
  CRM_ORDER: orderSection, CRM_PAYMENT_PLAN: paymentPlanSection,
  CRM_PAYMENT_RECORD: paymentRecordSection, CRM_INVOICE: invoiceSection,
};

export function hasBusinessSection(type) {
  return SUPPORTED.has(type) && Boolean(RENDERERS[type]);
}
export function renderBusinessSections(particle, edges = [], related = {}) {
  if (!particle || !RENDERERS[particle.type]) return '';
  try {
    return RENDERERS[particle.type](particle, edges, related);
  } catch {
    return ''; // 渲染异常不阻塞通用 dump
  }
}
```

- [ ] **Step 2: 运行测试确认通过**

Run: `cd /d/system/CRM-ai-native && node node_modules/vitest/vitest.mjs run test/web/detailSections.test.js`
Expected: PASS（7 类 + 降级全绿）。

- [ ] **Step 3: 提交**

```bash
git add src/portal/detailSections.js test/web/detailSections.test.js
git commit -m "feat: 7 类业务详情 section 渲染纯函数（GREEN）"
```

---

### Task 3: 页面接入（particle-detail.html 注入 + 深链引导）

**Files:**
- Modify: `src/web/particle-detail.html` （注入模块 + showDetail 调用 + 深链 bootstrap + section 样式）

- [ ] **Step 1: 在 `<style>` 内追加 section/进度条样式（在 `</style>` 前插入）**

```css
  .l2c { display:flex; flex-wrap:wrap; align-items:center; gap:6px; margin:6px 0; }
  .l2c-step { padding:3px 10px; border-radius:12px; font-size:12px; border:1px solid #ddd; color:#888; background:#fafafa; }
  .l2c-step.done { background:#0f7b63; color:#fff; border-color:#0f7b63; }
  .l2c-step.cur { background:#1a4fb8; color:#fff; border-color:#1a4fb8; }
  .l2c-sep { color:#aaa; }
  .pg-subtable { width:100%; border-collapse:collapse; margin-top:8px; font-size:12px; }
  .pg-subtable th, .pg-subtable td { border:1px solid #eee; padding:5px 8px; text-align:left; }
  .pg-subtable th { background:#f5f7fa; color:#555; }
```

- [ ] **Step 2: 在 `showDetail` 注入业务 section（修改 `document.getElementById('detail').innerHTML = ...` 模板，在 `renderAttrs(p)` 之前加 section）**

将 `showDetail` 内：
```js
  document.getElementById('detail').innerHTML = `
    <h4 style="margin:6px 0 4px">事实字段与来源徽标</h4>
    ${renderAttrs(p)}
```
改为：
```js
  const biz = (window.renderBusinessSections ? window.renderBusinessSections(p, d.outEdges, d.related) : '');
  document.getElementById('detail').innerHTML = `
    ${biz}
    <h4 style="margin:6px 0 4px">事实字段与来源徽标</h4>
    ${renderAttrs(p)}
```

- [ ] **Step 3: 在 `</script>` 前追加模块导入（挂全局）+ 深链 bootstrap**

在末尾 `loadList();` 之前插入：
```html
<script type="module">
  import { renderBusinessSections } from '/portal/detailSections.js';
  window.renderBusinessSections = renderBusinessSections;
</script>
```
并将末尾的：
```js
loadList();
```
改为：
```js
// 深链引导：/deals/:id 等路径别名 → 解析 id 并预载详情；?id= 同效
(function bootstrapDetail(){
  const m = location.pathname.match(/^\/(deals|quotes|contracts|orders|payments|invoices|leads)\/([^/]+)$/);
  if (m) {
    const typeMap = { deals:'CRM_DEAL', leads:'CRM_DEAL', quotes:'CRM_QUOTATION', contracts:'CRM_CONTRACT', orders:'CRM_ORDER', payments:'CRM_PAYMENT_PLAN', invoices:'CRM_INVOICE' };
    const sel = document.getElementById('typeFilter');
    if (sel) sel.value = typeMap[m[1]] || '';
    loadList();
    showDetail(decodeURIComponent(m[2]));
    return;
  }
  const q = new URLSearchParams(location.search).get('id');
  if (q) showDetail(q);
})();
loadList();
```

- [ ] **Step 4: 运行测试 + 启动校验**

Run: `cd /d/system/CRM-ai-native && node node_modules/vitest/vitest.mjs run test/web/detailSections.test.js`
Expected: PASS（页面改动不影响纯函数测试）。

- [ ] **Step 5: 提交**

```bash
git add src/web/particle-detail.html
git commit -m "feat: particle-detail 注入 7 类业务 section + 深链引导"
```

---

### Task 4: 路由深链别名 + 模块挂载 + 导航入口

**Files:**
- Modify: `src/http/routes.js` （line 638 附近，补 7 个深链 + /portal/detailSections.js）
- Modify: `src/web/nav.js` （新增「🔍 粒子详情」入口）

- [ ] **Step 1: routes.js 补深链别名 + 模块挂载（紧接 `app.get('/particle-detail.html', ...)` 之后）**

在 `src/http/routes.js:638-639` 的 `app.get('/particle-detail.html', ...)` 块之后插入：
```js
  // 7 类业务实体深链别名：复用 particle-detail.html（前端从 path 解析 type/id）
  const detailAlias = (p) => app.get(p, (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/particle-detail.html', import.meta.url))));
  ['/deals/:id','/quotes/:id','/contracts/:id','/orders/:id','/payments/:id','/invoices/:id','/leads/:id'].forEach(detailAlias);
  // 业务 section 渲染模块（ESM，浏览器 + vitest 共用）
  app.get('/portal/detailSections.js', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../portal/detailSections.js', import.meta.url)), { headers: { 'Content-Type': 'text/javascript' } }));
```

- [ ] **Step 2: nav.js 新增入口（ITEMS 数组补一项）**

在 `src/web/nav.js` 的 `ITEMS` 数组（line 14 `{ href: '/?pool', label: '⚙ 线索池配置' }` 之后）追加：
```js
  { href: '/particle-detail.html', label: '🔍 粒子详情' },
```

- [ ] **Step 3: 运行全量相关测试**

Run: `cd /d/system/CRM-ai-native && node node_modules/vitest/vitest.mjs run test/web/detailSections.test.js test/page/workbench-page.test.js`
Expected: PASS。

- [ ] **Step 4: 提交**

```bash
git add src/http/routes.js src/web/nav.js
git commit -m "feat: 业务详情深链别名 + detailSections 模块挂载 + 导航入口"
```

---

### 自审（Self-Review）

- **Spec 覆盖**：7 类（DEAL/QUOTATION/CONTRACT/ORDER/PAYMENT_PLAN/PAYMENT_RECORD/INVOICE）均有 section 渲染器 ✓；未知类型降级 ✓；深链别名 7 个 ✓；导航入口 ✓；TDD 红→绿 ✓。
- **占位扫描**：无 TBD/TODO；每个 step 含真实代码 ✓。
- **类型一致性**：`renderBusinessSections(particle, edges, related)` 签名在 Task1 测试、Task2 实现、Task3 调用三处一致 ✓；`hasBusinessSection(type)` 同签 ✓；`TYPE_BY_PATH` / `foreignType` / `labelOf` 在 Task2 内自洽 ✓。
- **无新增后端端点**：仅 `sendFile` 静态 + 已有 `/api/particles/:id` ✓（符合设计 YAGNI）。
- **范围边界**：不含写入/审批按钮（本期只读）✓；不含 B 组配置中心 ✓。
