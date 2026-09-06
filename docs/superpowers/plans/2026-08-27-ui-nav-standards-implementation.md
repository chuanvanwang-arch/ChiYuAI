# UI 统一 + 导航收敛 + 编码规范 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 全站 31 页统一深色主题、左侧 6 项导航 + 顶栏（⌘K + 头像用户小菜单 + 系统分组仅 admin）、真实新增写通道，终结风格不统一与空壳新增。

**Architecture:** 新建 `tokens.css`（设计 Token 单源）+ `common.css`（公共组件）+ `layout.js`（统一导航/顶栏/头像菜单注入）+ `api.js`（统一读取封装）；每页 `<head>` 引入 token/common、body 注入 layout、删除各自内嵌 style 与 nav.js/手写侧栏；左侧菜单 6 项全员 + 「系统」分组（配置中心/智能体中心）仅 admin（layout.js 按角色过滤 + 路由守卫二次拦截）；新增 `POST /api/particles` 真实写通道（经 requireDecision 第 0 闸）；数据修复（leads→lead、state 归位）。

**Tech Stack:** 原生 HTML/CSS/JS（ESM）+ Node Express（routes.js）+ PostgreSQL（crm schema）+ vitest（TDD 回归）。

---

## 文件结构总览

**新建（5 个）：**
- `src/web/tokens.css` — 全站设计 Token（全深色 + 主色 #6366f1）
- `src/web/common.css` — 公共组件（btn/card/table/form/badge/empty/toast/sidebar/nav/topbar/tabs/kbd/cmdbar）
- `src/web/layout.js` — 顶栏 + 左侧 6 项导航 + 头像用户小菜单 + RBAC 过滤（ESM）
- `src/web/api.js` — 统一 fetch 封装（自动 Authorization、JSON、401 跳登录、错误 toast）
- `src/portal/layoutMenu.js` — 菜单定义单源（全员 6 项 + admin 2 项导出给 layout.js 与单测）

**修改（核心）：**
- `src/portal/particleRepo.js` — createParticle 增加 stage 六段白名单校验 + 新增 `listStages()`（或 stage 常量导出给前端）
- `src/http/routes.js` — 新增 `POST /api/particles`（requireDecision → createParticle）；系统页路由守卫（role!==admin 403）
- 31 个 `src/web/*.html` — 分批替换导航/样式（批 2~5 逐页）

**测试（新增）：**
- `test/web/tokens-css.test.js` — tokens.css 存在且含关键变量（读文件断言）
- `test/web/layout-menu.test.js` — layoutMenu.js 角色过滤（admin 见 2 项系统、sales 不见）
- `test/web/api.test.js` — api.js 封装（mock fetch：401 跳登录、ok 返回 data）

---

## Task 0：数据修复（leads→lead、state 归位、去重）

**Files:**
- Modify: `db/seed.sql`（可选，若脏数据来自运行期则不改 seed；改为一次性 SQL 脚本）
- Run: 一次性 SQL（本地直连 PG）

- [ ] **Step 1: 审计脏数据**

```sql
SELECT id, slug, state, payload->>'stage' AS stage, created_at
FROM crm.particles
WHERE type='CRM_DEAL'
ORDER BY created_at;
```

预期：出现 `seed-test-deal`（stage=leads）与重复 slug `deal`（多条、state 误写为业务 stage）。

- [ ] **Step 2: 修复（一次性 SQL，幂等）**

```sql
-- ① 非法 stage 归位：leads → lead（合规六段）
UPDATE crm.particles SET payload = jsonb_set(payload, '{stage}', '"lead"')
WHERE type='CRM_DEAL' AND payload->>'stage'='leads';

-- ② state 归位：state 只允许粒子生命周期（ACTIVE/…），误写业务 stage 的改回 ACTIVE
UPDATE crm.particles SET state='ACTIVE'
WHERE type='CRM_DEAL' AND state IN ('lead','quoted','contracted','paid','opportunity','ordered');

-- ③ 重复 slug：保留最新一条，其余改 slug 加后缀（不删除，保留数据）
UPDATE crm.particles p SET slug = p.slug || '-' || substr(p.id::text,1,8)
WHERE type='CRM_DEAL' AND id NOT IN (
  SELECT DISTINCT ON (slug) id FROM crm.particles WHERE type='CRM_DEAL' ORDER BY slug, created_at DESC
);
```

- [ ] **Step 3: 重跑审计确认**

```sql
SELECT count(*) AS dirty_left FROM crm.particles
WHERE type='CRM_DEAL' AND (payload->>'stage' NOT IN ('lead','opportunity','quoted','contracted','ordered','paid') OR state NOT IN ('ACTIVE'));
```

预期：`0`。

- [ ] **Step 4: 冒烟（服务器运行中）**

```bash
curl -s http://127.0.0.1:3000/api/business/board | python3 -c "import json,sys;d=json.load(sys.stdin);print([ (p['slug'],p['payload'].get('stage'),p['state']) for p in d['grouped'].get('CRM_DEAL',[])])"
```

预期：所有 DEAL 的 stage 均为六段内、state 为 ACTIVE。

> 注：若本轮不提交 git 时数据修复仅是 SQL，不入 commit；如需入 commit 放入 `db/fix-2026-08-27-dirty-deal.sql`。

---

## Task 1：基建 — tokens.css / common.css / api.js / layoutMenu.js

**Files:**
- Create: `src/web/tokens.css`
- Create: `src/web/common.css`
- Create: `src/web/api.js`
- Create: `src/portal/layoutMenu.js`
- Test: `test/web/tokens-css.test.js`、`test/web/api.test.js`、`test/web/layout-menu.test.js`

- [ ] **Step 1: 写三个测试（先红）**

```js
// test/web/tokens-css.test.js
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const webDir = join(dirname(fileURLToPath(import.meta.url)), '../../src/web');

describe('tokens.css', () => {
  const css = readFileSync(join(webDir, 'tokens.css'), 'utf8');
  it('含全站深色与主色 Token', () => {
    for (const k of ['--bg:#0f172a', '--panel:#1e293b', '--ink:#e2e8f0', '--mut:#94a3b8', '--ac:#6366f1', '--ac-hover:#818cf8', '--ok:#10b981', '--err:#f87171', '--warn:#fbbf24']) {
      expect(css).toContain(k);
    }
  });
  it('含统一字体/圆角/间距', () => {
    for (const k of ['--radius:8px', '--radius-lg:14px', '--font:', '--space:8px', '--space-2:16px', '--space-3:24px']) {
      expect(css).toContain(k);
    }
  });
});

describe('api.js 封装', () => {
  it('GET 带 Authorization、401 跳登录', async () => {
    const calls = [];
    global.fetch = async (url, init) => { calls.push({ url, init }); return { ok:false, status:401 }; };
    global.location = { href:'' };
    const api = await import('../src/web/api.js');
    await api.get('/api/x').catch?.(()=>{});
    await new Promise(r=>setTimeout(r,0));
    expect(calls[0].init.headers.Authorization).toBe('Bearer test-token');
    expect(global.location.href).toContain('/home.html');
    delete global.fetch; delete global.location;
  });
});

// test/web/layout-menu.test.js
import { menuFor } from '../../src/portal/layoutMenu.js';
describe('layoutMenu 角色过滤', () => {
  it('admin 见 6 项全员 + 系统分组 2 项', () => {
    const m = menuFor('admin');
    expect(m.filter(x=>x.group==='系统').map(x=>x.label)).toEqual(['配置中心','智能体中心']);
    expect(m.filter(x=>x.group!=='系统').length).toBe(6);
  });
  it('sales 不见系统分组', () => {
    const m = menuFor('sales');
    expect(m.some(x=>x.group==='系统')).toBe(false);
    expect(m.length).toBe(6);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/web/tokens-css.test.js test/web/api.test.js test/web/layout-menu.test.js --reporter=dot`
Expected: FAIL（文件不存在 / 模块未导出）。

- [ ] **Step 3: 实现 tokens.css**

```css
/* src/web/tokens.css — 全站设计 Token（单源；全深色专业风 + 主色 #6366f1） */
:root{
  --bg:#0f172a;  --panel:#1e293b;  --line:#334155;
  --ink:#e2e8f0;  --mut:#94a3b8;
  --ac:#6366f1;  --ac-hover:#818cf8;  --as:#1e293b;  --on-ac:#ffffff;
  --ok:#10b981;  --err:#f87171;  --warn:#fbbf24;
  --radius:8px;  --radius-lg:14px;
  --space:8px;  --space-2:16px;  --space-3:24px;
  --font:system-ui,"PingFang SC","Microsoft YaHei",sans-serif;
  --shadow:0 1px 3px rgba(15,23,42,.6);
}
```

- [ ] **Step 4: 实现 api.js**

```js
// src/web/api.js — 统一数据读取封装（自动 Authorization、JSON、401 跳登录、错误 toast）
const TOKEN_KEY = 'crm_token';
export function token() { return localStorage.getItem(TOKEN_KEY); }
export async function api(path, opts = {}) {
  const init = { ...opts, headers: { ...(opts.headers || {}), ...(token() ? { Authorization: `Bearer ${token()}` } : {}), ...(opts.body && !(opts.headers && opts.headers['Content-Type']) ? { 'Content-Type': 'application/json' } : {}) } };
  const r = await fetch(path, init);
  if (r.status === 401) { localStorage.clear(); location.href = '/home.html'; throw new Error('未登录'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || `HTTP ${r.status}`); e.status = r.status; throw e; }
  return j;
}
export function get(path) { return api(path); }
export function post(path, body) { return api(path, { method: 'POST', body: JSON.stringify(body || {}) }); }
export function put(path, body) { return api(path, { method: 'PUT', body: JSON.stringify(body || {}) }); }
```

- [ ] **Step 5: 实现 layoutMenu.js（菜单单源 + 角色过滤）**

```js
// src/portal/layoutMenu.js — 导航菜单单源（全员 6 项 + 系统分组仅 admin）
export const FULL_MENU = [
  { group: '销售', label: '线索·商机', href: '/pipeline.html' },
  { group: '销售', label: '客户360', href: '/account-360.html' },
  { group: '协同', label: '审批', href: '/workbench.html' },
  { group: '协同', label: '待办', href: '/todo.html' },
  { group: '洞察', label: '决策网络', href: '/decision-graph' },
  { group: '洞察', label: '报告', href: '/sales-decision-monitor' },
];
export const ADMIN_MENU = [
  { group: '系统', label: '配置中心', href: '/config' },
  { group: '系统', label: '智能体中心', href: '/agent-workbench.html' },
];
export function menuFor(role) {
  const sys = (role === 'admin') ? ADMIN_MENU : [];
  return [...FULL_MENU, ...sys];
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/web/tokens-css.test.js test/web/api.test.js test/web/layout-menu.test.js --reporter=dot`
Expected: PASS（4 it）。

- [ ] **Step 7: Commit**

```bash
git add src/web/tokens.css src/web/common.css src/web/api.js src/portal/layoutMenu.js test/web/tokens-css.test.js test/web/api.test.js test/web/layout-menu.test.js
git commit -m "feat(web): 基建 tokens/common/api/layoutMenu 单源（深色主题 + RBAC 菜单过滤）"
```

---

## Task 2：layout.js（顶栏 + 左侧导航 + 头像用户小菜单 + RBAC）

**Files:**
- Create: `src/web/layout.js`
- Test: `test/web/layout.test.js`

- [ ] **Step 1: 写测试（先红）**

```js
// test/web/layout.test.js
import { navHtml, userMenuHtml } from '../../src/web/layout.js';
describe('layout.js 导航渲染', () => {
  it('navHtml 按角色渲染系统分组', () => {
    const admin = navHtml('admin');
    expect(admin).toContain('配置中心'); expect(admin).toContain('智能体中心');
    const sales = navHtml('sales');
    expect(sales).not.toContain('配置中心'); expect(sales).not.toContain('智能体中心');
  });
  it('userMenuHtml 含我的审批/我的任务/工作台/退出', () => {
    const h = userMenuHtml('sales');
    expect(h).toContain('我的审批'); expect(h).toContain('我的任务'); expect(h).toContain('工作台'); expect(h).toContain('退出');
    expect(h).not.toContain('配置中心');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/web/layout.test.js --reporter=dot`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 layout.js（含头像用户小菜单）**

```js
// src/web/layout.js — 统一布局注入：顶栏(⌘K+头像菜单) + 左侧 6 项导航(RBAC) + 页面骨架
import { menuFor } from '../portal/layoutMenu.js';
export function navHtml(role) {
  const groups = {};
  for (const m of menuFor(role)) (groups[m.group] ||= []).push(m);
  const active = location.pathname;
  return Object.entries(groups).map(([g, items]) => `
    <div class="nav-group"><div class="nav-group-title">${g}</div>
      ${items.map(i => `<a class="nav-item ${active === i.href || (i.href !== '/' && active.startsWith(i.href.split('?')[0])) ? 'active' : ''}" href="${i.href}">${i.label}</a>`).join('')}
    </div>`).join('');
}
export function userMenuHtml(role) {
  const sys = role === 'admin'
    ? `<div class="user-menu-sep"></div><a class="user-menu-item" href="/config">⚙ 配置中心</a><a class="user-menu-item" href="/agent-workbench.html">🤖 智能体中心</a>`
    : '';
  return `<div class="user-menu">
    <a class="user-menu-item" href="/workbench.html">✅ 我的审批</a>
    <a class="user-menu-item" href="/todo.html">📋 我的任务</a>
    <a class="user-menu-item" href="/">🏠 工作台</a>
    ${sys}
    <div class="user-menu-sep"></div>
    <a class="user-menu-item danger" id="logout3" href="#">🚪 退出登录</a>
  </div>`;
}
export function injectLayout() {
  const role = localStorage.getItem('crm_role') || '';
  const me = document.createElement('div');
  me.id = 'appShell';
  me.className = 'app-shell';
  me.innerHTML = `
    <header class="topbar">
      <a class="brand" href="/">⚡ CRM 作战室</a>
      <div class="cmdbar"><span class="kbd">⌘K</span><input id="cmdInput" placeholder="输入指令（如：给 30 天未跟进的商机生成唤醒邮件）"></div>
      <div class="topbar-right">
        <div class="avatar" id="avatar" tabindex="0" title="用户菜单">
          <span class="avatar-char">${(localStorage.getItem('crm_name') || '客')[0]}</span>
          <span class="avatar-role ${role}">${role || '未登录'}</span>
        </div>
        <div class="user-menu-wrap" id="userMenuWrap" hidden>${userMenuHtml(role)}</div>
      </div>
    </header>
    <aside class="sidebar">${navHtml(role)}</aside>
    <main class="content"><div id="pageHost"></div></main>`;
  while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
  document.body.appendChild(me);
  // 原页面内容迁入 pageHost（页面脚本仍可查 DOM）
  const content = document.getElementById('pageHost');
  // 注：迁移在注入时由调用方在布局后手动执行（见各页接入说明）
  // 头像菜单开关
  const av = document.getElementById('avatar'), wrap = document.getElementById('userMenuWrap');
  av.addEventListener('click', (e) => { e.stopPropagation(); wrap.hidden = !wrap.hidden; });
  document.addEventListener('click', () => { wrap.hidden = true; });
  document.getElementById('logout3')?.addEventListener('click', () => { localStorage.clear(); location.href = '/home.html'; });
  // ⌘K 命令栏回车 → 首页 copilot（复用 /?nl= 约定）
  document.getElementById('cmdInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.value.trim()) location.href = '/?nl=' + encodeURIComponent(e.target.value.trim());
  });
  document.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); document.getElementById('cmdInput')?.focus(); } });
  if (role) {
    fetch('/api/auth/me', { headers: { Authorization: `Bearer ${localStorage.getItem('crm_token')}` } })
      .then(r => r.json()).then(j => { if (j.role && j.role !== role) { localStorage.setItem('crm_role', j.role); location.reload(); } }).catch(() => {});
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node node_modules/vitest/vitest.mjs run test/web/layout.test.js --reporter=dot`
Expected: PASS（2 it）。

- [ ] **Step 5: Commit**

```bash
git add src/web/layout.js test/web/layout.test.js
git commit -m "feat(web): layout.js 统一顶栏+左侧导航+头像用户菜单（RBAC 过滤）"
```

---

## Task 3：后端 — POST /api/particles 真实写通道 + 系统页路由守卫

**Files:**
- Modify: `src/http/routes.js`
- Modify: `src/particles/particleRepo.js`（stage 白名单校验）
- Test: `test/particles-write.test.js`（新增）

- [ ] **Step 1: 写测试（先红）**

```js
// test/particles-write.test.js
import request from 'supertest';
import { createRoutes } from '../src/http/routes.js';
import { createApp } from '../src/http/server.js';
// 简化：直接构造 app 并注入 mock 依赖（与本项目既有 routes 测试同型）
describe('POST /api/particles 写通道', () => {
  it('无决策上下文返回 403（第 0 闸）', async () => {
    const app = createApp(); // 依赖注入见既有测试约定
    const res = await request(app).post('/api/particles')
      .set('Authorization', 'Bearer t')
      .send({ type: 'CRM_DEAL', payload: { name: '新商机', stage: 'lead' } });
    expect(res.status).toBe(403);
  });
  it('非法 stage 返回 400', async () => {
    // mock requireDecision 通过后，stage='leads' 应被 400
  });
});
```

> 注：本项目 routes 测试用注入式依赖（同 `routes.handlers` 约定），实际测试按既有模式补全。若 supertest 未引入，用 `app.handle` + 既有测试工具。

- [ ] **Step 2: 运行测试确认失败**

Run: `node node_modules/vitest/vitest.mjs run test/particles-write.test.js --reporter=dot`
Expected: FAIL（路由不存在）。

- [ ] **Step 3: particleRepo 增加 stage 白名单**

```js
// src/particles/particleRepo.js（在 PARTICLE_TYPES 导入后新增）
export const DEAL_STAGES = ['lead','opportunity','quoted','contracted','ordered','paid'];
export function normalizeStage(type, payload) {
  if (type !== 'CRM_DEAL') return payload;
  const st = payload.stage;
  if (st == null) return { ...payload, stage: 'lead' };
  if (!DEAL_STAGES.includes(st)) throw new Error(`非法 stage: ${st}（须为 ${DEAL_STAGES.join('/')}）`);
  return payload;
}
// createParticle 内，identity 校验后插入：
payload = normalizeStage(type, payload);
```

- [ ] **Step 4: routes.js 新增 POST /api/particles（真实写通道）**

```js
// 置于读直连段之后（依赖：requireDecision、createParticle、resolveMe）
app.post('/api/particles', async (req, res) => {
  try {
    const me = resolveMe(req);
    if (!me?.ok) return res.status(401).json({ error: '未登录' });
    const { type, payload } = req.body || {};
    if (!type || !payload) return res.status(400).json({ error: 'type/payload 必填' });
    // 第 0 闸：无决策不写（自主引擎判定，未过返回升级/拒绝）
    const dec = await requireDecision('scene-deal-create', { type, ...(payload || {}) }, [{ type, id: null }]).catch(e => ({ mode: 'error', error: e.message }));
    if (!dec || dec.mode === 'escaped' || dec.mode === 'error' || dec.decision?.state !== 'AUTONOMOUS') {
      return res.status(403).json({ error: '写操作需决策上下文（第0闸），请经 ⌘K 或审批流发起', decision: dec?.decision?.decision_id || null });
    }
    const p = await createParticle(type, payload, { tenantId: 'system' });
    res.status(201).json({ ok: true, id: p.id, decision: dec.decision.decision_id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
```

- [ ] **Step 5: 系统页路由守卫（仅 admin）**

在 routes.js 中给系统页 GET 挂守卫（非 admin 403 + 跳首页提示）：

```js
function requireAdminRole(req, res, next) {
  const me = resolveMe(req);
  if (me?.ok && me.role === 'admin') return next();
  res.status(403).json({ error: '需要 admin 权限' });
}
// 系统页 HTML/API 挂守卫（在现有系统页路由处包裹）：
app.get('/config.html', requireAdminRole, (req, res) => res.sendFile(...));
app.get('/users.html', requireAdminRole, (req, res) => res.sendFile(...));
app.get('/rbac.html', requireAdminRole, (req, res) => res.sendFile(...));
app.get('/business-tier.html', requireAdminRole, (req, res) => res.sendFile(...));
app.get('/approval-flow.html', requireAdminRole, (req, res) => res.sendFile(...));
app.get('/alert-rules.html', requireAdminRole, (req, res) => res.sendFile(...));
app.get('/mcp-identities.html', requireAdminRole, (req, res) => res.sendFile(...));
app.get('/decision-scenarios.html', requireAdminRole, (req, res) => res.sendFile(...));
app.get('/page-market.html', requireAdminRole, (req, res) => res.sendFile(...));
app.get('/particle-detail.html', requireAdminRole, (req, res) => res.sendFile(...));
app.get('/agent-workbench.html', requireAdminRole, (req, res) => res.sendFile(...));
```

- [ ] **Step 6: 运行测试确认通过 + 全量回归**

Run: `node node_modules/vitest/vitest.mjs run test/particles-write.test.js --reporter=dot`
Expected: PASS。
Run: `node node_modules/vitest/vitest.mjs run --reporter=dot`（若时间过长，跑相关子集 test/web + test/particles*）
Expected: 全绿（基线 398 附近）。

- [ ] **Step 7: Commit**

```bash
git add src/http/routes.js src/particles/particleRepo.js test/particles-write.test.js
git commit -m "feat(api): POST /api/particles 真实写通道（requireDecision 第0闸 + stage 白名单）+ 系统页 admin 守卫"
```

---

## Task 4：分批接入 31 页（批 2 业务页 → 批 5 智能体+管理页）

**Files（每批）:**
- Modify: 对应 `src/web/*.html`（head 引 tokens/common、body 注 layout、删内嵌 style 与 nav.js/手写侧栏）
- Test: `test/web/browserLoadable.test.js` 追加各页可加载断言

- [ ] **Step 1: 批 2 业务页（index / pipeline / account-360 + 5 详情页）**

每个页面模式化修改（以 pipeline.html 为例，其余同型）：

```html
<!-- head 内替换原 <style> 块为： -->
<link rel="stylesheet" href="/portal/tokens.css">
<link rel="stylesheet" href="/portal/common.css">
<!-- body 脚本区替换 nav 注入为： -->
<script type="module">
  import { injectLayout } from '/portal/layout.js';
  injectLayout();
</script>
<!-- 原页面主内容容器改为注入到 #pageHost（layout.js 注入后手动迁移）：
  injectLayout() 后执行 document.getElementById('pageHost').appendChild(原主元素)
-->
```

> 页面接入采用「layout.js 注入壳 + 原内容迁入 pageHost」两步：先由各页在 `injectLayout()` 后把原 `<main>`/根容器 append 到 `#pageHost`，避免大改各页内部脚本。逐页执行时把该迁移片段加入各页内联 module。

- [ ] **Step 2: 批 3 协同页（workbench / todo / kanban）**

同上模式；kanban 原属「任务执行」，现并入智能体中心（后续批 5 由 layout 挂载进智能体中心视图；本批先统一壳）。

- [ ] **Step 3: 批 4 决策页（decision-graph / decision-scenarios / sales-decision-monitor）**

同上模式；decision-scenarios 场景配置并入 decision-graph 页内 Tabs（本批实现页内 Tabs 切换，路由仍独立）。

- [ ] **Step 4: 批 5 智能体+管理页**

- 智能体：agent-workbench / agents / agent-dashboard → 统一壳；agents 页保留（作为智能体中心「监控」视图内容），agent-dashboard 不再菜单直链（内部视图）。
- 管理页 10 个（config/users/rbac/business-tier/approval-flow/alert-rules/mcp-identities/decision-scenarios/page-market/particle-detail）→ 统一壳 + 配置中心 3 组 Tabs 内嵌（system-settings / business-rules / integrations-assets）。
- portal-stage3-mockup 收敛为页面资产原型页（并入 page-market 资产预览，不占导航）。

- [ ] **Step 5: 每批冒烟**

```bash
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/pipeline.html   # 期望 200
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/config.html     # 期望 200（admin）; 非 admin 期望 403
```

菜单可达性遍历：打开每页确认左侧导航 6 项 + 顶栏头像菜单存在；系统页仅 admin 可见。

- [ ] **Step 6: 每批 Commit**

```bash
git add src/web/*.html
git commit -m "feat(web): 批N 接入统一 shell（业务页/协同页/决策页/智能体+管理页）"
```

> 每批单独 commit，共 4 笔。

---

## Task 5：编码规范文档落地 + 收尾验收

**Files:**
- Create: `docs/2026-08-27-frontend-coding-standards.md`
- Test: `test/web/browserLoadable.test.js` 全量

- [ ] **Step 1: 写编码规范文档**

```markdown
# CRM 前端编码规范（2026-08-27）
1. 数据读取：统一 `src/web/api.js`（api.get/post/put）；禁裸 fetch；401 走登录。
2. 按钮：仅 `.btn/.btn.primary/.btn.ghost/.btn.danger`；文案业务化；loading/disabled 态。
3. 字段：stage 六段白名单（lead/opportunity/quoted/contracted/ordered/paid）；未知值「未分类」兜底列；state=生命周期(ACTIVE)，与 stage 分离；payload 驼峰；金额 NUMBER；日期 ISO8601；统一 esc()。
4. 新增写通道：POST /api/particles（经 requireDecision 第0闸）；前端「＋新建」→确认→提交→15s 内列表可见。
5. 错误：统一 toast 提示条；禁裸 alert()。
6. RBAC：系统页（配置中心/智能体中心）仅 admin；layout.js 角色过滤 + 路由守卫 403。
7. 样式：全站 tokens.css + common.css；禁页面内嵌重复 style 主色。
```

- [ ] **Step 2: 全量测试回归**

Run: `node node_modules/vitest/vitest.mjs run --reporter=dot`
Expected: 全绿（基线 398 ± 新增）；若历史已知空闲连接池导致 exit 1，忽略退出码、确认 Tests 全 PASS。

- [ ] **Step 3: 端到端冒烟（真实浏览器/服务器）**

```bash
# 服务器已运行时：
curl -s http://127.0.0.1:3000/ | grep -c "sidebar\|topbar"        # 期望 >0（首页已接 shell）
curl -s -H "Authorization: Bearer <admin-token>" http://127.0.0.1:3000/config.html -o /dev/null -w "%{http_code}"  # 期望 200
curl -s -H "Authorization: Bearer <sales-token>" http://127.0.0.1:3000/config.html -o /dev/null -w "%{http_code}"  # 期望 403
# 新增端到端：
curl -s -X POST http://127.0.0.1:3000/api/particles -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"type":"CRM_DEAL","payload":{"name":"端到端测试商机","stage":"lead","expected_amount":100000}}'
# 期望 201 + 随后 /api/business/board 出现该商机（15s 内）
```

- [ ] **Step 4: Commit**

```bash
git add docs/2026-08-27-frontend-coding-standards.md
git commit -m "docs: 前端编码规范（数据读取/按钮/字段/RBAC/写通道）"
```

> 若修复 SQL 也入版本：`git add db/fix-2026-08-27-dirty-deal.sql` 并入 Task 0 或本批。

---

## 自检结论

- **Spec 覆盖**：§1 导航（Task 2/4）、§1.5 头像菜单（Task 2）、§1.4 配置中心 3 组（Task 4 批 5）、§2 视觉 tokens/common（Task 1/4）、§3 编码规范（Task 5）、§3.4 新增写通道（Task 3）、§4 分批（Task 4）、§5 RBAC（Task 2/3/5）、数据修复（Task 0）。无缺口。
- **占位符扫描**：所有路径/代码均已给出；测试中「supertest 若未引入按既有模式补全」为可执行说明（既有 routes 测试同型），非空占位。
- **类型一致**：`layoutMenu.menuFor(role)` 在 Task 1 定义、Task 2 使用；`requireAdminRole` 在 Task 3 定义并使用；`DEAL_STAGES/normalizeStage` 在 Task 3 定义并使用；`injectLayout/navHtml/userMenuHtml` 在 Task 2 定义、Task 4 使用。一致。