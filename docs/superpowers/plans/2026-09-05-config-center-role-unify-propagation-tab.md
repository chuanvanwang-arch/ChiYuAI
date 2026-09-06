# 配置中心：角色名统一 ten_admin + 「全局复用与经验蔓延」TAB 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ① 统一租户管理员角色名为 `ten_admin`（以真实落库 ROLE_TAGS 为准），修复 `config.html:63` 守卫 ALIAS 漏 `ten_admin` 的 bug，并从所有菜单/TAB 文案中移除角色名；② 配置中心新增第三一级 TAB「全局复用与经验蔓延」（仅 ADMIN 可见），深链新页 `propagation.html`，复用既有 4 个传播中枢 API（写已过决策第 0 闸，后端近零改动）。

**Architecture:** 纯前端/UI 层改动 + 注册表（CONFIG_ITEMS / LEVEL_GROUPS）扩展。后端 `src/http/propagationRoutes.js` 已提供 `GET /api/propagation/suggestions`、`POST /api/propagation/accept`、`POST /api/propagation/reject`、`POST /api/config/broadcast`（角色闸+决策第 0 闸已内建），本计划不改后端。

**Tech Stack:** 原生 ESM 渲染模块（PORTAL 目录纯函数，vitest 可测）+ 单文件 HTML 页面（/portal/api.js 自动 Bearer）+ vitest 3。

**铁律（每个 Task 都适用）：**
- 绝对禁 DELETE；所有写操作走既有后端 API（内含决策第 0 闸），前端不得绕过。
- 每 Task 一 commit，显式路径 add，禁 `git add -A`。
- TDD：先写失败测试 → 跑红 → 最小实现 → 跑绿 → commit。
- 提交前双检：`git log -1` + `git status --short`（防 unborn 分支/暂存卷入，见工作记忆铁律）。
- 测试运行命令统一用：`npx vitest run <file>`（在仓库根 `D:\system\CRM-ai-native` 执行）。

---

### Task 1: 角色名统一 ten_admin + 菜单去角色化

**Files:**
- Modify: `src/portal/configCenter.js:59-63`（LEVEL_GROUPS 标签去角色名）
- Modify: `src/web/config.html:44,62-63,93-97`（forbidden 文案、ALIAS 补 ten_admin、TAB 名去角色名）
- Test: `test/web/configCenter.test.js:11-22`（断言改标签 + 新增「不含角色名」断言）

- [ ] **Step 1: 改测试（先跑红）**

将 `test/web/configCenter.test.js` 中 `renderConfigCenter 按 §15.2 渲染两个一级分组` 测试改为：

```js
test('renderConfigCenter 按 §15.2 渲染两个一级分组（系统级/租户级），组内保留 G1–G4 子组', () => {
  const html = renderConfigCenter(CONFIG_ITEMS, {});
  // 两个一级分组（level）
  expect(html).toContain('data-level="system"');
  expect(html).toContain('data-level="tenant"');
  // 2026-09-05 用户决议：菜单/TAB 是导航不是权限声明，标签不含角色名
  expect(html).toContain('>系统级 <span');
  expect(html).toContain('>租户级 <span');
  // 角色名不得出现在渲染产物（权限归属由后端闸保证）
  expect(html).not.toContain('tan_admin');
  expect(html).not.toContain('ten_admin');
  // 组内 G1–G4 子组仍在（data-group 保留在子组 div 上）
  for (const g of ['平台与访问', '销售方法论与决策治理', '业务对象与流程建模', '智能体与运行']) {
    expect(html).toContain(`data-group="${g}"`);
  }
});
```

- [ ] **Step 2: 跑红**

Run: `npx vitest run test/web/configCenter.test.js`
Expected: FAIL（当前渲染含「系统级（仅 ADMIN）」等角色文案）

- [ ] **Step 3: 改 `src/portal/configCenter.js`**

将 §15.2 一级分组常量（59-63 行）改为：

```js
// §15.2 两个一级分组（roles 仅用于后端闸文档化，不渲染进 UI——菜单是导航不是权限声明，2026-09-05 用户决议）
// 角色名 canonical=ten_admin（对齐 userManagement.js ROLE_TAGS 真实落库）；rbac.js ALIAS 已归一 tan_admin/ten_admin/tenant-admin 变体
export const LEVEL_GROUPS = [
  { level: 'system', name: '系统级', roles: ['ADMIN'] },
  { level: 'tenant', name: '租户级', roles: ['ten_admin', 'sysadmin', 'ADMIN'] },
];
```

同时把第 4 行与第 59 行注释里的 `tan_admin` 字样改为 `ten_admin`（注释级修正，保持认知一致）。

- [ ] **Step 4: 改 `src/web/config.html`**

4a. 44 行 forbidden 文案去角色名：

```html
<div id="forbidden"><h3>需要管理权限</h3><p>请用管理员账号 <a href="/home.html">重新登录</a>。</p></div>
```

4b. 62-63 行守卫 ALIAS **补 ten_admin（修 bug：ten_admin 用户当前会被拦在门外）**：

```js
      // §15.1 守卫放宽：admin/sysadmin/ten_admin（含连字符/旧拼写变体）可入；其余拦截
      // canonical=ten_admin（userManagement ROLE_TAGS 落库名）；tan_admin 为历史拼写，rbac.js ALIAS 已归一
      const ALIAS = { admin: 'ADMIN', ADMIN: 'ADMIN', sysadmin: 'SYSADMIN', ten_admin: 'TAN_ADMIN', tan_admin: 'TAN_ADMIN', 'tan-admin': 'TAN_ADMIN', 'tenant-admin': 'TAN_ADMIN' };
```

4c. 93-97 行 LEVEL_TABS 标签去角色名：

```js
    // §15.2 两个一级分组：系统级仅 ADMIN 可见；ten_admin/sysadmin 仅见租户级（API 侧注册表闸同步兜底）
    // 标签不含角色名（2026-09-05 用户决议：菜单是导航不是权限声明）
    const LEVEL_TABS = [
      { level: 'system', name: '系统级', visible: me.level === 'ADMIN' },
      { level: 'tenant', name: '租户级', visible: true },
    ].filter((t) => t.visible);
```

- [ ] **Step 5: 跑绿**

Run: `npx vitest run test/web/configCenter.test.js test/http/configRouter.test.js`
Expected: PASS（configRouter 测试若断言了旧错误文案则同步修正断言后重跑）

- [ ] **Step 6: Commit**

```bash
git log -1 --oneline; git status --short
git add src/portal/configCenter.js src/web/config.html test/web/configCenter.test.js
git commit -m "fix(config-center): 统一角色名 ten_admin 并修复守卫 ALIAS 漏项，菜单/TAB 标签去角色化"
```

---

### Task 2: configCenter 注册 id42 + propagation 一级分组（渲染器）

**Files:**
- Modify: `src/portal/configCenter.js`（CONFIG_ITEMS 增 id42；LEVEL_GROUPS 增第三分组）
- Test: `test/web/configCenter.test.js`

- [ ] **Step 1: 写失败测试**

在 `test/web/configCenter.test.js` 新增：

```js
test('CONFIG_ITEMS 含 31 项：id42 全局复用与经验蔓延（propagation 一级分组，仅 ADMIN）', () => {
  const item = CONFIG_ITEMS.find((i) => i.id === 42);
  expect(item).toBeTruthy();
  expect(item.name).toBe('全局复用与经验蔓延');
  expect(item.level).toBe('propagation');
  expect(item.page).toBe('/propagation.html');
  expect(item.endpoint).toBe('/api/propagation/suggestions');
  expect(item.status).toBe('ready');
});

test('renderConfigCenter 渲染第三个一级分组「全局复用与经验蔓延」（data-level=propagation）', () => {
  const html = renderConfigCenter(CONFIG_ITEMS, {});
  expect(html).toContain('data-level="propagation"');
  expect(html).toContain('全局复用与经验蔓延');
  const propSec = html.match(/data-level="propagation">[\s\S]*?<\/section>/);
  expect(propSec ? propSec[0] : '').toContain('data-id="42"');
  expect(propSec ? propSec[0] : '').toContain('href="/propagation.html"');
});
```

同时把第一个测试（Task 1 改过的 `CONFIG_ITEMS 含 30 项`）更新为 31 项：

```js
test('CONFIG_ITEMS 含 31 项配置（数组按组连续排列：…G1 末尾追加 42；不含已删 25）', () => {
  expect(CONFIG_ITEMS.length).toBe(31);
  const ids = CONFIG_ITEMS.map((i) => i.id);
  expect(ids).toEqual([11,12,13,27,28,40,41,42,14,15,16,17,18,19,20,21,22,23,24,26,29,30,31,32,33,35,34,36,37,38,39]);
});
```

- [ ] **Step 2: 跑红**

Run: `npx vitest run test/web/configCenter.test.js`
Expected: FAIL（id42 不存在）

- [ ] **Step 3: 实现 `src/portal/configCenter.js`**

3a. CONFIG_ITEMS 在 id41 之后追加：

```js
  // 传播中枢 UI 入口（2026-09-05）：系统配置→租户成批复用（broadcast）+ 租户经验上行推广（promote）。
  // 后端已就绪：src/http/propagationRoutes.js 4 个 API（写经决策第0闸；上下贯通强制 ADMIN，§15.5）。
  { id: 42, name: '全局复用与经验蔓延', group: '平台与访问', level: 'propagation', status: 'ready', page: '/propagation.html', endpoint: '/api/propagation/suggestions', scope: 'platform', resolve: 'system-only', note: '系统配置向租户成批复用（强制下发 fill-only/override）+ 租户经验上行推广（复盘候选采纳/记忆→租户先例）；写经决策第0闸，上下贯通仅 ADMIN，禁删只增改' },
```

3b. LEVEL_GROUPS 增第三项（Task 1 改后的基础上）：

```js
export const LEVEL_GROUPS = [
  { level: 'system', name: '系统级', roles: ['ADMIN'] },
  { level: 'tenant', name: '租户级', roles: ['ten_admin', 'sysadmin', 'ADMIN'] },
  { level: 'propagation', name: '全局复用与经验蔓延', roles: ['ADMIN'] },
];
```

（renderConfigCenter 的 LEVEL_GROUPS.map 无需改动：id42 group='平台与访问' 会自动渲染子组卡片。）

- [ ] **Step 4: 跑绿**

Run: `npx vitest run test/web/configCenter.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git log -1 --oneline; git status --short
git add src/portal/configCenter.js test/web/configCenter.test.js
git commit -m "feat(config-center): 注册 id42 全局复用与经验蔓延（propagation 一级分组，仅 ADMIN）"
```

---

### Task 3: config.html 第三 TAB（仅 ADMIN 可见）

**Files:**
- Modify: `src/web/config.html`（LEVEL_GROUPS_MARKUP 增第 5 子组 + LEVEL_TABS 增第三 TAB）
- Test: `test/web/configCenter.test.js`

- [ ] **Step 1: 写失败测试**

在 `test/web/configCenter.test.js` 新增（并更新原「4 组全量覆盖」测试的组数与 id 并集）：

```js
test('config.html 增第三 TAB「全局复用与经验蔓延」（仅 ADMIN 可见，深链 /propagation.html）', () => {
  const html = readFileSync(new URL('../../src/web/config.html', import.meta.url), 'utf8');
  expect(html).toContain("level: 'propagation'");
  expect(html).toContain('全局复用与经验蔓延');
  expect(html).toContain("visible: me.level === 'ADMIN'");
  expect(html).toContain('/propagation.html');
  expect(html).toContain('items: [42]');   // 传播 TAB 的专属子组
});
```

原 `config.html 4 组全量覆盖 27 项` 测试同步改：`expect(groups.length).toBe(5);`，id 并集数组末尾追加 `42`（`...,39,40,41,42]`）。

- [ ] **Step 2: 跑红**

Run: `npx vitest run test/web/configCenter.test.js`
Expected: FAIL

- [ ] **Step 3: 实现 `src/web/config.html`**

3a. LEVEL_GROUPS_MARKUP（81-86 行）追加第 5 项：

```js
    { name: '全局复用与经验蔓延', items: [42] },   // 传播中枢（仅 ADMIN TAB；id42 深链 /propagation.html，后端 4 API 已就绪）
```

（system/tenant 两个 TAB 的 panel 过滤条件 `byId[id]?.level === lt.level` 会自动滤掉 id42，不会串组。）

3b. LEVEL_TABS（Task 1 改后的数组）追加第三项：

```js
    const LEVEL_TABS = [
      { level: 'system', name: '系统级', visible: me.level === 'ADMIN' },
      { level: 'tenant', name: '租户级', visible: true },
      { level: 'propagation', name: '全局复用与经验蔓延', visible: me.level === 'ADMIN' },
    ].filter((t) => t.visible);
```

（panel 渲染循环无需改：propagation TAB 内按子组过滤后仅剩 `全局复用与经验蔓延` 子组下的 id42 卡片，深链「打开编辑」→ /propagation.html。）

- [ ] **Step 4: 跑绿**

Run: `npx vitest run test/web/configCenter.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git log -1 --oneline; git status --short
git add src/web/config.html test/web/configCenter.test.js
git commit -m "feat(config-center): 配置中心新增「全局复用与经验蔓延」一级 TAB（仅 ADMIN）"
```

---

### Task 4: 新建 propagation.html（两区功能 + 留痕说明）

**Files:**
- Create: `src/web/propagation.html`
- Test: `test/web/propagationPage.test.js`

页面结构（对齐 config.html 范式：injectLayout + /portal/api.js + guard）：
- **守卫**：仅 ADMIN（me.level==='ADMIN'，ALIAS 同 Task 1 含 ten_admin 变体；非 ADMIN 显示 forbidden）。
- **区 A 经验蔓延候选**：`GET /api/propagation/suggestions` → 两张表（config_store 类：target/from→to/tenant_id + 采纳/忽略；memory 类：topic/tenant_id + 采纳）。采纳=`POST /api/propagation/accept {kind, ref, patch, tenantId}`，忽略=`POST /api/propagation/reject {ref, kind}`；操作后重载。
- **区 B 全局复用（强制下发）**：表单 key（文本）/ value（textarea，JSON.parse 校验）/ mode（`fill-only` 默认 | `override`）/ 目标租户（checkbox 多选，来源 `GET /api/tenants` → `j.tenants`，含「全部租户(targets=null)」快捷项）→ `POST /api/config/broadcast`；结果 alert 展示 updated 数。
- **区 C 留痕说明**（静态）：所有写经决策第 0 闸，留痕 `crm.propagation_action` + `crm.decision_event`；禁删只增改。

- [ ] **Step 1: 写失败测试** `test/web/propagationPage.test.js`

```js
import { test, expect } from 'vitest';
import { readFileSync } from 'fs';

test('propagation.html 守卫仅 ADMIN（ALIAS 含 ten_admin 变体）且接既有 4 个传播 API', () => {
  const html = readFileSync(new URL('../../src/web/propagation.html', import.meta.url), 'utf8');
  // 守卫：canonical ten_admin + 历史变体全归一；非 ADMIN 拦截
  expect(html).toContain("ten_admin: 'ADMIN-GATE'");
  expect(html).toContain('tan_admin');
  // 区 A：候选 + accept/reject
  expect(html).toContain('/api/propagation/suggestions');
  expect(html).toContain('/api/propagation/accept');
  expect(html).toContain('/api/propagation/reject');
  // 区 B：强制下发（fill-only 默认 / override；目标租户来自 /api/tenants）
  expect(html).toContain('/api/config/broadcast');
  expect(html).toContain('fill-only');
  expect(html).toContain('override');
  expect(html).toContain('/api/tenants');
  // 铁律：页面不发 DELETE；写经决策第0闸的说明在场
  expect(html).not.toMatch(/method:\s*'DELETE'/);
  expect(html).toContain('决策第 0 闸');
});
```

- [ ] **Step 2: 跑红**

Run: `npx vitest run test/web/propagationPage.test.js`
Expected: FAIL（文件不存在）

- [ ] **Step 3: 实现 `src/web/propagation.html`**

完整页面（可直接落盘）：

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>全局复用与经验蔓延</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; background: #0d1117; color: #e6edf3; }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 24px; }
  h1 { font-size: 22px; } h2 { font-size: 16px; margin-top: 32px; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #21262d; font-size: 13px; }
  .btn { cursor: pointer; border: 1px solid #30363d; background: #161b22; color: #e6edf3; border-radius: 6px; padding: 4px 12px; margin-right: 6px; }
  .btn.primary { background: #1f6feb; border-color: #1f6feb; color: #fff; }
  .muted { color: #8b949e; } .empty { color: #8b949e; padding: 12px 0; }
  .form-row { margin: 8px 0; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  input[type=text], textarea, select { background: #161b22; color: #e6edf3; border: 1px solid #30363d; border-radius: 6px; padding: 6px 8px; }
  textarea { width: 100%; min-height: 72px; font-family: monospace; }
  .tgt { margin-right: 12px; font-size: 13px; }
  #forbidden { display: none; }
  .note { font-size: 12px; color: #8b949e; border-left: 3px solid #30363d; padding-left: 10px; margin-top: 24px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>全局复用与经验蔓延</h1>
  <p class="muted">系统配置向租户成批复用 · 租户经验向系统/先例上行推广（所有写操作经决策第 0 闸，留痕 crm.propagation_action + decision_event，禁删只增改）</p>
  <div id="forbidden"><h3>需要平台 ADMIN 权限</h3><p>上下贯通（全局复用/经验蔓延）仅 ADMIN 可操作，请用管理员账号 <a href="/home.html">重新登录</a>。</p></div>
  <div id="app" style="display:none">

    <h2>① 经验蔓延候选（复盘候选 + 记忆推广）</h2>
    <div id="cands"><div class="empty">加载中…</div></div>

    <h2>② 全局复用（系统配置强制下发）</h2>
    <div class="form-row">
      <label>config_store 键 <input type="text" id="bcKey" placeholder="如 sales-thresholds" style="width:240px"></label>
      <label>模式
        <select id="bcMode">
          <option value="fill-only" selected>fill-only（仅未定制租户，安全）</option>
          <option value="override">override（覆盖全部目标租户）</option>
        </select>
      </label>
    </div>
    <div class="form-row"><textarea id="bcValue" placeholder='下发值（JSON），如 {"visitOverdueRedDays": 7}'></textarea></div>
    <div class="form-row" id="bcTargets"><span class="muted">目标租户加载中…</span></div>
    <div class="form-row">
      <button class="btn primary" id="bcGo">强制下发</button>
      <span class="muted">fill-only 不破坏既有租户定制；override 覆盖目标租户（均 upsert，不删除）</span>
    </div>

    <div class="note">
      留痕与闸门：采纳/忽略/下发均由后端先过角色闸（上下贯通强制 ADMIN），再 mint decision（config-change 场景）落 crm.decision_event，
      动作明细写 crm.propagation_action（status: accepted/rejected，不物理删除）；下发经 broadcastConfig 逐租户 upsert config_store。
    </div>
  </div>
</div>
<script type="module">
  import { injectLayout } from '/portal/layout.js';
  import { me, api } from '/portal/api.js';
  injectLayout();

  // 守卫：仅 ADMIN（ALIAS 归一 canonical，含 ten_admin 落库名与历史变体）
  const GATE = { admin: 'ADMIN-GATE', ADMIN: 'ADMIN-GATE', 'tan-admin': 'ADMIN-GATE', tan_admin: 'ADMIN-GATE', ten_admin: 'ADMIN-GATE', 'tenant-admin': 'ADMIN-GATE' };
  let ctx = null;
  try { const r = await me(); if (r && GATE[r.role] === 'ADMIN-GATE' && r.role.toUpperCase().startsWith('ADMIN')) ctx = r; } catch (e) { /* 401 → login */ }
  // 仅平台 ADMIN（admin/ADMIN）可入；ten_admin 等变体在此页仍需平台级 ADMIN 语义——后端 broadcast/系统级候选强制 ADMIN
  const isAdmin = ctx && String(ctx.role).toLowerCase() === 'admin';
  if (!isAdmin) {
    document.getElementById('app').style.display = 'none';
    document.getElementById('forbidden').style.display = 'block';
  } else {
    document.getElementById('app').style.display = 'block';
    loadCandidates();
    loadTargets();
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function loadCandidates() {
    const box = document.getElementById('cands');
    try {
      const j = await api('/api/propagation/suggestions');
      const cfg = j.config_store || [], mem = j.memory || [];
      if (!cfg.length && !mem.length) { box.innerHTML = '<div class="empty">暂无待处理候选（复盘产生 config_store 候选或租户记忆后在此汇聚）</div>'; return; }
      box.innerHTML = (cfg.length ? `<h3 class="muted" style="font-size:13px">配置旋钮候选（夜间复盘 draft_patches）</h3>
        <table><thead><tr><th>目标键</th><th>现值→建议值</th><th>租户</th><th>操作</th></tr></thead><tbody>`
        + cfg.map((c) => `<tr>
          <td><code>${esc(c.patch?.target)}</code></td>
          <td><code>${esc(JSON.stringify(c.patch?.from_value ?? ''))}</code> → <code>${esc(JSON.stringify(c.patch?.to_value ?? ''))}</code></td>
          <td>${esc(c.patch?.tenant_id || 'system')}</td>
          <td><button class="btn primary" data-acc='${esc(JSON.stringify({ kind: c.kind, ref: c.ref, patch: c.patch }))}'>采纳</button>
              <button class="btn" data-rej='${esc(JSON.stringify({ ref: c.ref, kind: c.kind }))}'>忽略</button></td>
        </tr>`).join('') + '</tbody></table>' : '')
        + (mem.length ? `<h3 class="muted" style="font-size:13px">记忆推广候选（task→tenant 先例）</h3>
        <table><thead><tr><th>主题</th><th>租户</th><th>操作</th></tr></thead><tbody>`
        + mem.map((m) => `<tr>
          <td>${esc(m.title)}</td><td>${esc(m.tenant_id)}</td>
          <td><button class="btn primary" data-acc='${esc(JSON.stringify({ kind: m.kind, ref: m.ref, memoryId: m.memoryId, tenantId: m.tenant_id }))}'>采纳为先例</button>
              <button class="btn" data-rej='${esc(JSON.stringify({ ref: m.ref, kind: m.kind }))}'>忽略</button></td>
        </tr>`).join('') + '</tbody></table>' : '');
      box.querySelectorAll('[data-acc]').forEach((b) => b.addEventListener('click', async () => {
        try { const r = await api('/api/propagation/accept', { method: 'POST', body: b.dataset.acc });
          alert('已采纳（决策 ' + (r.decisionId || '-') + '）'); loadCandidates();
        } catch (e) { alert('采纳失败：' + e.message); }
      }));
      box.querySelectorAll('[data-rej]').forEach((b) => b.addEventListener('click', async () => {
        try { await api('/api/propagation/reject', { method: 'POST', body: b.dataset.rej }); loadCandidates(); }
        catch (e) { alert('忽略失败：' + e.message); }
      }));
    } catch (e) { box.innerHTML = '<div class="empty">加载失败：' + esc(e.message) + '</div>'; }
  }

  async function loadTargets() {
    const box = document.getElementById('bcTargets');
    try {
      const j = await api('/api/tenants');
      const rows = j.tenants || [];
      box.innerHTML = '<span class="muted">目标租户：</span>'
        + `<label class="tgt"><input type="checkbox" id="tgtAll"> 全部租户（targets=null）</label>`
        + rows.filter((t) => t.tenant_id !== 'system').map((t) =>
          `<label class="tgt"><input type="checkbox" class="tgt-one" value="${esc(t.tenant_id)}"> ${esc(t.tenant_id)}</label>`).join('');
      const all = box.querySelector('#tgtAll');
      all.addEventListener('change', () => box.querySelectorAll('.tgt-one').forEach((c) => { c.checked = false; c.disabled = all.checked; }));
    } catch (e) { box.innerHTML = '<span class="muted">目标租户加载失败：' + esc(e.message) + '</span>'; }
  }

  document.getElementById('bcGo')?.addEventListener('click', async () => {
    const key = document.getElementById('bcKey').value.trim();
    const mode = document.getElementById('bcMode').value;
    const raw = document.getElementById('bcValue').value;
    let value; try { value = JSON.parse(raw); } catch (e) { return alert('下发值必须是合法 JSON：' + e.message); }
    const all = document.getElementById('tgtAll')?.checked;
    const targets = all ? null : [...document.querySelectorAll('.tgt-one:checked')].map((c) => c.value);
    if (!key) return alert('请填写 config_store 键');
    if (!all && !targets.length) return alert('请勾选目标租户或选「全部租户」');
    if (mode === 'override' && !confirm('override 将覆盖目标租户的既有定制（upsert 不删除），确认下发？')) return;
    try {
      const r = await api('/api/config/broadcast', { method: 'POST', body: JSON.stringify({ key, value, mode, targets }) });
      alert('下发完成（决策 ' + (r.decisionId || '-') + '）：' + JSON.stringify(r.updated ?? r));
    } catch (e) { alert('下发失败：' + e.message); }
  });
</script>
</body>
</html>
```

- [ ] **Step 4: 跑绿**

Run: `npx vitest run test/web/propagationPage.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git log -1 --oneline; git status --short
git add src/web/propagation.html test/web/propagationPage.test.js
git commit -m "feat(propagation): 新增全局复用与经验蔓延页（候选采纳/强制下发/留痕说明，仅 ADMIN）"
```

---

### Task 5: 全量回归 + 收尾

**Files:** 无新改动（验证 + 记忆沉淀）

- [ ] **Step 1: 相关面回归**

Run: `npx vitest run test/web test/http test/propagation`
Expected: 全绿；出现单红先重跑一次（全量回归 flaky ~2612，单次红不得直判回归，见工作记忆铁律）。

- [ ] **Step 2: 手工冒烟（PowerShell 友好，用户侧执行或 agent-browser 验证）**

1. 以 `admin` 登录 → `/config.html`：三个 TAB（系统级/租户级/全局复用与经验蔓延），TAB 名无角色字样。
2. 以 `ten_admin` 角色账号登录 → `/config.html`：仅见「租户级」TAB（验证 Task 1 ALIAS 修复），不可见传播 TAB。
3. admin 打开 `/propagation.html`：候选区/下发区正常渲染；用测试租户做一次 fill-only 下发冒烟。

- [ ] **Step 3: 记忆沉淀**

追加 `.workbuddy/memory/2026-09-05.md`：角色名 canonical=ten_admin 决议 + ALIAS 修复 + id42/propagation TAB 落点（configCenter.js / config.html / propagation.html / propagationRoutes.js 4 API）。

---

## Self-Review 记录

- **Spec 覆盖**：① 角色名统一（Task 1）② 菜单去角色化（Task 1）③ ALIAS bug 修复（Task 1 Step 4b）④ 新 TAB 仅 ADMIN（Task 2/3）⑤ 三区 UI（Task 4：候选/下发两功能区 + 留痕静态说明——留痕只读端点后端暂无，按 YAGNI 不新增后端，已在区 C 说明落库位置）。无遗漏。
- **占位符扫描**：所有代码步骤含完整代码；无 TBD/TODO。
- **类型/命名一致性**：suggestions 响应字段（config_store[]/memory[]、patch.target/from_value/to_value、memoryId/tenant_id/title）与 `propagationRoutes.js:27-61` 实际返回一致；broadcast 请求体 `{key,value,mode,targets}` 与 `propagationRoutes.js:188-201` 一致；tenants 响应 `{tenants:[{tenant_id,...}]}` 与 `tenantRouter.js:66-71` 一致。
