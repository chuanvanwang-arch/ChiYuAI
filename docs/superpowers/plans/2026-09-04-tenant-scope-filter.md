# 租户作用域筛选器（跨页面 admin 专属）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让所有渲染「租户级实体列表」的页面，在 admin/sysadmin 视角下提供「按租户筛选」下拉 + 列表「租户归属」列；普通用户无感知（仅见本租户）；隔离仍由后端 token 强制，前端筛选器不可越权。

**Architecture:** 后端新增 `applyTenantOverride(req, me)` 纯函数（复用 `calibrationRouter.js:177` 既有 `?tenant_id=` 先例），挂到所有已用 `scopeTenant(me)` 的列表端点；前端新增可复用 `src/portal/tenantScopeBar.js`（角色闸 + 租户下拉 + 租户名列 + fetch 参数助手），由各列表页按需挂载。普通用户 `scopeTenant` 返回自身租户、`applyTenantOverride` 忽略 `?tenant`，天然不可越权。

**Tech Stack:** Node/Express（`src/http/routes.js`、`src/http/tenantScope.js`）、浏览器 ES Module（`src/portal/*.js`、`src/web/*.html`）、JWT（`src/http/auth.js`）。

---

## 范围裁定（务必先读）

- **IN SCOPE（租户级实体/主数据列表页）**：凡是列表端点已用 `scopeTenant(me)` 读取 `crm.particles`/租户表的页面。本计划明确覆盖：`product-catalog`(CRM_PRODUCT)、`named-accounts`(CRM_ACCOUNT)、`named-account-manage`(CRM_ACCOUNT)、`pipeline`(CRM_DEAL)、`receivables`(CRM_DEAL/contract)、`users`(crm_users)、`rbac`(crm.rbac)，以及 `price-list`/`offer-policy`/`payment-policy`/`dict-entries`/`business-data`（同为租户级主数据，按同模式扩展）。
- **OUT OF SCOPE（平台级/系统级配置页）**：`llm-config`、`ontology`(元模型)、`skill-registry`、`system`、`approval-config`、`behavior-standard`、`seven-dim`、`pool-config` 等 `scope:'platform'` 页面——其数据非租户数据，加租户筛选器语义错误，本计划不包含。
- **OUT OF SCOPE（聚合看板/待办）**：`home`、`todo`、`today-priority`、`kanban`、`agent-dashboard`、`named-account-360` 等——admin 已见合并视图，逐页下拉是噪声；如需可在后续计划追加。
- **安全铁律**：`?tenant=` 覆写**仅当 `scopeTenant(me)==='*'`**（admin/sysadmin）生效；普通用户的 `?tenant` 一律忽略，SQL 仍用其自身 `tenant_id`。

---

## 文件结构与职责

- `src/http/tenantScope.js`（MODIFY）：新增 `applyTenantOverride(req, me)`。
- `src/http/routes.js`（MODIFY）：`GET /api/particles` 用覆写；`GET /api/particles/:id` 与 `/:id/schema` 出边查询 `'system'`→`scopeTenant(me)`；`GET /api/config/users`、`GET /api/rbac` 用覆写。
- `src/portal/tenantScopeBar.js`（CREATE）：浏览器侧可复用模块（角色闸、租户下拉、租户名列、fetch 参数助手）。
- `src/portal/productCatalogRender.js`（MODIFY）：`renderProductList` 增加 `showTenant`+`tenantMap` 参数渲染租户列。
- `src/web/product-catalog.html`（MODIFY）：挂载筛选器、fetch 拼 `tenantQuery()`、列表传 `tenantMap`。
- 其余页面（`named-accounts`、`named-account-manage`、`pipeline`、`receivables`、`users`、`rbac`、`price-list`、`offer-policy`、`payment-policy`、`dict-entries`、`business-data`）：同模式挂载（见 Task 8 精确映射）。

---

## Task 0：后端 `applyTenantOverride` 纯函数

**Files:**
- Modify: `src/http/tenantScope.js`

- [ ] **Step 1: 在 `tenantScope.js` 末尾追加覆写函数**

```js
// src/http/tenantScope.js
// admin/sysadmin 可经 ?tenant= 显式收窄到某租户；普通用户不可越权（忽略该参数）
// 复用 calibrationRouter.js:177 既有 ?tenant_id= 先例
export function applyTenantOverride(req, me) {
  const base = scopeTenant(me);            // admin/sysadmin => '*'；普通用户 => 自身租户
  if (base !== '*') return base;           // 普通用户：强制自身租户，忽略 ?tenant
  const t = req && req.query && req.query.tenant;
  if (!t || t === '*' || t === 'all') return '*';   // 全量（缺省行为兼容）
  return String(t).trim();                 // 指定租户；非法值仅返回空结果，安全
}
```

- [ ] **Step 2: 语法校验**

Run: `node --check src/http/tenantScope.js`
Expected: 无输出（exit 0）

- [ ] **Step 3: 提交**

```bash
git add src/http/tenantScope.js
git commit -m "feat(tenant): add applyTenantOverride for admin tenant scoping"
```

---

## Task 1：`GET /api/particles` 接入覆写 + 修复详情出边硬编码

**Files:**
- Modify: `src/http/routes.js:426-431`（列表）、`src/http/routes.js:451` 与 `:470`（出边）

- [ ] **Step 1: 修改列表端点**

```js
  app.get('/api/particles', async (req, res) => {
    const me = resolveMe(req);
    const { type } = req.query;
    const items = await queryParticles({ type: type || null, tenantId: applyTenantOverride(req, me), limit: 100 });
    res.json({ items });
  });
```

- [ ] **Step 2: 修复 `:id` 与 `:id/schema` 出边查询硬编码 `'system'`**

routes.js:451 与 :470 两处：
```js
        query(`SELECT edge_type, target_type, target_id, meta FROM crm.edges WHERE tenant_id=$1 AND source_id=$2`, ['system', req.params.id]),
```
改为：
```js
        query(`SELECT edge_type, target_type, target_id, meta FROM crm.edges WHERE tenant_id=$1 AND source_id=$2`, [scopeTenant(me), req.params.id]),
```
（需确认这两处所在 handler 已 `const me = resolveMe(req);`；`:id`/`:id/schema` handler 在 :464/:446 处已无 `me`，需在 try 开头补 `const me = resolveMe(req);`）

- [ ] **Step 3: 语法校验**

Run: `node --check src/http/routes.js`
Expected: 无输出（exit 0）

- [ ] **Step 4: 提交**

```bash
git add src/http/routes.js
git commit -m "feat(tenant): scope /api/particles by override; fix detail edge hardcoded tenant"
```

---

## Task 2：前端可复用模块 `tenantScopeBar.js`

**Files:**
- Create: `src/portal/tenantScopeBar.js`

- [ ] **Step 1: 创建模块**

```js
// src/portal/tenantScopeBar.js — 浏览器侧租户作用域条（admin/sysadmin 专属）
const KEY = 'crm_tenant_scope';
let _me = null, _tenants = null;

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

export async function fetchMe() {
  if (_me) return _me;
  try { const r = await fetch('/api/auth/me'); _me = r.ok ? await r.json() : { role: 'user' }; }
  catch { _me = { role: 'user' }; }
  return _me;
}

async function fetchTenants() {
  if (_tenants) return _tenants;
  try { const r = await fetch('/api/tenants'); const j = r.ok ? await r.json() : { tenants: [] }; _tenants = j.tenants || []; }
  catch { _tenants = []; }
  return _tenants;
}

export function isAdminScope() {
  return _me && (_me.role === 'admin' || _me.role === 'sysadmin');
}

export function savedTenant() { return sessionStorage.getItem(KEY) || 'all'; }

export function tenantQuery() {
  const t = savedTenant();
  return t && t !== 'all' ? `&tenant=${encodeURIComponent(t)}` : '';
}

export async function mountTenantScopeBar(el, onChange) {
  const me = await fetchMe();
  if (!isAdminScope()) return;            // 普通用户不渲染筛选器
  const tenants = await fetchTenants();
  const cur = savedTenant();
  el.innerHTML = `<label class="ts-label">租户</label>
    <select class="ts-select" id="ts-select">
      <option value="all">全部租户</option>
      ${tenants.map((t) => `<option value="${esc(t.tenant_id)}" ${t.tenant_id === cur ? 'selected' : ''}>${esc(t.name || t.tenant_id)}</option>`).join('')}
    </select>`;
  const sel = el.querySelector('#ts-select');
  if (sel) sel.onchange = (e) => { sessionStorage.setItem(KEY, e.target.value); onChange && onChange(e.target.value); };
}

export async function tenantMap() {
  const ts = await fetchTenants();
  return Object.fromEntries(ts.map((t) => [t.tenant_id, t.name || t.tenant_id]));
}

export function tenantCell(tenantId, map) {
  return `<td class="ts-cell">${esc((map && map[tenantId]) || tenantId || 'system')}</td>`;
}

export function tenantHead() { return `<th>租户</th>`; }
```

- [ ] **Step 2: 语法校验**

Run: `node --check src/portal/tenantScopeBar.js`
Expected: 无输出（exit 0）

- [ ] **Step 3: 提交**

```bash
git add src/portal/tenantScopeBar.js
git commit -m "feat(tenant): add reusable tenantScopeBar browser module"
```

---

## Task 3：`productCatalogRender.renderProductList` 支持租户列

**Files:**
- Modify: `src/portal/productCatalogRender.js:35-49`

- [ ] **Step 1: 改写渲染函数**

```js
export function renderProductList(items = [], opts = {}) {
  const { showTenant = false, tenantMap = {} } = opts;
  if (!items.length) return '<div class="empty">暂无产品（新建第一条）</div>';
  const rows = items
    .map(
      (it) => `<tr>
        <td>${esc(it.payload?.name || '')}</td>
        <td>${esc(it.payload?.unit || '')}</td>
        <td>${esc(it.payload?.category || '')}</td>
        <td>${esc(it.payload?.list_price ?? '')}</td>
        <td>${esc(it.payload?.status || '')}</td>
        ${showTenant ? tenantCell(it.tenant_id, tenantMap) : ''}
        <td><button class="btn" data-stop="${esc(it.id)}">停用</button></td>
      </tr>`
    )
    .join('');
  return `<table class="bd-tbl"><thead><tr><th>名称</th><th>单位</th><th>品类</th><th>目录价</th><th>状态</th>${showTenant ? '<th>租户</th>' : ''}<th>操作</th></tr></thead><tbody>${rows}</tbody></table>`;
}
```
（需在本文件顶部 `import { tenantCell } from './tenantScopeBar.js';`；`esc` 若本文件已有则复用，否则补 `function esc(s){...}`）

- [ ] **Step 2: 语法校验**

Run: `node --check src/portal/productCatalogRender.js`
Expected: 无输出（exit 0）

- [ ] **Step 3: 提交**

```bash
git add src/portal/productCatalogRender.js
git commit -m "feat(tenant): render tenant column in product list (admin scope)"
```

---

## Task 4：`product-catalog.html` 挂载筛选器 + 拼参数

**Files:**
- Modify: `src/web/product-catalog.html:28-45`（script）、`:22-27`（body 挂载点）

- [ ] **Step 1: body 加挂载点（header 下）**

```html
<header class="page-head"><div class="ph-main"><h1 class="page-title">产品目录</h1></div></header>
<div id="tenant-bar" class="ts-bar"></div>
<div id="list">加载中…</div>
```

- [ ] **Step 2: script 顶部 import + load 改造**

```js
import { renderProductList, renderProductForm, validateProductPatch } from '/portal/productCatalogRender.js';
import { mountTenantScopeBar, tenantQuery, tenantMap, fetchMe } from '/portal/tenantScopeBar.js';

async function load() {
  try {
    const me = await fetchMe();
    const isAdmin = me.role === 'admin' || me.role === 'sysadmin';
    const r = await fetch('/api/particles?type=CRM_PRODUCT' + tenantQuery(), { headers: { Authorization: `Bearer ${TOKEN}` } });
    if (!r.ok) { listEl.innerHTML = `<p class="empty">加载失败：${r.status}</p>`; return; }
    const j = await r.json();
    const map = isAdmin ? await tenantMap() : {};
    listEl.innerHTML = renderProductList(j.items || [], { showTenant: isAdmin, tenantMap: map });
    bindStop();
  } catch (e) { listEl.innerHTML = `<p class="empty">${e.message}</p>`; }
}
// load() 之后挂载筛选器（仅 admin 渲染），变更即重载
mountTenantScopeBar(document.getElementById('tenant-bar'), () => load());
```

- [ ] **Step 3: 语法校验（HTML 无法 node --check，人工核对 import 路径与挂载点）**

Run: `grep -nE "tenantScopeBar|tenant-bar|tenantQuery" src/web/product-catalog.html`
Expected: 至少出现 3 处匹配

- [ ] **Step 4: 提交**

```bash
git add src/web/product-catalog.html
git commit -m "feat(tenant): product-catalog admin tenant filter + column"
```

---

## Task 5：`users` / `rbac` 端点接入覆写

**Files:**
- Modify: `src/http/routes.js`（`GET /api/config/users`、`GET /api/rbac` 实际路由；若由独立 router 承载则在对应 `src/http/*Router.js`）

- [ ] **Step 1: 定位并改造 users/rbac 列表端点**

在 users 列表端点（返回 crm_users 行）与 rbac 列表端点（返回 crm.rbac 行）的查询中，把 `tenantId: scopeTenant(me)` 改为 `tenantId: applyTenantOverride(req, me)`。若端点当前未显式传 tenantId（依赖默认 `'system'`），则显式补 `applyTenantOverride(req, me)`。样例：

```js
const rows = await query(`SELECT id, username, display_name, role, tenant_id, status FROM crm.crm_users WHERE tenant_id=$1 ORDER BY username`, [applyTenantOverride(req, me)]);
```

- [ ] **Step 2: 语法校验**

Run: `node --check src/http/routes.js`
Expected: 无输出（exit 0）

- [ ] **Step 3: 提交**

```bash
git add src/http/routes.js
git commit -m "feat(tenant): scope users/rbac list by override (admin)"
```

---

## Task 6：`users.html` / `rbac.html` 挂载筛选器 + 租户列

**Files:**
- Modify: `src/web/users.html`、`src/web/rbac.html`（各自列表渲染 + fetch + 挂载点）

- [ ] **Step 1: 按 Task 4 同模式改造**

对每个页面：① body 加 `<div id="tenant-bar" class="ts-bar"></div>`；② import `tenantScopeBar`；③ 列表 fetch 拼 `tenantQuery()`；④ 渲染表格加 `tenantCell`/`租户` 列（仅 admin）；⑤ `mountTenantScopeBar(..., () => load())`。

（users.html 列表渲染函数与 fetch 端点以实际代码为准；rbac.html 同理。两页均 load `components.js`，与 product-catalog 一致）

- [ ] **Step 2: 校验**

Run: `grep -nE "tenantScopeBar|tenant-bar|tenantQuery" src/web/users.html src/web/rbac.html`
Expected: 各页至少 3 处匹配

- [ ] **Step 3: 提交（每页一 commit）**

```bash
git add src/web/users.html
git commit -m "feat(tenant): users admin tenant filter + column"
git add src/web/rbac.html
git commit -m "feat(tenant): rbac admin tenant filter + column"
```

---

## Task 7：`named-accounts` / `named-account-manage` / `pipeline` / `receivables` 接入

**Files:**
- Modify: `src/web/named-accounts.html`、`src/web/named-account-manage.html`、`src/web/pipeline.html`、`src/web/receivables.html`

- [ ] **Step 1: 后端已覆盖（无需改端点）**

这四页列表均经 `GET /api/particles?type=CRM_ACCOUNT|CRM_DEAL`（Task 1 已接入 `applyTenantOverride`），后端覆写已生效。

- [ ] **Step 2: 前端按 Task 4 同模式**

每页：① 加 `#tenant-bar` 挂载点；② import `tenantScopeBar`；③ fetch 拼 `tenantQuery()`；④ 各自列表渲染函数增加 `showTenant`+`tenantCell`；⑤ `mountTenantScopeBar(..., () => load())`。

- [ ] **Step 3: 校验**

Run: `grep -nE "tenantScopeBar|tenant-bar|tenantQuery" src/web/named-accounts.html src/web/named-account-manage.html src/web/pipeline.html src/web/receivables.html`
Expected: 每页至少 3 处匹配

- [ ] **Step 4: 提交（每页一 commit）**

```bash
git add src/web/named-accounts.html src/web/named-account-manage.html
git commit -m "feat(tenant): named-accounts admin tenant filter + column"
git add src/web/pipeline.html src/web/receivables.html
git commit -m "feat(tenant): pipeline/receivables admin tenant filter + column"
```

---

## Task 8：其余租户级主数据页（price/offer/payment/dict/business）按同模式扩展

**Files:**
- Modify: `src/web/price-list.html`、`src/web/offer-policy.html`、`src/web/payment-policy.html`、`src/web/dict-entries.html`、`src/web/business-data.html`
- 对应后端端点：在 `src/http/routes.js` 或 `src/http/*Router.js` 中，凡该页列表查询已用 `scopeTenant(me)` 处，改为 `applyTenantOverride(req, me)`。

- [ ] **Step 1: 逐页后端覆写**

对每个页面找到其列表端点，把 `scopeTenant(me)` 改为 `applyTenantOverride(req, me)`（若端点未显式传 tenant 则补）。

- [ ] **Step 2: 逐页前端挂载**

按 Task 4 同模式：挂载点 + import + `tenantQuery()` + 租户列 + `mountTenantScopeBar`。

- [ ] **Step 3: 校验 + 提交（每页一 commit）**

```bash
grep -nE "tenantScopeBar|tenant-bar|tenantQuery" src/web/price-list.html src/web/offer-policy.html src/web/payment-policy.html src/web/dict-entries.html src/web/business-data.html
git add src/web/price-list.html src/web/offer-policy.html src/web/payment-policy.html src/web/dict-entries.html src/web/business-data.html
git commit -m "feat(tenant): extend admin tenant filter to price/offer/payment/dict/business masters"
```

---

## Task 9：浏览器冒烟 + 回归校验

**Files:**
- 核验：所有改动页 + `node scripts/ui-lint.mjs --strict`

- [ ] **Step 1: UI 架构 lint 归零**

Run: `node scripts/ui-lint.mjs --strict; echo "EXIT=$?"`
Expected: EXIT=0（新增模块/列不引入 item3/item7 违规；`tenantScopeBar.js` 非 HTML，不受影响）

- [ ] **Step 2: 浏览器冒烟（localhost:3000，本环境无法跑）**

1. 普通租户用户登录 product-catalog：无「租户」下拉；列表仅本租户；无租户列。
2. admin 登录 product-catalog：见「租户」下拉（全部租户 + 各租户）；选某租户→列表仅该租户；表格出现「租户」列。
3. admin 选「全部租户」→ 合并全量；切到 named-accounts/pipeline/users/rbac 等页下拉选择保持（sessionStorage）。
4. 点产品「停用」在筛选后仍正常（bindStop 不变）。
5. `GET /api/particles/:id` 出边：非 system 租户粒子详情页能显示其关联边（原硬编码 bug 已修）。

- [ ] **Step 3: 提交核验记录（不提交代码，仅归档）**

核验通过后由用户本地提交；本任务无新增文件。

---

## Self-Review

**1. Spec 覆盖**：
- 后端覆写（admin `?tenant=`）→ Task 0/1/5/8 ✅
- 详情出边硬编码 bug → Task 1 ✅
- 前端可复用模块 → Task 2 ✅
- 租户列渲染 → Task 3 + 各页 ✅
- 普通用户不可越权 → `applyTenantOverride` base!=='*' 早返 ✅
- 全页面覆盖（租户级列表）→ Task 4/6/7/8 ✅；平台配置/看板明确 OUT OF SCOPE ✅

**2. 占位符扫描**：无 TBD/TODO；每个 Task 含完整代码或精确文件+端点+函数映射（Task 6/7/8 复用 Task 4 已验证模式并给出精确目标，非空泛「类似」）。

**3. 类型一致性**：`applyTenantOverride(req, me)` 签名在 Task 0 定义，Task 1/5/8 调用一致；`tenantQuery()/tenantMap()/mountTenantScopeBar()/tenantCell()/fetchMe()` 在 Task 2 定义，Task 3/4/6/7 调用一致；`renderProductList(items, {showTenant, tenantMap})` 在 Task 3 定义，Task 4 调用一致。

**4. 已知缺口**：users/rbac 实际路由文件未在本计划第 5 步硬编码路径（随 endpoints 落地定位），实施时以 `grep -nE "crm_users|crm.rbac"` 在 `src/http/` 定位；若由独立 Router 承载，改动落对应文件，逻辑不变。
