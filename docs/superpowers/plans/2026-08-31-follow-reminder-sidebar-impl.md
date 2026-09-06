# 客户跟踪·侧栏告警角标 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在左侧导航「客户跟踪」入口增加动态告警角标（合并「应访未访逾期红」+「长期失联≥90天」两类，去重计数），并让指名客户管理页三区页签 badge 与之同源。

**Architecture:** 后端在既有 `/api/board/named-account-manage` 聚合端点扩展 `followReminders`/`lostContactCount` 顶层字段（不新增端点，复用既有 owner 角色语义）；失联判定复用 `coverage.lost_contact_days` 阈值（sales-thresholds 配置化，零硬编码），并 DRY 提取纯函数供 `gapHint` 与 `accountRow` 共用（消除既有第二份实现的双源风险）。前端 `navHtml(role, badges)` 扩展支持角标渲染（向后兼容），`injectLayout()` 启动时拉取一次 + 每 60 秒轮询刷新侧栏。

**Tech Stack:** Node 22 + ESM + Express 4 + PostgreSQL 16（pgcrypto，schema `crm`）+ vitest 3；前端原生 JS + `tokens.css` 语义变量（零硬编码色值）。

**设计文档:** `docs/2026-08-31-follow-reminder-sidebar-design.md`（已批准）

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/sales/namedAccountBoard.js` (**修改**) | DRY 提取 `lastVisitAtOf(p)` / `isLostContact(p, thresholds)` 纯函数；`accountRow` 加 `lostContact`/`lastContactDays` 字段；`boardSummary` 加 `lostContactCount` 汇总 |
| `src/http/routes.js` (**修改**) | `/api/board/named-account-manage` 响应顶层加 `followReminders`/`lostContactCount`（既有 `alertRed`/`alertYellow` 不变） |
| `src/web/layout.js` (**修改**) | `navHtml(role, badges)` 支持角标（向后兼容）；`injectLayout()` 加启动拉取 + 60s 轮询刷新侧栏 |
| `src/web/named-account-manage.html` (**修改**) | 三区页签 badge 改用 `followReminders`；`renderAlerts` 分「逾期红 / 失联」两类展示 |
| `test/sales-named-accounts/named-account-board.test.js` (**修改**) | 补 `lostContact` 字段判定断言（含边界：从未拜访 / 恰好阈值 / 非指名不计） |
| `test/http/named-account-manage-board.test.js` (**修改**) | 补 `followReminders`/`lostContactCount` 端点断言（含去重：同客户既逾期又失联只计 1） |
| `test/web/layout-nav.test.js` (**新建**) | `navHtml` 角标渲染纯函数测试（无 badge / 有 badge / 向后兼容） |
| `docs/2026-08-30-named-account-manage-design.md` (**修改**) | §1.2 补 `followReminders` 字段；§4 补侧栏角标说明 |

---

### Task 1: namedAccountBoard 失联判定（DRY 提取 + 字段扩展）

**Files:**
- Modify: `src/sales/namedAccountBoard.js`（`gapHint` 52-70 行区、`accountRow` 30-49 行、`boardSummary` 147-176 行）
- Test: `test/sales-named-accounts/named-account-board.test.js`

- [ ] **Step 1: 写失败测试**

`test/sales-named-accounts/named-account-board.test.js` 追加：

```javascript
import { accountRow, boardSummary, lastVisitAtOf, isLostContact } from '../../src/sales/namedAccountBoard.js';
import { mergedThresholds } from '../../src/sales/salesThresholds.js';

const TH = mergedThresholds({}); // coverage.lost_contact_days 默认 90

test('lastVisitAtOf 取最近一次拜访时间戳（无拜访返回 null）', () => {
  const now = Date.now();
  const d100 = new Date(now - 100 * 86400000).toISOString();
  const d10 = new Date(now - 10 * 86400000).toISOString();
  expect(lastVisitAtOf({ visit_notes: [{ at: d100 }, { at: d10 }] })).toBe(new Date(d10).getTime());
  expect(lastVisitAtOf({ visit_notes: [] })).toBeNull();
  expect(lastVisitAtOf({})).toBeNull();
  // 脏数据：at 非法被过滤
  expect(lastVisitAtOf({ visit_notes: [{ at: 'not-a-date' }] })).toBeNull();
});

test('isLostContact 按 coverage.lost_contact_days 判定（阈值可配）', () => {
  const now = Date.now();
  // 100 天前 → 超过默认 90 天 → true
  expect(isLostContact({ visit_notes: [{ at: new Date(now - 100 * 86400000).toISOString() }] }, TH)).toBe(true);
  // 10 天前 → false
  expect(isLostContact({ visit_notes: [{ at: new Date(now - 10 * 86400000).toISOString() }] }, TH)).toBe(false);
  // 从未拜访 → false（新客户不算失联，避免误报）
  expect(isLostContact({ visit_notes: [] }, TH)).toBe(false);
  // 阈值可调：配置成 5 天 → 10 天前变 true
  const tight = mergedThresholds({ coverage: { lost_contact_days: 5 } });
  expect(isLostContact({ visit_notes: [{ at: new Date(now - 10 * 86400000).toISOString() }] }, tight)).toBe(true);
});

test('accountRow 输出 lostContact/lastContactDays（仅指名客户计算）', () => {
  const now = Date.now();
  const named = accountRow(
    { id: 'A-1', payload: { name: '失联户', named_owner: 'alice', named_state: 'active',
      visit_notes: [{ at: new Date(now - 100 * 86400000).toISOString() }] } },
    [], [], {}, [], TH
  );
  expect(named.named).toBe(true);
  expect(named.lostContact).toBe(true);
  expect(named.lastContactDays).toBe(100);

  const fresh = accountRow(
    { id: 'A-2', payload: { name: '活跃户', named_owner: 'bob', named_state: 'active',
      visit_notes: [{ at: new Date(now - 3 * 86400000).toISOString() }] } },
    [], [], {}, [], TH
  );
  expect(fresh.lostContact).toBe(false);
  expect(fresh.lastContactDays).toBe(3);

  // 无主户（非指名）→ lostContact 恒 false（与 alertRed 统计同源，不引入新口径）
  const orphan = accountRow(
    { id: 'A-3', payload: { name: '无主户', visit_notes: [{ at: new Date(now - 200 * 86400000).toISOString() }] } },
    [], [], {}, [], TH
  );
  expect(orphan.named).toBe(false);
  expect(orphan.lostContact).toBe(false);
});

test('boardSummary 汇总 lostContactCount', () => {
  const now = Date.now();
  const accs = [
    { id: 'A-1', payload: { name: '失联1', named_owner: 'alice', named_state: 'active',
      visit_notes: [{ at: new Date(now - 100 * 86400000).toISOString() }] } },
    { id: 'A-2', payload: { name: '失联2', named_owner: 'alice', named_state: 'active',
      visit_notes: [{ at: new Date(now - 120 * 86400000).toISOString() }] } },
    { id: 'A-3', payload: { name: '活跃', named_owner: 'alice', named_state: 'active',
      visit_notes: [{ at: new Date(now - 3 * 86400000).toISOString() }] } },
    { id: 'A-4', payload: { name: '无主', visit_notes: [{ at: new Date(now - 300 * 86400000).toISOString() }] } },
  ];
  const s = boardSummary(accs, [], [], {}, 'alice', [], {}, TH);
  expect(s.lostContactCount).toBe(2); // A-1/A-2 失联；A-3 活跃；A-4 无主不计
});
```

- [ ] **Step 2: 运行验证失败**

Run: `PGDATABASE=plm_test node node_modules/vitest/dist/cli.js run test/sales-named-accounts/named-account-board.test.js`
Expected: FAIL（`lastVisitAtOf`/`isLostContact` 未导出；`lostContact` 字段不存在）

- [ ] **Step 3: 最小实现**

`src/sales/namedAccountBoard.js` —— 在 `gapHint` 之前插入两个纯函数（DRY 提取，消除既有第二份实现）：

```javascript
// 最近一次拜访时间戳（毫秒；无拜访/全脏数据 → null）
// DRY 提取（2026-08-31）：gapHint 的「接触流失警戒」与 accountRow 的 lostContact 判定共用同一口径，
// 避免同一逻辑两处实现导致的双源漂移。
export function lastVisitAtOf(p = {}) {
  const notes = Array.isArray(p.visit_notes) ? p.visit_notes : [];
  const ts = notes
    .map((n) => (n?.at ? new Date(n.at).getTime() : NaN))
    .filter((t) => !Number.isNaN(t));
  return ts.length ? Math.max(...ts) : null;
}

// 失联判定：距最近一次拜访 ≥ coverage.lost_contact_days 天（默认 90，配置可调）
// 契约：从未拜访（lastAt=null）→ false（新客户不算失联，避免误报）
export function isLostContact(p = {}, thresholds = DEFAULT_THRESHOLDS) {
  const lastAt = lastVisitAtOf(p);
  if (!lastAt) return false;
  const lostContactDays = Number(readThreshold(thresholds, 'coverage.lost_contact_days', 90));
  return (Date.now() - lastAt) > lostContactDays * 86400000;
}
```

`gapHint` 改用提取函数（第 60-69 行区，替换 `lastAt` IIFE 与判定）：

```javascript
  const lastAt = lastVisitAtOf(p);
  if (lastAt && isLostContact(p, thresholds)) gaps.push(`接触流失警戒（>${lostContactDays}天无拜访）`);
```

`accountRow` 返回值（`behavior,` 之前）追加两字段：

```javascript
    // 失联判定（侧栏角标「长期失联」提醒用；仅指名客户计算，与 alertRed 统计同源）
    lostContact: isNamed ? isLostContact(pp, thresholds) : false,
    lastContactDays: (() => {
      if (!isNamed) return null;
      const t = lastVisitAtOf(pp);
      return t ? Math.floor((Date.now() - t) / 86400000) : null;
    })(),
```

`boardSummary` 返回值追加：

```javascript
    lostContactCount: rows.reduce((m, r) => m + (r.lostContact ? 1 : 0), 0),
```

- [ ] **Step 4: 运行验证通过**

Run: `PGDATABASE=plm_test node node_modules/vitest/dist/cli.js run test/sales-named-accounts/named-account-board.test.js`
Expected: PASS（既有用例不回归：`gapHint` 行为不变，`buildNamedAccountBoard` 契约不变）

- [ ] **Step 5: Commit**

```bash
git add src/sales/namedAccountBoard.js test/sales-named-accounts/named-account-board.test.js
git commit -m "feat(sales): 指名客户失联判定纯函数 + lostContact 字段（DRY 提取，侧栏角标数据源）"
```

---

### Task 2: 聚合端点扩展 followReminders

**Files:**
- Modify: `src/http/routes.js`（`/api/board/named-account-manage` 端点，约 299-330 行）
- Test: `test/http/named-account-manage-board.test.js`

- [ ] **Step 1: 写失败测试**

`test/http/named-account-manage-board.test.js` 追加（复用文件既有 `beforeEach` 种子与 admin 登录 helper）：

```javascript
  it('响应含 followReminders / lostContactCount（侧栏角标数据源）', async () => {
    const loginRes = await app.fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    });
    const login = await loginRes.json();
    const res = await app.fetch('/api/board/named-account-manage', {
      headers: { authorization: `Bearer ${login.token}` },
    });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.followReminders).toBeTypeOf('number');
    expect(j.lostContactCount).toBeTypeOf('number');
    // 既有字段不回归
    expect(j.alertRed).toBeTypeOf('number');
    expect(j.alertYellow).toBeTypeOf('number');
    // 合并语义：followReminders = 逾期红 ∪ 失联（去重，非简单相加）
    const rows = j.rows || [];
    const union = rows.filter((r) => r.alert === 'red' || r.lostContact).length;
    expect(j.followReminders).toBe(union);
    // 明细行含失联字段
    for (const r of rows) expect(r).toHaveProperty('lostContact');
  });
```

- [ ] **Step 2: 运行验证失败**

Run: `PGDATABASE=plm_test node node_modules/vitest/dist/cli.js run test/http/named-account-manage-board.test.js`
Expected: FAIL（`followReminders` undefined）

- [ ] **Step 3: 最小实现**

`src/http/routes.js` 的 `/api/board/named-account-manage` 端点：在 `const alertYellow = ...` 之后、`res.json(...)` 之前插入：

```javascript
      // 侧栏「客户跟踪」角标数据源（2026-08-31）：逾期红 ∪ 长期失联（同一客户只计 1，去重）
      const followReminders = rows.filter((r) => r.alert === 'red' || r.lostContact).length;
      const lostContactCount = rows.filter((r) => r.lostContact).length;
```

`res.json` 改为：

```javascript
      res.json({
        rows, count: rows.length, owner: ownerFilter, summary,
        alertRed, alertYellow,
        followReminders, lostContactCount,
      });
```

- [ ] **Step 4: 运行验证通过**

Run: `PGDATABASE=plm_test node node_modules/vitest/dist/cli.js run test/http/named-account-manage-board.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/http/routes.js test/http/named-account-manage-board.test.js
git commit -m "feat(http): 聚合端点扩展 followReminders/lostContactCount（客户跟踪侧栏角标数据源）"
```

---

### Task 3: 侧栏角标渲染 + 60s 轮询

**Files:**
- Modify: `src/web/layout.js`（`navHtml` 9-24 行、`injectLayout` 44-66 行）
- Test: `test/web/layout-nav.test.js`（新建）

- [ ] **Step 1: 写失败测试**

新建 `test/web/layout-nav.test.js`：

```javascript
// test/web/layout-nav.test.js — 侧栏导航角标（2026-08-31 客户跟踪告警角标）
import { test, expect } from 'vitest';
import { navHtml } from '../../src/web/layout.js';

test('navHtml 无 badges 时行为不变（向后兼容）', () => {
  const html = navHtml('sales');
  expect(html).toContain('客户跟踪');
  expect(html).not.toContain('nav-badge');
});

test('navHtml 有 badge 时渲染角标（按 href 匹配）', () => {
  const html = navHtml('sales', { '/named-accounts.html': 3 });
  expect(html).toContain('nav-badge');
  expect(html).toContain('>3</span>');
  // 角标挂在「客户跟踪」项内（href 匹配），不影响其它项
  const follow = html.split('客户跟踪')[1] || '';
  expect(follow.slice(0, 200)).toContain('nav-badge');
});

test('badge 为 0 或 undefined 时不渲染', () => {
  expect(navHtml('sales', { '/named-accounts.html': 0 })).not.toContain('nav-badge');
  expect(navHtml('sales', { '/pipeline.html': 2 })).not.toContain('nav-badge');
});

test('admin 角色菜单含系统分组（角标不影响 RBAC 过滤）', () => {
  const html = navHtml('admin', { '/named-accounts.html': 1 });
  expect(html).toContain('配置中心');
  expect(html).toContain('nav-badge');
});
```

- [ ] **Step 2: 运行验证失败**

Run: `PGDATABASE=plm_test node node_modules/vitest/dist/cli.js run test/web/layout-nav.test.js`
Expected: FAIL（`navHtml` 不接收 badges，无 `nav-badge` 输出）

- [ ] **Step 3: 最小实现**

`src/web/layout.js` 第 9-24 行 `navHtml` 改为：

```javascript
// 纯函数：左侧导航 HTML（group→items，当前路径高亮）
// badges（2026-08-31）：{ [href]: number } —— 大于 0 时在该导航项右侧渲染红色角标；
//   不传/为 0 时行为与改造前完全一致（向后兼容，既有页面与单测不受影响）。
export function navHtml(role, badges = {}) {
  const groups = {};
  for (const m of menuFor(role)) (groups[m.group] ||= []).push(m);
  const active = (typeof location !== 'undefined') ? location.pathname : '';
  return Object.entries(groups)
    .map(([g, items]) =>
      `<div class="nav-group"><div class="nav-group-title">${g}</div>` +
      items.map((i) => {
        const isActive = active === i.href || (i.href !== '/' && active.startsWith(i.href.split('?')[0]));
        const n = Number(badges?.[i.href] || 0);
        const badgeHtml = n > 0 ? `<span class="nav-badge">${n}</span>` : '';
        // 标签包一层 <span>：把裸文本节点（display:flex 下会被包成 anonymous flex item，
        // 在部分浏览器/字体/缩放下首字符会被 flex 容器左边裁掉）换成真实元素，
        // 统一 .nav-item 文本渲染的 box 模型。视觉无变化（gap:8px 在单子元素下为 0）。
        return `<a class="nav-item${isActive ? ' active' : ''}" href="${i.href}"><span class="nav-label">${i.label}</span>${badgeHtml}</a>`;
      }).join('') + `</div>`)
    .join('');
}
```

`injectLayout()` 内、在 `document.body.appendChild(shell);` 之后追加轮询：

```javascript
  // ── 「客户跟踪」告警角标（2026-08-31）：启动拉一次 + 每 60s 轮询刷新侧栏 ──
  // 语义：应访未访(红) ∪ 长期失联(≥coverage.lost_contact_days)，由聚合端点去重计数
  const FOLLOW_HREF = '/named-accounts.html';
  const POLL_MS = 60000;
  const sidebar = shell.querySelector('.sidebar');
  let followBadges = {};
  const renderNav = () => { if (sidebar) sidebar.innerHTML = navHtml(role, followBadges); };
  const pollFollowBadge = async () => {
    try {
      const j = await get('/api/board/named-account-manage');
      const n = Number(j?.followReminders || 0);
      const next = n > 0 ? { [FOLLOW_HREF]: n } : {};
      // 仅在数字变化时重渲染，避免无谓 DOM 重排
      if ((followBadges[FOLLOW_HREF] || 0) !== (next[FOLLOW_HREF] || 0)) {
        followBadges = next;
        renderNav();
      }
    } catch { /* 静默：未登录/端点异常时角标保持上次值，不阻断页面 */ }
  };
  pollFollowBadge();
  setInterval(pollFollowBadge, POLL_MS);
```

CSS 追加 —— 侧栏样式（`.sidebar`/`.nav-item`）定义在 `src/web/common.css` 第 41-46 行，角标样式**同源追加到 `common.css` 第 46 行（`.nav-item.active` 规则）之后**（tokens 语义变量，零硬编码）：

```css
.nav-badge{margin-left:auto;min-width:18px;height:18px;padding:0 6px;border-radius:9px;
  font-size:11px;line-height:18px;text-align:center;background:var(--err);color:#fff;
  font-weight:600;flex:none}
```

> 注：`layout.js` 自身**不含** `<style>` 块（154 行全为脚本），故不得在其中注入样式；角标 CSS 唯一正确落点是 `common.css`（与 `.nav-item` 同源，`margin-left:auto` 依赖 `.nav-item` 的 `display:flex`）。

- [ ] **Step 4: 运行验证通过**

Run: `PGDATABASE=plm_test node node_modules/vitest/dist/cli.js run test/web/layout-nav.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/web/layout.js test/web/layout-nav.test.js
git commit -m "feat(web): 侧栏导航角标渲染 + 客户跟踪 60s 轮询刷新"
```

---

### Task 4: 三区页签 badge 同源 + 告警区两类展示

**Files:**
- Modify: `src/web/named-account-manage.html`
- Test: `test/http/named-account-manage-board.test.js`（补页面契约断言）

- [ ] **Step 1: 写失败测试**

`test/http/named-account-manage-board.test.js` 的 Task8 describe 内追加：

```javascript
  it('页面 badge 数据源改为 followReminders（与侧栏同源）', async () => {
    const res = await app.fetch('/named-account-manage.html');
    const html = await res.text();
    expect(html).toContain('followReminders');
    expect(html).toContain('lostContact');        // 告警区两类展示
    expect(html).not.toContain('loadAlerts(');    // 旧的独立告警加载函数已移除
    // 仍不依赖未挂载的 /api/alerts
    expect(html).not.toContain('/api/alerts?kind=named_visit_overdue');
  });
```

- [ ] **Step 2: 运行验证失败**

Run: `PGDATABASE=plm_test node node_modules/vitest/dist/cli.js run test/http/named-account-manage-board.test.js`
Expected: FAIL（页面尚用 `alertRed` 且无 `lostContact`）

- [ ] **Step 3: 最小实现**

`src/web/named-account-manage.html` 内：

1) `renderAlerts` 改为两类（红 / 失联）：

```javascript
  function renderAlerts(rows) {
    const reds = (rows || []).filter(r => r.alert === 'red');
    const losts = (rows || []).filter(r => r.lostContact && r.alert !== 'red'); // 去重：已计入红的不重复
    if (!reds.length && !losts.length) { alertRoot.innerHTML = '<div class="muted">暂无逾期/失联提醒</div>'; return; }
    const rowHtml = (r, kind) => `<tr class="row">
      <td><a href="/account-360.html?id=${esc(r.id)}">${esc(r.name)}</a></td>
      <td>${esc(r.owner)}</td>
      <td>${kind === 'red'
        ? `<span class="warn">逾期 ${r.overdueDays != null ? esc(r.overdueDays) + '天' : '—'}</span>`
        : `<span class="warn">失联 ${r.lastContactDays != null ? esc(r.lastContactDays) + '天无拜访' : '—'}</span>`}</td>
      <td>${r.visitDue ? new Date(r.visitDue).toLocaleDateString('zh-CN') : '—'}</td>
      <td>${r.visitTarget != null ? esc(r.visitTarget) + '次' : '—'} / 实际 ${r.visits30 ?? 0}</td>
      <td><a href="/account-360.html?id=${esc(r.id)}">去拜访 →</a></td>
    </tr>`;
    const table = (title, list, kind) => list.length
      ? `<h4 class="muted" style="margin:14px 0 6px">${title}（${list.length}）</h4>
         <table><thead><tr><th>客户</th><th>销售</th><th>状态</th><th>应访日</th><th>应访/实际</th><th>操作</th></tr></thead>
         <tbody>${list.map(r => rowHtml(r, kind)).join('')}</tbody></table>`
      : '';
    alertRoot.innerHTML = table('🔴 应访未访', reds, 'red') + table('🟠 长期失联', losts, 'lost');
  }
```

2) `load()` 内 badge 与横幅改用 `followReminders`：

```javascript
      const fr = j.followReminders || 0;
      if (fr > 0) { banner.classList.add('show'); banner.classList.remove('ok'); banner.innerHTML = `⚠️ 你有 <b>${fr}</b> 个客户需要关注（应访未访/长期失联），请尽快安排拜访。`; }
      else { banner.classList.add('show'); banner.classList.add('ok'); banner.innerHTML = '✅ 当前客户拜访与接触均正常。'; }
      const badge = document.getElementById('tab-alerts');
      badge.innerHTML = fr > 0 ? `🔔 告警提醒 <span class="badge">${fr}</span>` : '🔔 告警提醒';
```

- [ ] **Step 4: 运行验证通过**

Run: `PGDATABASE=plm_test node node_modules/vitest/dist/cli.js run test/http/named-account-manage-board.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/web/named-account-manage.html test/http/named-account-manage-board.test.js
git commit -m "feat(web): 指名客户管理页告警区两类展示 + 页签 badge 与侧栏同源"
```

---

### Task 5: 文档同步 + 全量回归

**Files:**
- Modify: `docs/2026-08-30-named-account-manage-design.md`（§1.2 字段表、§4 前端段落）
- Modify: `docs/2026-08-31-follow-reminder-sidebar-design.md`（标记已实施）

- [ ] **Step 1: 同步设计文档**

`docs/2026-08-30-named-account-manage-design.md` §3 接口契约表下方补：

```markdown
| 响应顶层字段 | `followReminders` / `lostContactCount` | 侧栏「客户跟踪」角标数据源：逾期红 ∪ 长期失联（去重） | 同端点 |
```

同时把 `docs/2026-08-31-follow-reminder-sidebar-design.md` §4 风险 3 的去重表述统一为与实现一致的口径（设计文档原文为减法公式 `alertRed + lostContactCount - bothCount`，实现采用更直接的集合并集，二者等价但表述需统一，避免后人误解）：

```markdown
3. **失联判定与告警冲突**：同一客户可能既「逾期红」又「失联」—— `followReminders` 去重（同一客户最多 1 计数），
   实现口径：`rows.filter((r) => r.alert === 'red' || r.lostContact).length`
   （等价于设计文档原表述 `alertRed + lostContactCount - bothCount`）

§4 前端段落补：

```markdown
  登录后侧栏「客户跟踪」入口显示红色角标（数字 = followReminders），
  由 layout.js 启动时拉取一次 + 每 60s 轮询刷新（见 docs/2026-08-31-follow-reminder-sidebar-design.md）。
```

- [ ] **Step 2: 运行全量相关回归**

Run: `PGDATABASE=plm_test node node_modules/vitest/dist/cli.js run test/sales-named-accounts/named-account-board.test.js test/http/named-account-manage-board.test.js test/web/layout-nav.test.js test/sales-named-accounts/named-account-assign.test.js test/scheduler/named-visit-scan.test.js test/web/businessDataCenter.test.js`
Expected: 全绿（若出现非本计划相关失败，按项目铁律单独小批量重跑判定是否为并发会话漂移）

- [ ] **Step 3: 全量回归（可选，需时约 5 分钟）**

Run: `PGDATABASE=plm_test node node_modules/vitest/dist/cli.js run`
Expected: 与实施前基线对比，不新增失败（记录已知并发漂移项，不擅自修复他会话文件）

- [ ] **Step 4: Commit**

```bash
git add docs/2026-08-30-named-account-manage-design.md docs/2026-08-31-follow-reminder-sidebar-design.md
git commit -m "docs: 客户跟踪侧栏告警角标设计同步与实施标记"
```

---

## 实施注意（铁律提醒）

1. **阈值零硬编码**：失联天数一律经 `readThreshold(thresholds, 'coverage.lost_contact_days', 90)`；不得写死 90
2. **DRY**：`lastVisitAtOf`/`isLostContact` 提取后，`gapHint` 必须改用它们（既有用例保证行为不变）
3. **向后兼容**：`navHtml(role)` 不传 badges 时输出必须与改造前逐字节一致
4. **去重语义**：`followReminders` = 逾期红 ∪ 失联，同一客户只计 1（非 `alertRed + lostContactCount` 简单相加）
5. **无主户剔除**：`lostContact` 仅在 `isNamed === true` 时计算，与 `alertRed` 统计口径同源
6. **绝不 `git add -A`**：本仓库存在并发会话未提交文件，提交一律 pathspec 限定
7. **测试库隔离**：`PGDATABASE=plm_test` 仅 vitest 生效；**不要 TRUNCATE `crm.crm_users`**（共享库，会破坏其它测试文件的 alice 用户）
8. **路由生效**：`src/http/routes.js` 改动需重启 server（`app.get` 启动时注册；改静态 HTML/JS 不需重启）
