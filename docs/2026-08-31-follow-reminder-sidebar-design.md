# 客户跟踪·侧栏告警角标 · 设计文档

- 日期：2026-08-31
- 触发：用户截图提出「告警提醒数字能否也在左侧导航『客户跟踪』这里进行提醒？」
- 范围：侧栏菜单 `客户跟踪` 入口增加动态角标（含「逾期未访」+「长期失联」两类合并数）；指名客户管理页三区页签 badge 同步对齐
- 流程：brainstorming（语义=合并 ✅ / 加载=轮询 60s ✅）→ 本文档 → 用户审查 → writing-plans → 实现

---

## §0 决策记录（brainstorming 收敛）

| 问点 | 用户选择 | 落点 |
|---|---|---|
| 角标显示什么 | B. 合并「逾期未访」+「长期失联（≥失联流失线）」两类 | §1.1 端点契约 |
| 加载时机 | B. 轮询 60s | §2.3 轮询机制 |
| 角标点击行为 | A. 默认进入客户跟踪页（无特殊跳转）—— 不需询问 | §2.1 入口 |
| 角色语义 | 沿用 `/api/board/named-account-manage` 既定语义：sales 本人 / admin·manager 全量 | §1.2 |
| 阈值 | `coverage.lost_contact_days`（默认 90 天）—— 复用 sales-thresholds 配置化铁律，零硬编码 | §1.1 |
| 失联范围 | 仅「指名客户」（与 Task3 边界一致：无主户剔除）—— 与 `alertRed` 统计同源，避免引入新口径 | §1.1 |

---

## §1 数据契约扩展

### §1.1 失联判定（`namedAccountBoard.js` `accountRow` 扩展）

```js
// 失联判定：现在 - 最后一次拜访时间 ≥ coverage.lost_contact_days（默认 90 天）
// 阈值经 readThreshold 读 sales-thresholds，零硬编码（与项目铁律一致）
const lastVisitAt = (() => {
  const notes = Array.isArray(pp.visit_notes) ? pp.visit_notes : [];
  if (!notes.length) return null;
  // 拜访时间取最大（最近一次）
  return notes.reduce((max, n) => {
    const t = n?.at ? new Date(n.at).getTime() : 0;
    return t > max ? t : max;
  }, 0);
})();
const lostContactDays = Number(readThreshold(thresholds, 'coverage.lost_contact_days', 90));
const lostContact = lastVisitAt ? (Date.now() - lastVisitAt) / 86400000 >= lostContactDays : false;
return {
  // ...既有字段
  lostContact, // boolean：是否失联（≥ lost_contact_days 天无拜访）
  lostContactDays: lastVisitAt ? Math.floor((Date.now() - lastVisitAt) / 86400000) : null,
};
```

边界对齐：
- **仅在 `isNamed === true` 时计算**（与 Task3 剔除无主户边界一致；非指名客户不计入角标）
- **「达标」与「失联」不冲突**：达标 = 窗口内实际 ≥ 应访次数；失联 = 长时间无拜访。两个判定独立
- **失联 + 逾期同时存在**：算作 1 个提醒（不重复计数）

### §1.2 端点扩展（`/api/board/named-account-manage`）

响应顶层新增字段（既有 `alertRed/alertYellow` 保持不变）：

```js
res.json({
  rows,
  count: rows.length,
  owner: ownerFilter,
  summary,
  alertRed,         // 既有：逾期未访红
  alertYellow,      // 既有：临近黄
  // 新增：合并提醒数（角标用）
  followReminders: alertRed + (summary.lostContactCount || 0),
  // 新增：失联数（细分明细，前端 tab 顶部 KPI 可用）
  lostContactCount: summary.lostContactCount || 0,
});
```

`boardSummary` 同步扩展：

```js
const lostContactCount = rows.reduce((m, r) => m + (r.lostContact ? 1 : 0), 0);
// ...
return {
  // ...
  lostContactCount,
};
```

### §1.3 数据流图

```
                         /api/board/named-account-manage
                                    │
                ┌───────────────────┼───────────────────┐
                ▼                   ▼                   ▼
           rows[]             alertRed/Y         followReminders
           alert,            (逾期未访)          (alertRed + lostContactCount)
           lostContact
                │                   │                   │
                ▼                   ▼                   ▼
      boardSummary.lostContact    KPI 顶部           侧栏 nav badge
      详情页/告警 Tab              (红/黄)            (「客户跟踪」 1)
```

---

## §2 前端实现

### §2.1 侧栏角标（`src/web/layout.js` `navHtml`）

扩展 `navHtml` 支持角标渲染。`menuFor(role)` 输出的菜单项扩展为可选 `badge` 字段（数字），由 `injectLayout()` 启动时填充。

```js
export function navHtml(role, badges = {}) {
  // ... 既有渲染
  return Object.entries(groups)
    .map(([g, items]) =>
      `<div class="nav-group">...` +
      items.map((i) => {
        const isActive = ...;
        const badge = badges[i.href];
        const badgeHtml = badge ? `<span class="nav-badge">${badge}</span>` : '';
        return `<a class="nav-item${isActive ? ' active' : ''}" href="${i.href}">
                  <span class="nav-label">${i.label}</span>${badgeHtml}
                </a>`;
      }).join('') + '</div>')
    .join('');
}
```

CSS 追加（tokens 语义变量，零硬编码）：
```css
.nav-badge { margin-left: auto; padding: 0 6px; min-width: 18px; height: 18px;
  border-radius: 9px; font-size: 11px; line-height: 18px; text-align: center;
  background: var(--err); color: #fff; font-weight: 600; }
```

### §2.2 轮询机制（`injectLayout()` 扩展）

```js
const POLL_FOLLOW_MS = 60_000;
let followReminders = 0;
let lastNavHtml = '';
const reRenderNav = () => {
  const html = navHtml(role, { '/follow': followReminders });
  if (html !== lastNavHtml) { sidebar.innerHTML = html; lastNavHtml = html; }
};
const pollFollow = async () => {
  try {
    const j = await get('/api/board/named-account-manage');
    followReminders = j.followReminders || 0;
    reRenderNav();
  } catch {}
};
pollFollow(); // 启动立即拉一次
setInterval(pollFollow, POLL_FOLLOW_MS);
```

### §2.3 三区页签 badge 同步（`named-account-manage.html`）

将现有「🔔 告警提醒 N」badge 改用 `followReminders`（与侧栏同源）：

```js
const badge = document.getElementById('tab-alerts');
const fr = j.followReminders || 0;
badge.innerHTML = fr > 0 ? `🔔 告警提醒 <span class="badge">${fr}</span>` : '🔔 告警提醒';
```

renderAlerts 同步显示「逾期红 + 失联」两类（失联以黄色底或独立列区分）：

```js
function renderAlerts(rows) {
  const reds = rows.filter(r => r.alert === 'red');
  const losts = rows.filter(r => r.lostContact);
  // 渲染 2 个子表（红 / 失联），确保两类都可见
}
```

---

## §3 文件变更清单

| 文件 | 变更 |
|---|---|
| `src/sales/namedAccountBoard.js` (**修改**) | `accountRow` 加 `lostContact/lostContactDays` 字段；`boardSummary` 加 `lostContactCount` 汇总 |
| `src/http/routes.js` (**修改**) | `/api/board/named-account-manage` 响应顶层加 `followReminders/lostContactCount` |
| `src/web/layout.js` (**修改**) | `navHtml` 支持 `badges` 参数；`injectLayout` 加 60s 轮询 + 启动立即拉取 |
| `src/portal/layoutMenu.js` (**可能**) | 给「客户跟踪」项增加 key 常量（不强制） |
| `src/web/named-account-manage.html` (**修改**) | tab badge 用 followReminders；renderAlerts 分两类展示 |
| `test/sales-named-accounts/named-account-board.test.js` (**修改**) | 补 lostContact 字段断言 |
| `test/http/named-account-manage-board.test.js` (**修改**) | 补 followReminders/lostContactCount 断言 |
| `test/web/layout-nav.test.js` (**新建**) | navHtml 渲染 badge 断言（mock role + badges） |
| `docs/2026-08-30-named-account-manage-design.md` (**修改**) | §1.2 补 followReminders 字段；§4 补侧栏角标说明 |

---

## §4 风险与边界

1. **轮询失败**：catch 静默（与既有 SSE 容错一致）；UI 角标显示上次成功值
2. **跨标签页同步**：60s 轮询不解决多 tab 数据漂移；如需 strict 一致，需 SSE 事件总线（本次不引入）
3. **失联判定与告警冲突**：同一客户可能既「逾期红」又「失联」—— `followReminders` 去重（同一客户最多 1 计数）。
   实现口径：`rows.filter((r) => r.alert === 'red' || r.lostContact).length`
   （等价于原表述 `alertRed + lostContactCount - bothCount`；采用集合并集写法更直观，已由
   `test/http/named-account-manage-board.test.js` 的「去重」用例守卫：严格 ≤ 简单相加）
4. **admin 视角全团队**：「客户跟踪」页本身是否支持全量——已有 `?owner=` 查询参数；admin/manager 默认全量，sales 默认本人（与 `account-manage` 端点一致）
5. **性能**：60s 轮询 + 单端点 PG 查询（带索引），单次 ~50ms，可接受

---

## §5 验收标准

| 检查项 | 期望 |
|---|---|
| admin 登录后，左侧「客户跟踪」出现红色 badge | 显示「应访未访 + 失联」合并数 |
| badge 数字 60s 内自动刷新 | 轮询触发后 DOM 更新 |
| 点「客户跟踪」进入页面 | 默认显示该页（与原行为一致） |
| 进入指名客户管理页「告警提醒」tab badge | 与侧栏数字同源一致 |
| sales 角色登录 | badge 显示本人名下合并数（非全量） |
| 无逾期无失联 | badge 隐藏 |
