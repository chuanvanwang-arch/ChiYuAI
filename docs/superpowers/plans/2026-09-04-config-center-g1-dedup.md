# 配置中心 G1 两项去重（深链复用 admin-billing-console）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将配置中心 G1「平台与访问」下「租户管理」(id40) 与「平台套餐管理」(id41) 从本轮新建的平行页面改为深链到既有 `admin-billing-console.html` 的对应 tab，删除冗余页面，消除双重事实源。

**Architecture:** 复用优先——两项 `page` 字段改为 `/admin-billing-console.html#subs` / `#plans`；`admin-billing-console.html` 增加读 URL hash 定位初始 tab 的能力；删除本轮新建的 `tenant-management.html` / `platform-plan.html` 与 `routes.js` 中对应的 `sendFile` 路由。后端 `/api/billing/plans`、`/api/tenants`、`industry-onboarding` 智能体全部复用，零新增后端。

**Tech Stack:** Node.js ESM + Express、`configCenter.js`（纯数据配置中心）、Vitest、原生 HTML/CSS（`common.css` + `crm-*` 组件）。

> **Worktree 说明：** 本环境无 git 凭证，未建独立 worktree；在当前分支 `feat-multi-industry-meta-model` 上按任务提交（每个任务一 commit），由用户在本地执行 `git add`/`commit`。

---

## File Structure

| 文件 | 操作 | 责任 |
|---|---|---|
| `src/portal/configCenter.js` | Modify | id40/id41 的 `page` 改为深链 URL；note 改为"复用 admin-billing-console"语义 |
| `test/web/configCenter.test.js` | Modify | 新增断言：id40/id41 的 `page` 含深链；其余既有断言保留 |
| `src/http/routes.js` | Modify | 删除为两个新页加的 `sendFile` 路由 |
| `src/web/admin-billing-console.html` | Modify | 新增 `initTabFromHash()`：加载时按 `location.hash` 定位初始 tab，并监听 `hashchange` |
| `src/web/platform-plan.html` | Delete | 本轮新建的冗余页（= 套餐 tab 复刻） |
| `src/web/tenant-management.html` | Delete | 本轮新建，与 industry-onboarding agent 新建能力重叠 |

---

### Task 1: 新增失败测试——断言两项 page 为深链

**Files:**
- Test: `test/web/configCenter.test.js`

- [ ] **Step 1: 在 `configCenter.test.js` 末尾追加失败测试**

```js
test('G1 两项（id40 租户管理 / id41 平台套餐管理）page 深链到 admin-billing-console 对应 tab', () => {
  const t = CONFIG_ITEMS.find((i) => i.id === 40);
  const p = CONFIG_ITEMS.find((i) => i.id === 41);
  expect(t.page).toContain('admin-billing-console.html#subs');
  expect(p.page).toContain('admin-billing-console.html#plans');
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `C:/Users/wangchuan08/.workbuddy/binaries/node/versions/22.22.2-2/node.exe node_modules/vitest/vitest.mjs run test/web/configCenter.test.js -t "深链"`

Expected: FAIL —— 当前 id40.page=`/tenant-management.html`、id41.page=`/platform-plan.html`，不含深链子串。

---

### Task 2: 修改 configCenter.js 两项 page 为深链

**Files:**
- Modify: `src/portal/configCenter.js:15-16`

- [ ] **Step 1: 改写 id40 行**

old:
```js
  { id: 40, name: '租户管理', group: '平台与访问', status: 'ready', page: '/tenant-management.html', endpoint: '/api/tenants', scope: 'platform', resolve: 'system-only', note: '租户清单（用户数/粒子数）+ 新建租户（插 admin 用户，决策第0闸留痕）；禁删铁律，配置留空走 read-fallback' },
```
new:
```js
  { id: 40, name: '租户管理', group: '平台与访问', status: 'ready', page: '/admin-billing-console.html#subs', endpoint: '/api/tenants', scope: 'platform', resolve: 'system-only', note: '深链复用 admin-billing-console「租户订阅」tab（只读订阅全景）；新建租户走 industry-onboarding 智能体（POST /api/tenants），禁物理删' },
```

- [ ] **Step 2: 改写 id41 行**

old:
```js
  { id: 41, name: '平台套餐管理', group: '平台与访问', status: 'ready', page: '/platform-plan.html', endpoint: '/api/billing/plans', scope: 'platform', resolve: 'system-only', note: '套餐档位 CRUD（base_fee/seat/token/权益），写经 /api/admin/billing-plans，禁物理删（enabled 软停用）；计费设置同通道' },
```
new:
```js
  { id: 41, name: '平台套餐管理', group: '平台与访问', status: 'ready', page: '/admin-billing-console.html#plans', endpoint: '/api/billing/plans', scope: 'platform', resolve: 'system-only', note: '深链复用 admin-billing-console「套餐管理」tab（套餐维护软停用+计费设置）；写经 /api/admin/billing-plans，禁物理删' },
```

- [ ] **Step 3: 运行测试，确认通过**

Run: `C:/Users/wangchuan08/.workbuddy/binaries/node/versions/22.22.2-2/node.exe node_modules/vitest/vitest.mjs run test/web/configCenter.test.js`

Expected: PASS（含 Task 1 新增断言 + 既有 14 项全绿）。

- [ ] **Step 4: 语法校验**

Run: `C:/Users/wangchuan08/.workbuddy/binaries/node/versions/22.22.2-2/node.exe --check src/portal/configCenter.js && echo OK`

- [ ] **Step 5: Commit**

```bash
git add src/portal/configCenter.js test/web/configCenter.test.js
git commit -m "refactor(config): G1 两项 page 改为深链 admin-billing-console，消除平行页"
```

---

### Task 3: 删除 routes.js 中两个新页 sendFile 路由

**Files:**
- Modify: `src/http/routes.js:288-292`

- [ ] **Step 1: 删除以下整段（含注释）**

old:
```js
  // 平台与访问 · 租户管理（G1 id40）/ 平台套餐管理（G1 id41）：配置中心深链页（sendFile 实时读 src/web）
  app.get('/tenant-management.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/tenant-management.html', import.meta.url))));
  app.get('/platform-plan.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/platform-plan.html', import.meta.url))));
```

- [ ] **Step 2: 语法校验**

Run: `C:/Users/wangchuan08/.workbuddy/binaries/node/versions/22.22.2-2/node.exe --check src/http/routes.js && echo OK`

- [ ] **Step 3: Commit**

```bash
git add src/http/routes.js
git commit -m "refactor(routes): 删除 tenant-management / platform-plan 冗余 sendFile 路由"
```

---

### Task 4: admin-billing-console.html 支持 URL hash 定位初始 tab

**Files:**
- Modify: `src/web/admin-billing-console.html:126`（在 `window.showTab` 定义之后插入）

- [ ] **Step 1: 在 `showTab` 定义后插入深链初始化**

在 `admin-billing-console.html` 第 126 行（`window.showTab` 函数结束 `};` 之后）插入：

```js
  // ── 深链：从 URL hash 定位初始 tab（配置中心「租户管理」#subs / 「平台套餐管理」#plans）──
  function initTabFromHash() {
    const h = (location.hash || '').replace('#', '');
    if (h && document.getElementById('pane-' + h)) showTab(h);
  }
  window.addEventListener('hashchange', initTabFromHash);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initTabFromHash);
  else initTabFromHash();
```

> 说明：`#plans` 本就是默认 tab，深链 `#subs` 会让「租户管理」入口直达订阅 tab；`#settings` 亦可用。

- [ ] **Step 2: 手动验证（无单测，依赖浏览器）**

浏览器打开 `http://localhost:3000/admin-billing-console.html#subs` → 应停在「租户订阅」tab；打开 `#plans` → 停在「套餐管理」tab。

- [ ] **Step 3: Commit**

```bash
git add src/web/admin-billing-console.html
git commit -m "feat(billing-console): 支持 URL hash 定位初始 tab（#plans/#subs/#settings）"
```

---

### Task 5: 删除本轮新建的两个冗余页面

**Files:**
- Delete: `src/web/platform-plan.html`
- Delete: `src/web/tenant-management.html`

- [ ] **Step 1: 确认两文件确为本轮新建且无其它引用**

Run:
```bash
grep -rn "platform-plan.html\|tenant-management.html" src/ test/ --include=*.js --include=*.html || echo "NO_REF"
```
Expected: 仅 `configCenter.js`（Task 2 已改深链）与 `routes.js`（Task 3 已删路由）不再引用；输出 `NO_REF` 或仅剩注释/历史提及。

- [ ] **Step 2: 删除文件**

Run:
```bash
git rm src/web/platform-plan.html src/web/tenant-management.html
```

- [ ] **Step 3: Commit**

```bash
git commit -m "refactor(web): 删除冗余 tenant-management / platform-plan 页面（复用 admin-billing-console）"
```

---

### Task 6: 全量校验

**Files:** 全仓库

- [ ] **Step 1: ui-lint 基线确认无新增警告**

Run: `C:/Users/wangchuan08/.workbuddy/binaries/node/versions/22.22.2-2/node.exe scripts/ui-lint.mjs 2>&1 | tail -5`

Expected: 警告数 < 20（删两页后历史 `billing.html`/`landing.html` 遗留不变），且不再出现 `platform-plan.html` / `tenant-management.html` 相关项。

- [ ] **Step 2: configCenter 测试全绿**

Run: `C:/Users/wangchuan08/.workbuddy/binaries/node/versions/22.22.2-2/node.exe node_modules/vitest/vitest.mjs run test/web/configCenter.test.js`

Expected: PASS（全部用例，含 id40/id41 深链断言）。

- [ ] **Step 3: 三项 JS 语法校验**

Run:
```bash
for f in src/portal/configCenter.js src/http/routes.js; do C:/Users/wangchuan08/.workbuddy/binaries/node/versions/22.22.2-2/node.exe --check "$f" && echo "OK $f"; done
```

---

## Self-Review

1. **Spec coverage:** §2.1 五项改动均有对应 Task（configCenter → T1/T2；routes → T3；hash → T4；删页 → T5；校验 → T6）。设计文档中"复用优先、零新后端"在架构段体现。
2. **Placeholder scan:** 无 TBD/TODO；每步均含确切代码或命令。
3. **Type consistency:** `showTab(id)` 在 T4 调用时参数类型与既有定义一致（`#subs` 字符串对应 `pane-subs` 元素 id，已确认 `id="pane-subs"` 存在）。`CONFIG_ITEMS` 导出在测试中一致使用。
