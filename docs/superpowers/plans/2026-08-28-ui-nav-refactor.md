# UI 统一 + 导航收敛 + 编码规范 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 src/web 全部 38 个页面收敛到统一深色壳（顶栏 + 左侧 6 项导航 + 头像用户菜单，RBAC 过滤），消除风格不统一 / 菜单混乱 / 无法新增三类系统级债务（诊断报告 P1–P6），并补齐缺失的 TDD 测试与真实业务写通道。

**Architecture:** 基建层（tokens.css / common.css / api.js / layout.js / layoutMenu.js）已落地并挂载；本计划在其上做三件事：① 为已落地的基建补纯函数单测与资源守卫测试；② 用统一 Recipe 把剩余 28 页从「旧 nav.js 顶条 / 手写侧栏 / 无导航」迁到 layout.js 壳，并修 `/web/nav.js` 错误路径（404）；③ 落地 P4 真实新增写通道（`POST /api/particles` 经决策第0闸 + `crm-deal-create` Action）+ 系统页 RBAC 路由守卫（403）。逐页改造是机械 Recipe 应用，故先定义 Recipe 一次，再按批枚举页面。

**Tech Stack:** 原生 ESM（浏览器 `<script type="module">`）+ Express 静态挂载 + vitest（纯函数单测，无 jsdom 依赖）+ Postgres 写通道经 actionExecutor 第0闸。

---

## §0 现状盘点（对齐已做，严禁返工）

经代码级探查，截至 2026-08-28 09:17：

| 资产 | 状态 | 证据 |
|---|---|---|
| `src/web/tokens.css` | ✅ 已存在，与设计 §2.1 完全一致 | `--ac:#6366f1` 等 12 Token |
| `src/web/common.css` | ✅ 已存在，含 layout 壳全部类 | `.app-shell/.topbar/.sidebar/.nav-item/.avatar/.btn/.card/.table/.tabs/.toast` 等 |
| `src/web/api.js` | ✅ 已存在 | `api/get/post/put` 封装 |
| `src/web/layout.js` | ✅ 已存在 | `injectLayout/navHtml/userMenuHtml`，依赖 `../portal/layoutMenu.js` |
| `src/portal/layoutMenu.js` | ✅ 已存在 | `FULL_MENU`(6) + `ADMIN_MENU`(2) + `menuFor(role)` RBAC 过滤 |
| `routes.js` 静态挂载 | ✅ 已挂载 | `:1271 /portal/nav.js`、`:1280 /portal/layout.js`、`:1282 /portal/layoutMenu.js` |
| `particleRepo.js` 六段白名单 | ✅ 已落地（P3 部分修） | `DEAL_STAGES` + `normalizeStage` 写前拦截 `leads` 脏值 |
| RBAC 路由守卫 | ⚠️ 仅注释（`:71`） | 需确认/实现 403 拦截 |
| 单测 | ❌ 缺失 | layout/menuFor/common.css 零测试 |

**页面改造进度（Grep `import` 实测）：**
- 已切 `layout.js`（10 页）：index / pipeline / account-360 / deal-detail / quotation-detail / contract-detail / order-detail / payment-detail / invoice-detail（注：invoice-detail 在 layout 匹配集；合计 9 业务页 + index）
- 仍用旧 `nav.js`（12 页）：agent-dashboard / agent-workbench / approval-flow / decision-graph / kanban / meta-attr-drawer / particle-detail / rbac / sales-decision-monitor / todo / workbench
- 用**错误路径** `/web/nav.js`（404，6 页）：memory / llm / ontology / pool-config / seven-dim / users
- 无统一导航（需补）：config / agents / home / page-market / portal-stage3-mockup / alert-rules / mcp-identities / business-tier / decision-scenarios / agent-config

**结论：** 批1 基建已存在，本计划从「收口测试 + 路径纠错 + 守卫」开始，续做批2–批5。

---

## §1 统一改造 Recipe（所有页面适用，定义一次）

### Recipe A — `<head>` 引入（替换原 `<style>` 块顶部/或追加 link）

每个页面 `<head>` 内、`<title>` 之后插入（若已有 tokens/common 两 link 则跳过；detail 类 5 页原 0 CSS，直接加）：

```html
<link rel="stylesheet" href="/portal/tokens.css">
<link rel="stylesheet" href="/portal/common.css">
```

> 不删除页面私有 `<style>`（页面特有组件样式保留），但删除与 common.css 重复的 `.btn/.card/.table/.panel/.form` 等通用类定义（避免覆盖）。

### Recipe B — 导航壳注入（替换原 `nav.js` / 手写侧栏）

删除原 `import '/portal/nav.js'`、`import '/web/nav.js'` 或手写 `<aside class="side">` 侧栏；在 body 首行 `<script type="module">` 内最前加：

```html
<script type="module">
  import { injectLayout } from '/portal/layout.js';
  injectLayout();
  // …页面原有逻辑（fetch 等）放在此处
</script>
```

> `injectLayout()` 会把原 `document.body` 全部子节点迁移进壳的 `#pageHost`（`.content` 区）。故页面 body 应是「裸内容」（容器 div + 脚本），不要保留手写顶/侧栏，否则会双重导航。

### Recipe C — 数据读取接 `api.js`（替换裸 fetch + 手写 authH）

页面脚本内统一用 `import { api, get, post, put } from '/portal/api.js';` 取代 `const token=localStorage.getItem('crm_token'); const authH={Authorization:...}` + `fetch(path,{headers:authH})`。例：

```js
import { get, post, put } from '/portal/api.js';
const board = await get('/api/business/board');   // 自动带 token、401 跳登录、非 2xx 抛错
```

> 旧 `if(!token) location.href='/home.html'` 硬跳转**删除**（layout.js 已柔和处理身份；诊断报告 P3 根因之一）。

### Recipe D — 错误提示用 toast（替换裸 alert）

```js
function toast(msg, err=false){ const t=document.createElement('div'); t.className='toast'+(err?' err':''); t.textContent=msg; document.body.appendChild(t); setTimeout(()=>t.remove(),3000); }
```

---

## 批0：基建收口 + 测试 + 路径纠错 + RBAC 守卫（对齐已做，零页面改动）

### Task 1: 写 layout / menuFor 纯函数单测（TDD RED→GREEN）

- Create: `test/web/layout.test.js`
- [ ] Step 1: 写失败测试
```js
import { test, expect } from 'vitest';
import { navHtml, userMenuHtml } from '../../src/web/layout.js';
import { menuFor, FULL_MENU, ADMIN_MENU } from '../../src/portal/layoutMenu.js';

test('menuFor 全员=6 项且无系统分组', () => {
  const m = menuFor('sales');
  expect(m).toHaveLength(6);
  expect(m.every(x => x.group && x.label && x.href)).toBe(true);
  expect(m.some(x => x.group === '系统')).toBe(false);
});
test('menuFor admin=8 项含系统分组', () => {
  const m = menuFor('admin');
  expect(m).toHaveLength(8);
  expect(m.some(x => x.group === '系统' && x.label === '配置中心')).toBe(true);
  expect(m.some(x => x.label === '智能体中心')).toBe(true);
});
test('navHtml 非 admin 不含系统分组', () => {
  const h = navHtml('sales');
  expect(h).not.toContain('配置中心');
  expect(h).toContain('线索·商机');
  expect(h).toContain('nav-item');
});
test('navHtml admin 含配置中心/智能体中心', () => {
  const h = navHtml('admin');
  expect(h).toContain('配置中心');
  expect(h).toContain('智能体中心');
});
test('userMenuHtml 全员含我的审批/任务/工作台/退出，无系统项', () => {
  const h = userMenuHtml('sales');
  expect(h).toContain('我的审批'); expect(h).toContain('我的任务');
  expect(h).toContain('工作台'); expect(h).toContain('退出登录');
  expect(h).not.toContain('配置中心');
});
test('userMenuHtml admin 含系统项', () => {
  const h = userMenuHtml('admin');
  expect(h).toContain('配置中心'); expect(h).toContain('智能体中心');
});
```
- [ ] Step 2: 运行确认失败 `node node_modules/vitest/vitest.mjs run test/web/layout.test.js`（期望 FAIL：文件不存在）
- [ ] Step 3: 实现已在位（`layout.js`/`layoutMenu.js` 已存在）→ 直接跑 GREEN
- [ ] Step 4: 运行 `node node_modules/vitest/vitest.mjs run test/web/layout.test.js` 期望 PASS（6/6）

### Task 2: 写 shell 资源守卫测试（CSS/挂载存在）

- Create: `test/web/shellAssets.test.js`
- [ ] Step 1: 写测试
```js
import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../src/web/', import.meta.url));
test('tokens.css 定义主色 --ac:#6366f1', () => {
  const css = readFileSync(root + 'tokens.css', 'utf8');
  expect(css).toContain('--ac:#6366f1');
  expect(css).toContain('--bg:#0f172a');
});
test('common.css 定义布局壳与组件类', () => {
  const css = readFileSync(root + 'common.css', 'utf8');
  for (const c of ['.app-shell','.topbar','.sidebar','.nav-item','.avatar','.user-menu-item','.btn','.card','.table','.tabs','.toast','.empty','.error']) {
    expect(css, `缺失类 ${c}`).toContain(c);
  }
});
```
- [ ] Step 2–4: 运行 `node node_modules/vitest/vitest.mjs run test/web/shellAssets.test.js` 期望 2/2 PASS

### Task 3: 修 6 个配置子页错误路径 `/web/nav.js` → `/portal/layout.js`

- Modify: `src/web/{memory,llm,ontology,pool-config,seven-dim,users}.html`
- [ ] Step 1: 对每个文件，将 `import '/web/nav.js';` 替换为 Recipe B（删旧 import，body 首 script 加 `import { injectLayout } from '/portal/layout.js'; injectLayout();`），并补 Recipe A 的两条 link（若 head 无）。
- [ ] Step 2: 运行冒烟（起服务后）逐个 `curl -sI /memory.html` 等返回 200，且页内不再含 `/web/nav.js`（grep 校验）。
- [ ] Step 3: 静态校验 `for f in memory llm ontology pool-config seven-dim users; do grep -q "/web/nav.js" src/web/$f.html && echo "FAIL $f"; done` 期望无输出。

### Task 4: RBAC 路由守卫实现（系统页 403，非 admin 跳回）

- Modify: `src/http/routes.js`（在 `:71` 注释处落地中间件）
- [ ] Step 1: 写失败测试 `test/http/rbacGuard.test.js`
```js
import { test, expect } from 'vitest';
import { createApp } from '../../src/http/server.js'; // 现有测试桩
// 系统页（配置中心 /config、智能体中心 /agent-workbench.html）直访（无 admin token）→ 403
test('非 admin 直访 /config → 403', async () => {
  const app = createApp();
  const r = await app.request('/config');   // 按项目 request 桩；无 token
  expect(r.status).toBe(403);
});
test('admin token 直访 /config → 200', async () => {
  const app = createApp({ role: 'admin' });
  const r = await app.request('/config', { headers: { Authorization: 'Bearer admin' } });
  expect(r.status).toBe(200);
});
```
- [ ] Step 2: routes.js 实现：对系统页路由（/config、/config.html、/agent-workbench.html、/agent-dashboard.html、/agents、/agents.html）加 `requireAdmin` 中间件——解析 `Authorization` → `GET /api/auth/me` 取 role，非 admin → `res.status(403).json({error:'需要管理员权限'})`；无 token 同 403。
- [ ] Step 3: 运行 `node node_modules/vitest/vitest.mjs run test/http/rbacGuard.test.js` 期望 PASS
- [ ] Step 4: 回归 `node node_modules/vitest/vitest.mjs run test/web` 零回归

### Task 5: 批0 提交（沙箱无凭证，用户本地执行）

```bash
git add test/web/layout.test.js test/web/shellAssets.test.js test/http/rbacGuard.test.js \
  src/web/memory.html src/web/llm.html src/web/ontology.html src/web/pool-config.html \
  src/web/seven-dim.html src/web/users.html src/http/routes.js
git commit -m "refactor(web): 批0 基建收口 — layout/menuFor/common.css 单测 + 6配置页路径纠错(/web→/portal) + 系统页RBAC守卫403"
```
> ⚠️ 勿 `git add -A`：工作区还有业务闭环/可读配置页/阶段3 未提交改动，按文件精确 add。

---

## 批1：业务页收尾（pipeline / account-360 / 5 详情页 适配 + 接 api.js）

> index.html 已完整改造（layout + tokens + common + copilot），仅核对；其余 9 页已 import layout.js 但部分仍用裸 fetch / 手写 authH / 旧跳转，需应用 Recipe C/D 清理。

### Task 6: pipeline.html 应用 Recipe B/C/D（删手写侧栏 + 接 api + 去硬跳转）

- Modify: `src/web/pipeline.html`
- [ ] Step 1: 删除原手写 `<aside class="side">`（若有）与 `import '/portal/nav.js'`；body 首 script 加 `import { injectLayout } from '/portal/layout.js'; injectLayout();`
- [ ] Step 2: 替换裸 fetch/手写 `authH` 为 `import { get } from '/portal/api.js'`，调用 `get('/api/business/board')` 等；删除 `if(!token) location.href='/home.html'`。
- [ ] Step 3: 错误提示改 `toast()`（Recipe D）。
- [ ] Step 4: 运行 `node node_modules/vitest/vitest.mjs run test/web/browserLoadable.test.js` 确认无浏览器禁止 import；起服务 `/pipeline.html` 返回 200 且含 `app-shell`。

### Task 7: account-360.html 应用 Recipe C/D

- Modify: `src/web/account-360.html`（已 import layout.js，但脚本用裸 fetch）
- [ ] Step 1–3: 同 Task 6 的 Recipe C/D 步骤（接 api.js、去硬跳转、toast）。
- [ ] Step 4: 冒烟 `/account-360.html` 200 且数据正常加载。

### Task 8: 5 个交易详情页（deal/quotation/contract/order/payment-detail）应用 Recipe C/D

- Modify: `src/web/{deal,quotation,contract,order,payment}-detail.html`
- [ ] 逐页 Step 1–3 同 Recipe C/D；deal/quotation 原 `if(!id){...return;}` 早退保留但改走 `toast` + `get`。
- [ ] Step 4: 运行 `node node_modules/vitest/vitest.mjs run test/http/deal-detail.test.js test/http/quotation-detail.test.js test/http/contract-detail.test.js test/http/order-detail.test.js test/http/payment-detail.test.js` 全绿。

### Task 9: 批1 提交

```bash
git add src/web/pipeline.html src/web/account-360.html src/web/deal-detail.html \
  src/web/quotation-detail.html src/web/contract-detail.html src/web/order-detail.html \
  src/web/payment-detail.html
git commit -m "refactor(web): 批1 业务页收尾 — pipeline/account-360/5详情页 接 api.js + 去硬跳转 + toast（统一壳）"
```

---

## 批2：协作页（workbench / todo / kanban 切 layout）

### Task 10: 三页应用 Recipe B/C/D

- Modify: `src/web/{workbench,todo,kanban}.html`（现 import `/portal/nav.js`）
- [ ] 逐页：删 `import '/portal/nav.js'` → 加 `injectLayout()`（Recipe B）；接 api.js（Recipe C）；去硬跳转；toast（Recipe D）。
- [ ] todo.html 原用非 module `<script src>`（诊断 P2）→ 改为 `<script type="module">` 并 import layout/api。
- [ ] 运行 `node node_modules/vitest/vitest.mjs run test/web` + 冒烟 `/workbench.html /todo.html /kanban.html` 200 且含 `app-shell`。

### Task 11: 批2 提交

```bash
git add src/web/workbench.html src/web/todo.html src/web/kanban.html
git commit -m "refactor(web): 批2 协作页 — workbench/todo/kanban 切统一壳(layout)+接api"
```

---

## 批3：决策页（decision-graph / decision-scenarios / sales-decision-monitor 切 layout + 配置中心 3 组 Tabs 确认）

### Task 12: 三页应用 Recipe B/C/D

- Modify: `src/web/{decision-graph,decision-scenarios,sales-decision-monitor}.html`
- [ ] 逐页切 layout（删 nav.js）；接 api；去硬跳转；toast。
- [ ] decision-graph 原「审计详情」JSON dump 已修（诊断报告后），保持中文可读视图。

### Task 13: config.html 3 组 Tabs 承载校验

- Modify/Verify: `src/web/config.html`（设计 §1.4：系统设置/业务规则/集成与资产 3 组，承载 9 子页）
- [ ] Step 1: 确认 config.html 注入 3 组次级 Tabs 且每组含对应页链接（users/rbac/business-tier/approval-flow/alert-rules/mcp-identities/decision-scenarios/page-market/particle-detail）。
- [ ] Step 2: 若缺，补 Tabs 渲染（复用 configCenter.js `CONFIG_ITEMS` 的 `group` 字段分组）。
- [ ] Step 3: 冒烟 `/config` 200 且 3 组 Tab 可见。

### Task 14: 批3 提交

```bash
git add src/web/decision-graph.html src/web/decision-scenarios.html src/web/sales-decision-monitor.html src/web/config.html
git commit -m "refactor(web): 批3 决策页切壳 + 配置中心3组Tabs承载校验"
```

---

## 批4：智能体 + 管理页（agent-workbench / agents / agent-dashboard + 配置子页群）

### Task 15: 智能体三视图切 layout

- Modify: `src/web/{agent-workbench,agents,agent-dashboard}.html`
- [ ] 逐页切 layout（删 nav.js）；接 api；去硬跳转；toast。agents.html 原无导航 → 加壳后可见。

### Task 16: 配置子页群切 layout（错误路径页已在批0修，此处补剩余）

- Modify: `src/web/{alert-rules,mcp-identities,business-tier,decision-scenarios,rbac,page-market,particle-detail,meta-attr-drawer,agent-config,memory,llm,ontology,pool-config,seven-dim,users,home,portal-stage3-mockup}.html`
- [ ] 应用 Recipe B/C/D；`home.html`（登录落地）若无需壳则保留 `location.href='/home.html'` 跳转逻辑但加 layout 壳用于展示；`portal-stage3-mockup` 归档原型，仅加壳不深改。
- [ ] `particle-detail.html` / `meta-attr-drawer.html` 双导航（诊断 P2）→ 删手写侧栏，仅 layout。

### Task 17: 批4 提交

```bash
git add src/web/agent-workbench.html src/web/agents.html src/web/agent-dashboard.html \
  src/web/alert-rules.html src/web/mcp-identities.html src/web/business-tier.html \
  src/web/decision-scenarios.html src/web/rbac.html src/web/page-market.html \
  src/web/particle-detail.html src/web/meta-attr-drawer.html src/web/agent-config.html \
  src/web/home.html src/web/portal-stage3-mockup.html
git commit -m "refactor(web): 批4 智能体三视图 + 配置子页群 切统一壳(layout)+接api+路径统一"
```

---

## 批5：P4 真实新增写通道（终结空壳新增）

### Task 18: 新增 `crm-deal-create` Action（经决策第0闸）

- Modify: `src/action/seed-actions.js`（参考现有 advance/pick 结构）
- [ ] Step 1: 写失败测试 `test/action/crm-deal-create.test.js`
```js
import { test, expect } from 'vitest';
import { getAction } from '../../src/action/registry.js';
test('crm-deal-create 已注册且 autoDecision', () => {
  const a = getAction('crm-deal-create');
  expect(a).toBeTruthy();
  expect(a.kind).toBe('write');
  expect(a.autoDecision).toBe(true);  // 自主引擎 mint decision，走第0闸
});
```
- [ ] Step 2: 实现（在 seed-actions.js 注册）：
```js
registerAction({
  name: 'crm-deal-create', kind: 'write', autoDecision: true,
  params: ['name', 'account_id', 'owner'],
  async run(params, ctx) {
    const { createParticle } = await import('../particles/particleRepo.js');
    const stage = params.stage && ['lead','opportunity','quoted','contracted','ordered','paid'].includes(params.stage) ? params.stage : 'lead';
    return createParticle('CRM_DEAL', {
      name: params.name, account_id: params.account_id, owner: params.owner || ctx.actor,
      stage, decision_id: ctx.decision_id || null,
    }, { tenantId: 'system' });
  },
});
```
- [ ] Step 3: 运行测试 PASS；同步把 `crm-deal-create` 加入 `whitelist.js` 写白名单（若白名单需枚举）。

### Task 19: 新增 `POST /api/particles` 端点（经 executor 第0闸）

- Modify: `src/http/routes.js`
- [ ] Step 1: 写失败测试 `test/http/createParticle.test.js`
```js
import { test, expect } from 'vitest';
import { createApp } from '../../src/http/server.js';
test('POST /api/particles 创建商机经第0闸', async () => {
  const app = createApp();
  const r = await app.request('/api/particles', { method:'POST',
    headers:{ 'Content-Type':'application/json' },
    body: JSON.stringify({ type:'CRM_DEAL', payload:{ name:'测试新增商机', account_id:'acc-1', owner:'sales' } }) });
  expect(r.status).toBe(200);
  const j = await r.json();
  expect(j.ok || j.id || j.particle).toBeTruthy();
});
test('POST /api/particles 缺 name → 400', async () => {
  const app = createApp();
  const r = await app.request('/api/particles', { method:'POST',
    headers:{ 'Content-Type':'application/json' },
    body: JSON.stringify({ type:'CRM_DEAL', payload:{ account_id:'acc-1' } }) });
  expect(r.status).toBe(400);
});
```
- [ ] Step 2: routes.js 实现：`app.post('/api/particles', async (req,res)=>{ const {type,payload}=req.body; if(!type||!payload?.name) return res.status(400).json({error:'type 与 payload.name 必填'}); const { actionExecutor } = await import('../action/executor.js'); const out = await actionExecutor.dispatch('crm-deal-create', { ...payload, decision_id: req.body.decision_id }, { actor:'system' }); if(!out.ok) return res.status(422).json({error:out.error}); res.json({ ok:true, particle:out }); })`（crm-deal-create autoDecision 自动 mint decision → 第0闸满足）。
- [ ] Step 3: 运行测试 PASS；回归 `node node_modules/vitest/vitest.mjs run test/` 无回归（注意 DB 集成测试需 PG 起）。

### Task 20: pipeline.html 加「＋新建商机」按钮（真实写通道前端）

- Modify: `src/web/pipeline.html`
- [ ] Step 1: 在 pipeline 容器加按钮 `<button class="btn primary" id="newDeal">＋ 新建商机</button>` + 简易表单（name/account_id）。
- [ ] Step 2: JS：`document.getElementById('newDeal').onclick=async()=>{ const name=prompt('商机名称'); if(!name) return; const r=await post('/api/particles',{type:'CRM_DEAL',payload:{name,owner:'sales'}}); if(r.ok) toast('已创建，15s 内出现在列表'); else toast(r.error||'创建失败',true); }`。
- [ ] Step 3: 冒烟（PG 起）：浏览器新增 → 列表 15s 内出现（对齐验收口径「新增后 15s 内出现」）。

### Task 21: 批5 提交

```bash
git add src/action/seed-actions.js src/action/whitelist.js src/http/routes.js \
  src/web/pipeline.html test/action/crm-deal-create.test.js test/http/createParticle.test.js
git commit -m "feat(web): 批5 P4 真实新增写通道 — POST /api/particles 经第0闸 + crm-deal-create Action + 新建商机按钮"
```

---

## 收尾回归

### Task 22: 全量回归 + 菜单可达性遍历

- [ ] Step 1: `node node_modules/vitest/vitest.mjs run test/web` 期望 ≥ 基线（原 201 + 新增 layout/shellAssets/rbacGuard ≈ 205+）全绿。
- [ ] Step 2: `node node_modules/vitest/vitest.mjs run test/` 全量（PG 起 5433）核对无代码回归（环境性 DB 失败除外）。
- [ ] Step 3: 起服务遍历 38 页：`for p in $(ls src/web/*.html); do code=$(curl -s -o /dev/null -w "%{http_code}" /${p##*/}); echo $p $code; done` 全 200；随机抽 5 页确认含 `app-shell` 且无 `/web/nav.js`、无 `location.href='/home.html'` 硬跳转（除 home.html 自身）。
- [ ] Step 4: 落 `docs/2026-08-28-frontend-coding-standards.md`（设计 §3 编码规范成文，供后续页面遵循）。

### Task 23: 收尾提交（规范文档）

```bash
git add docs/2026-08-28-frontend-coding-standards.md
git commit -m "docs: 前端编码规范成文（数据读取/api.js + 按钮/字段/错误处理/RBAC 守卫）"
```

---

## Self-Review（规划自检）

**1. 规格覆盖（对照设计文档 §1–§5）：**
- §1 导航 6 项 + 顶栏 ⌘K + 头像菜单 + RBAC → 批0（layoutMenu/menuFor 测试）+ 批0 Task4（守卫）+ 批1–4（逐页切壳）覆盖 ✅
- §2 视觉 tokens/common/layout/api → 已存在，批0 Task2 补守卫测试 ✅
- §3 编码规范（api.js / 按钮 / 字段 / 真实写通道 / 错误 / RBAC）→ 批1–4 Recipe C/D + 批5 写通道 + Task23 成文 ✅
- §4 5 批 → 批0–批5（批0 为基建收口，对齐实际已做）✅
- §5 验收（可发现性 / RBAC / 一致性 / 收敛 / 可新增 / 规范）→ 收尾 Task22 遍历 + 批5 新增按钮 ✅

**2. 占位符扫描：** 无 TBD/TODO；每 Task 含可执行代码或精确 Recipe 引用（Recipe 为完整代码，页面 Task 引用之，非占位）。

**3. 类型/签名一致性：** `injectLayout/navHtml/userMenuHtml/menuFor` 与 `layout.js`/`layoutMenu.js` 实际导出一致；`api.get/post/put` 与 `api.js` 一致；`actionExecutor.dispatch(name,params,ctx)` 与 `executor.js` 一致；`createParticle(type,payload,{tenantId})` 与 `particleRepo.js` 一致。✅

**4. 已知缺口/风险：**
- 项目无登录流程（localStorage 恒空），RBAC 守卫为「软」拦截（无 token→403 跳首页），与设计意图一致；不影响页面渲染。
- 批1–4 逐页改造为机械 Recipe，需执行 agent 严格按 Recipe B/C/D 操作，避免漏删旧 nav.js 引用（grep `/web/nav.js` + `/portal/nav.js` 双校验）。
- detail 类 5 页原 0 CSS，接 layout 壳后 style 由 common.css 提供，页面内 `<style>` 仅留业务特有类。
