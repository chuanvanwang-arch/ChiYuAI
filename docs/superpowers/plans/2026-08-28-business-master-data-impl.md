# 业务主数据门户 · P0 五面实施计划（Implementation Plan）

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **设计基线：** `docs/superpowers/specs/2026-08-28-business-master-data-design.md`（✅ 用户已批准 2026-08-28 15:59）。本计划是其实施落地版，范围 = P0 全五面（不覆盖 P1/P2）。

**Goal:** 交付「📚 基础数据」门户（与配置中心边界分离），含 5 个业务主数据维护面（产品目录 / 基础价格表 / 报价商务规则包 / 字典值域 / 回款政策）+ 门户总览 + 导航入口 + 4 个新粒子注册。写经决策第 0 闸（非 DEAL 降级先例路径）、禁删=软停用。让前台真正出现「业务数据设置」入口并可维护。

---

## §0 现状核实（证据）

| 项 | 证据 | 结论 |
|---|---|---|
| 设计已批准 | `docs/superpowers/specs/2026-08-28-business-master-data-design.md:3` | ✅ 已批准，未实现 |
| 5 个维护页 | `src/web/*.html` 45 个页面中无 product-catalog/price-list/offer-policy/dict-entries/payment-policy | ❌ 未建 |
| 门户总览 | 全仓 Grep `businessDataCenter` 0 命中 | ❌ 未建 |
| 导航入口 | `src/portal/layoutMenu.js`（非设计误写的 nav.js）；FULL_MENU/ADMIN_MENU 无「基础数据」组 | ❌ 未建 |
| 4 新粒子 | `particleModel.js:45/51` 仅 `CRM_PRODUCT`/`CRM_PRICE_LIST`；无 OFFER_POLICY/DICT_ENTRY/COMPETITOR/RESOURCE_CALENDAR | ❌ 未注册 |
| 写通道 | `routes.js:191` `POST /api/particles` → 非 DEAL 走 `bootstrap`+`recordDecisionEvent`（`routes.js:218-224`）；`data-particle-create` 已注册（`whitelist.js:6`/`seed-actions.js:20`） | ✅ 已就位，直接复用 |
| 读通道 | `routes.js:131` `GET /api/particles?type=` 已就位 | ✅ 已就位，直接复用 |
| 停用通道 | `scope.js:56` 含 `data-particle-update`（白名单）；需核实 routes 是否挂 `PATCH /api/particles/:id` | ⚠️ 待核实/补 |

## §1 架构纪律（不可破）

1. **粒子统一建模**：新增主数据 = 在 `particleModel.js` 的 `PARTICLE_TYPES` 注册类型 + `coreAttributes`；属性类型 ∈ 19 类型集（`particleModel.js:211`）。复杂嵌套（OFFER_POLICY `cost_structure`/`price_bands`）用 `'text'` 类型存 JSON 字符串（payload 即 JSONB，可任意存）；UI 编辑由对应 Render 子模块自定义解析。
2. **Render 纯函数子模块**（2026-08-27 QA 铁律）：`src/portal/*Render.js` 零服务端 import（浏览器 ESM 可加载）；页面 `import` 必须指向子模块。混合文件顶层含 express/db → 浏览器崩溃。
3. **写经决策第 0 闸**：页面 POST `/api/particles` 非 DEAL 类型自动落 `config_change` 审计链（`routes.js:223`），**页面无需传 decision_id**。
4. **禁删铁律**：所有「删除」按钮 = 软停用（PATCH `state` 流转），物理删除绝对不做。
5. **样式链**：受控渲染页必链 `/portal/page.css`（设计文档 §1.2 铁律）；为视觉一致复用 `config.html` 的 `.cfg-card/.cfg-grid` 卡片类，同时链 `/portal/tokens.css` + `/portal/common.css`。
6. **权限模型（P0 简化）**：写入 `data-particle-create` 当前 `permission:'auth'`（登录即可写，`seed-actions.js:20`）。P0 菜单入口对全员可见（销售可看产品/字典），**细分 RBAC（admin/商务/销售管理可写、销售只读）作为 P1 增强**，不在本计划范围；不影响 P0 验证。

## §2 文件结构

- 改 `src/particles/particleModel.js`：+4 粒子注册 + `CRM_PRODUCT.category`
- 新 `src/portal/businessDataCenter.js`：门户总览渲染（同构 `configCenter.js`）
- 新 `src/web/business-data.html`：门户总览页
- 新 5 组维护面（每组 = Render 子模块 + html 页）：
  - `src/portal/productCatalogRender.js` + `src/web/product-catalog.html`
  - `src/portal/priceListRender.js` + `src/web/price-list.html`
  - `src/portal/offerPolicyRender.js` + `src/web/offer-policy.html`
  - `src/portal/dictEntriesRender.js` + `src/web/dict-entries.html`
  - `src/portal/paymentPolicyRender.js` + `src/web/payment-policy.html`
- 改 `src/http/routes.js`：6 页 + 6 Render 静态段 + 停用例 `PATCH /api/particles/:id`
- 改 `src/portal/layoutMenu.js`：FULL_MENU 加「📚 基础数据」组（门户 + 5 面入口）
- 新 `test/web/businessDataCenter.test.js`、`test/web/offerPolicyConsume.test.js`
- 本计划文档

---

## Task 0: 粒子模型扩展（4 新粒子 + PRODUCT.category）

**Files:** Modify `src/particles/particleModel.js`

- [ ] **Step 1: `CRM_PRODUCT` 补 `category` coreAttribute**（在 `:48` 后插入）

```js
  CRM_PRODUCT: {
    slug: 'product', title: '产品',
    identity: ['name'],
    states: { current: 'on_sale', flow: ['on_sale', 'discontinued'] },
    why: 'price_change_reason',
    coreAttributes: {
      name: 'text', unit: 'text', category: 'select', list_price: 'currency', status: 'select',
    },
  },
```

- [ ] **Step 2: 在 `CRM_TECHNICAL_PROPOSAL`（`:148`）前插入 4 新粒子**

```js
  // —— 业务主数据门户（P0，2026-08-28 实施计划）——
  CRM_OFFER_POLICY: {
    slug: 'offer-policy', title: '报价商务规则包',
    identity: ['name'],
    states: { current: 'draft', flow: ['draft', 'active', 'expired'] },
    why: 'policy_change_reason',
    coreAttributes: {
      name: 'text', subtype: 'select', cost_structure: 'text', price_bands: 'text',
      discount_conditions: 'text', margin_redline: 'currency', tier_discount: 'text',
      change_billing: 'text', valid_from: 'date', valid_to: 'date',
    },
  },
  CRM_DICT_ENTRY: {
    slug: 'dict-entry', title: '字典值域',
    identity: ['dict_key', 'dict_value'],
    states: { current: 'registered', flow: ['registered', 'deprecated'] },
    coreAttributes: {
      dict_key: 'select', dict_value: 'text', sort_order: 'number', active: 'boolean',
    },
  },
  CRM_COMPETITOR: {
    slug: 'competitor', title: '竞争情报',
    identity: ['name'],
    states: { current: 'active', flow: ['active', 'deprecated'] },
    coreAttributes: {
      name: 'text', solution: 'text', price_quote: 'currency',
      strength: 'text', weakness: 'text', source: 'text',
    },
  },
  CRM_RESOURCE_CALENDAR: {
    slug: 'resource-calendar', title: '交付产能',
    identity: ['name'],
    states: { current: 'draft', flow: ['draft', 'active', 'expired'] },
    coreAttributes: {
      name: 'text', resource_type: 'select', capacity_day: 'number',
      booked_day: 'number', start: 'date', end: 'date',
    },
  },
```

- [ ] **Step 3: `validateCoreAttributesSchema()` 冒烟**（确保 19 类型集不被破坏）

Run: `node -e "import('./src/particles/particleModel.js').then(m=>console.log('OK', m.validateCoreAttributesSchema()))"`
Expected: `OK true`

- [ ] **Step 4: 可选同步** 若 `src/page/schema.js` 有 `PARTICLE_TYPES_ENUM` 且被元模型/#19 消费，则同步加入 4 新 key（不影响读通道，P0 不阻塞；验证项）。

## Task 1: 门户总览 businessDataCenter

**Files:** Create `src/portal/businessDataCenter.js`、`src/web/business-data.html`

- [ ] **Step 1: `businessDataCenter.js`**（同构 `configCenter.js`）

```js
// src/portal/businessDataCenter.js — 业务主数据门户总览（纯函数，浏览器+vitest 共用）
export const BUSINESS_DATA_ITEMS = [
  { id: 1, name: '产品目录', group: '主数据', page: '/product-catalog.html', endpoint: '/api/particles?type=CRM_PRODUCT', note: '名称/单位/品类/目录价/状态，软停用' },
  { id: 2, name: '基础价格表', group: '主数据', page: '/price-list.html', endpoint: '/api/particles?type=CRM_PRICE_LIST', note: '多套定价/有效期/权限/变更日志' },
  { id: 3, name: '报价商务规则包', group: '主数据', page: '/offer-policy.html', endpoint: '/api/particles?type=CRM_OFFER_POLICY', note: '成本结构/三档价/折扣对等/毛利红线' },
  { id: 4, name: '字典值域', group: '主数据', page: '/dict-entries.html', endpoint: '/api/particles?type=CRM_DICT_ENTRY', note: '行业/规模/区域/付款方式等值域' },
  { id: 5, name: '回款政策', group: '主数据', page: '/payment-policy.html', endpoint: '/api/particles?type=CRM_OFFER_POLICY&subtype=payment', note: '账期/催收分级/预付比例' },
];
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function cardHtml(it) {
  return `<article class="cfg-card" data-id="${it.id}">
    <div class="cfg-head"><h4>${esc(it.name)}</h4></div>
    <p class="cfg-sum">${esc(it.note || '')}</p>
    <div class="cfg-act"><a class="btn" href="${esc(it.page)}">打开</a></div>
  </article>`;
}
export function renderBusinessDataCenter(items = BUSINESS_DATA_ITEMS) {
  const groups = {};
  for (const it of items) (groups[it.group] ||= []).push(it);
  const sections = Object.entries(groups).map(([g, list]) =>
    `<section class="cfg-group" data-group="${esc(g)}"><h3>${esc(g)} <span class="cnt">${list.length}</span></h3>
    <div class="cfg-grid">${list.map(cardHtml).join('')}</div></section>`).join('');
  return `<div class="config-center" id="businessDataCenter">📚 基础数据 · 共 <b>${items.length}</b> 面${sections}</div>`;
}
```

- [ ] **Step 2: `business-data.html`**（同构 `config.html`，链 tokens.css+common.css+page.css，import `layout.js` + `businessDataCenter.js`）

```html
<!DOCTYPE html><html lang="zh-Cn"><head><meta charset="utf-8"><title>基础数据门户</title>
<link rel="stylesheet" href="/portal/tokens.css"><link rel="stylesheet" href="/portal/common.css"><link rel="stylesheet" href="/portal/page.css">
<style>body{font-family:var(--font);margin:0;background:var(--bg);color:var(--ink);padding:20px 24px}
.cfg-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}
.cfg-card{border:1px solid var(--line);border-radius:var(--radius-lg);padding:12px 14px;background:var(--panel)}
.cfg-act .btn{font-size:12px;padding:3px 10px;border-radius:6px;border:1px solid var(--ac);background:var(--ac);color:#fff;text-decoration:none}</style>
</head><body>
<h2>📚 基础数据门户</h2><p class="sub">业务主数据维护（与配置中心边界分离）· 写经决策第0闸 · 禁删=软停用</p>
<div id="app">加载中…</div>
<script type="module">import '/web/layout.js';import { renderBusinessDataCenter } from '/portal/businessDataCenter.js';
document.getElementById('app').innerHTML = renderBusinessDataCenter();</script>
</body></html>
```

## Task 2: 产品目录维护面（P0-A）

**Files:** Create `src/portal/productCatalogRender.js`、`src/web/product-catalog.html`

- [ ] **Step 1: Render 子模块**

```js
// src/portal/productCatalogRender.js — 零服务端 import
export const PRODUCT_FIELDS = ['name', 'unit', 'category', 'list_price', 'status'];
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
export function validateProductPatch(p={}){
  const keys=Object.keys(p||{});const unknown=keys.filter(k=>!PRODUCT_FIELDS.includes(k));
  if(unknown.length)return{ok:false,errors:[`不可编辑字段: ${unknown.join(', ')}`]};
  if(!keys.length)return{ok:false,errors:['无有效字段']};
  const n={},e=[];
  if('name'in p){if(typeof p.name!=='string'||!p.name.trim()||p.name.length>128)e.push('name 须为 1–128 字');else n.name=p.name.trim();}
  if('unit'in p)n.unit=String(p.unit??'');
  if('category'in p)n.category=String(p.category??'');
  if('list_price'in p){const v=Number(p.list_price);if(isNaN(v)||v<0)e.push('list_price 须≥0');else n.list_price=v;}
  if('status'in p)n.status=String(p.status??'on_sale');
  return{ok:e.length===0,errors:e,normalized:n};
}
export function renderProductList(items=[]){
  if(!items.length)return'<div class="empty">暂无产品（新建第一条）</div>';
  const rows=items.map(it=>`<tr><td>${esc(it.payload?.name||'')}</td><td>${esc(it.payload?.category||'')}</td><td>${esc(it.payload?.list_price??'')}</td><td>${esc(it.payload?.status||'')}</td><td><button class="btn" data-stop="${esc(it.id)}">停用</button></td></tr>`).join('');
  return`<table class="bd-tbl"><thead><tr><th>名称</th><th>品类</th><th>目录价</th><th>状态</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table>`;
}
export function renderProductForm(){
  return`<form id="pf"><label>名称</label><input name="name" required maxlength="128"/>
  <label>单位</label><input name="unit"/><label>品类</label><input name="category"/>
  <label>目录价</label><input name="list_price" type="number" min="0" step="0.01"/>
  <label>状态</label><select name="status"><option value="on_sale">on_sale</option><option value="discontinued">discontinued</option></select>
  <button class="btn" type="submit">新建</button></form>`;
}
```

- [ ] **Step 2: `product-catalog.html`**（拉取→列表+表单→POST→15s 刷新；链 layout.js+page.css；停用走 PATCH）

```html
<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>产品目录</title>
<link rel="stylesheet" href="/portal/tokens.css"><link rel="stylesheet" href="/portal/common.css"><link rel="stylesheet" href="/portal/page.css">
<style>body{font-family:var(--font);margin:0;background:var(--bg);color:var(--ink);padding:20px 24px}
.bd-tbl{width:100%;border-collapse:collapse}.bd-tbl th,.bd-tbl td{border:1px solid var(--line);padding:6px 8px;font-size:13px}
.btn{padding:4px 12px;border:1px solid var(--ac);background:var(--ac);color:#fff;border-radius:6px;cursor:pointer}</style></head>
<body><h2>📦 产品目录</h2><p class="sub">写经决策第0闸 · 禁删=软停用</p>
<div id="list">加载中…</div><hr/><h3>新建</h3><div id="form"></div>
<script type="module">import '/web/layout.js';import { renderProductList, renderProductForm, validateProductPatch } from '/portal/productCatalogRender.js';
const TOKEN=localStorage.getItem('crm_token');if(!TOKEN)location.href='/home.html';
const listEl=document.getElementById('list'),formEl=document.getElementById('form');
async function load(){const r=await fetch('/api/particles?type=CRM_PRODUCT',{headers:{Authorization:`Bearer ${TOKEN}`}});const j=await r.json();listEl.innerHTML=renderProductList(j.items||[]);bindStop();}
function bindStop(){listEl.querySelectorAll('[data-stop]').forEach(b=>b.onclick=async()=>{const r=await fetch('/api/particles/'+b.dataset.stop,{method:'PATCH',headers:{Authorization:`Bearer ${TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify({state:'discontinued'})});alert(r.ok?'已停用':'失败');load();});}
formEl.innerHTML=renderProductForm();
formEl.querySelector('#pf').onsubmit=async(e)=>{e.preventDefault();const fd=new FormData(e.target);const v=validateProductPatch(Object.fromEntries(fd));if(!v.ok){alert(v.errors.join('; '));return;}const r=await fetch('/api/particles',{method:'POST',headers:{Authorization:`Bearer ${TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify({type:'CRM_PRODUCT',payload:v.normalized})});const j=await r.json();alert(r.ok?`已创建（决策 ${String(j.decision||'').slice(0,8)}…）`:('失败：'+(j.error||r.status)));load();};
load();setInterval(()=>{if(TOKEN)load();},15000);</script></body></html>
```

## Task 3: 基础价格表维护面（P0-A）

**Files:** Create `src/portal/priceListRender.js`、`src/web/price-list.html`

- [ ] **Step 1: Render 子模块**（同构 Task 2；`PRICE_LIST_FIELDS=['name','valid_from','valid_to','permission','products','change_log']`；列表列=名称/有效期/权限/状态；表单含 valid_from/valid_to date + permission select + products（逗号分隔多值，存 text））

- [ ] **Step 2: `price-list.html`**（同构 Task 2，`type=CRM_PRICE_LIST`，停用 `state:'expired'`）

> 注：`CRM_PRICE_LIST` 模型已完整（`particleModel.js:51-59`），本 Task 仅补 UI 维护面。

## Task 4: 报价商务规则包维护面（P0-B）

**Files:** Create `src/portal/offerPolicyRender.js`、`src/web/offer-policy.html`

- [ ] **Step 1: Render 子模块**（`OFFER_POLICY_FIELDS=['name','subtype','cost_structure','price_bands','discount_conditions','margin_redline','tier_discount','change_billing','valid_from','valid_to']`；`cost_structure`/`price_bands` 为嵌套 JSON 文本域（textarea），提交时 `JSON.parse` 校验；`margin_redline` 为 currency）

- [ ] **Step 2: `offer-policy.html`**（同构；`type=CRM_OFFER_POLICY`，停用 `state:'expired'`；报价毛利透视消费见 Task 9）

## Task 5: 字典值域维护面（P0-B）

**Files:** Create `src/portal/dictEntriesRender.js`、`src/web/dict-entries.html`

- [ ] **Step 1: Render 子模块**（`DICT_FIELDS=['dict_key','dict_value','sort_order','active']`；`dict_key` 为 select，选项=行业/规模/区域/对接人级别/决策力/付款方式；列表列=键/值/排序/启用；`active` 复选框）

- [ ] **Step 2: `dict-entries.html`**（同构；`type=CRM_DICT_ENTRY`，停用 `state:'deprecated'`；活跃项驱动 meta-attr select 下拉，P0 先独立维护，联动为 P0-B 增强）

## Task 6: 回款政策维护面（P0-B）

**Files:** Create `src/portal/paymentPolicyRender.js`、`src/web/payment-policy.html`

- [ ] **Step 1: Render 子模块**（复用 `CRM_OFFER_POLICY` 粒子，`subtype='payment'`；`PAYMENT_FIELDS=['name','subtype','payment_term','collection_tier','prepay_ratio','valid_from','valid_to']`；`payment_term` 账期天数 number、`collection_tier` select（沟通/施压/法务）、`prepay_ratio` percent）

- [ ] **Step 2: `payment-policy.html`**（同构；POST `type=CRM_OFFER_POLICY` + `payload.subtype='payment'`；列表/`GET` 时客户端按 `subtype==='payment'` 过滤；停用 `state:'expired'`）

## Task 7: routes.js 路由挂载 + 停用端点

**Files:** Modify `src/http/routes.js`

- [ ] **Step 1: 在 `pool-config` 静态段（`:1648`）后追加 6 页 + 6 Render 静态段**

```js
  // 业务主数据门户（P0，2026-08-28 实施计划）— 5 维护面 + 门户总览
  const BD = [['business-data','businessDataCenter'],['product-catalog','productCatalogRender'],['price-list','priceListRender'],['offer-policy','offerPolicyRender'],['dict-entries','dictEntriesRender'],['payment-policy','paymentPolicyRender']];
  for (const [pg, mod] of BD) {
    app.get(`/${pg}.html`, (req, res) => res.sendFile(fileURLToPath(new URL(`../web/${pg}.html`, import.meta.url))));
    app.get(`/portal/${mod}.js`, (req, res) => res.sendFile(fileURLToPath(new URL(`../portal/${mod}.js`, import.meta.url)), { headers: { 'Content-Type': 'text/javascript' } }));
  }
```

- [ ] **Step 2: 核实并补 `PATCH /api/particles/:id` 停用端点**（scope.js:56 已列 `data-particle-update`；若 routes 缺则补：复用 `actionExecutor.dispatch('data-particle-update', { id, state }, ctx)`，非 DEAL 走 bootstrap+recordDecisionEvent 同 `:218-224` 范式）

- [ ] **Step 3: 语法冒烟** `node -e "import('./src/http/routes.js').then(()=>{}).catch(e=>console.log(e.message))"` 或 `routes OK`（仅校验加载不崩）

## Task 8: 导航入口（layoutMenu.js）

**Files:** Modify `src/portal/layoutMenu.js`

- [ ] **Step 1: FULL_MENU 加「📚 基础数据」组**（全员可见，读为主；写权限由 auth 控制，P1 再按 RBAC 收紧）

```js
export const FULL_MENU = [
  { group: '销售', label: '线索·商机', href: '/pipeline.html' },
  { group: '销售', label: '客户360', href: '/account-360.html' },
  { group: '协同', label: '我的待办', href: '/my-todo.html' },
  { group: '洞察', label: '报告', href: '/sales-decision-monitor' },
  { group: '基础数据', label: '📚 基础数据门户', href: '/business-data.html' },
  { group: '基础数据', label: '产品目录', href: '/product-catalog.html' },
  { group: '基础数据', label: '基础价格表', href: '/price-list.html' },
  { group: '基础数据', label: '报价商务规则包', href: '/offer-policy.html' },
  { group: '基础数据', label: '字典值域', href: '/dict-entries.html' },
  { group: '基础数据', label: '回款政策', href: '/payment-policy.html' },
];
```

> menuFor(role) 当前逻辑 `[...FULL_MENU, ...sys]` 无需改（基础数据入 FULL_MENU 即全员可见）。

## Task 9: 测试（TDD）

**Files:** Create `test/web/businessDataCenter.test.js`、`test/web/offerPolicyConsume.test.js`

- [ ] **Step 1: `businessDataCenter.test.js`**（门户渲染 + 粒子注册断言，类比 `configCenter.test.js`）

```js
import { test, expect } from 'vitest';
import { BUSINESS_DATA_ITEMS, renderBusinessDataCenter } from '../../src/portal/businessDataCenter.js';
import { PARTICLE_TYPES, ATTRIBUTE_TYPE_SET } from '../../src/particles/particleModel.js';
test('门户 5 面齐全', () => { expect(BUSINESS_DATA_ITEMS).toHaveLength(5); });
test('渲染含 5 卡片', () => { expect(renderBusinessDataCenter()).toContain('cfg-card'); });
test('4 新粒子已注册', () => {
  for (const t of ['CRM_OFFER_POLICY','CRM_DICT_ENTRY','CRM_COMPETITOR','CRM_RESOURCE_CALENDAR']) expect(PARTICLE_TYPES[t]).toBeDefined();
});
test('新粒子属性类型 ∈ 19 集', () => {
  for (const t of ['CRM_OFFER_POLICY','CRM_DICT_ENTRY','CRM_COMPETITOR','CRM_RESOURCE_CALENDAR'])
    for (const ty of Object.values(PARTICLE_TYPES[t].coreAttributes||{})) expect(ATTRIBUTE_TYPE_SET.has(ty)).toBe(true);
});
```

- [ ] **Step 2: `offerPolicyConsume.test.js`**（消费链：报价缺价→OFFER_POLICY 取价带毛利透视；QUOTE_PRICING 评估取 price_bands；dict 下拉联动——对齐设计 §4，RED→GREEN）

- [ ] **Step 3: 运行 `node node_modules/vitest/vitest.mjs run test/web/businessDataCenter.test.js test/web/offerPolicyConsume.test.js`**（禁 npx）

## Task 10: 全量回归 + 冒烟 + 工作日志

- [ ] **Step 1: `test/web` 全量回归**（预期全绿，计数在现有基线 + 本计划新增）
- [ ] **Step 2: 路由加载冒烟 `routes OK`**
- [ ] **Step 3: curl 冒烟**（全 200 + GET 有数据）
```bash
for p in business-data product-catalog price-list offer-policy dict-entries payment-policy; do curl -s -o /dev/null -w "%{http_code} /$p.html\n" http://localhost:3000/$p.html; done
curl -s "http://localhost:3000/api/particles?type=CRM_OFFER_POLICY" | head -c 200
```
- [ ] **Step 4: 工作日志追加 `.workbuddy/memory/2026-08-28.md`**（P0 五面落地证据 + commit 哈希）

## §3 验收口径

- `test/web/businessDataCenter.test.js` + `offerPolicyConsume.test.js` 全绿；`test/web` 全量无回退。
- 6 个页面（business-data + 5 面）curl 全 **200**；`GET /api/particles?type=CRM_OFFER_POLICY` 有数据（seed 或手动建）。
- 前台导航出现「📚 基础数据」组（门户 + 5 面入口），点击可进、可新建、可停用（无物理删除）。
- 新建主数据写落 `config_change` 决策审计链（非 DEAL 降级先例，不卡 403）。
- 4 新粒子注册通过 `validateCoreAttributesSchema()`；19 类型集不被破坏。
- 每页 `import` 均指向 Render 子模块（浏览器 ESM 可加载，无 express 崩溃）。

## §4 已知限制 / 边界

- **权限细分（RBAC）** 按 admin/商务/销售管理可写、销售只读——P1 增强；P0 写权限=`auth`（登录即可），菜单全员可见。不影响 P0 验证，但上线前须收紧（设计 §3.3）。
- **字典联动** DICT_ENTRY 活跃项驱动 meta-attr select 下拉——P0-B 先独立维护，联动消费为 P0-B 增强（设计 §4 第 4 行）。
- **合同模板/品类/产品品类**（P2）不在本计划（用户明确暂缓）。
- **OFFER_POLICY 嵌套 JSON**（`cost_structure`/`price_bands`）用 textarea + `JSON.parse` 校验，UI 暂不提供结构化编辑器（P0 固定形状，不规则扩展留 meta-attr）。
- **PATCH 停用端点** 若 routes 已存在则复用，缺失则按 Task 7 Step 2 补（不新增独立删除端点）。
