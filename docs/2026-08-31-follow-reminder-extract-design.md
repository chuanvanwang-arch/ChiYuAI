# 告警模块复用·挪出「指名客户管理」 · 设计文档

- 日期：2026-08-31
- 触发：用户截图指出「应访未访」这块告警数据应**挪出**「指名客户管理」深处，让工作台和客户跟踪页都能直接看到
- 范围：将当前「指名客户管理→告警提醒」tab 内的两类告警数据（🔴应访未访 / 🟠长期失联）抽为**复用渲染纯函数**，在两个新位置展示
- 流程：brainstorming（形态=B 综合方案 ✅）→ 本文档 → 用户审查 → writing-plans → 实施

---

## §0 决策记录

| 问点 | 用户选择 | 落点 |
|---|---|---|
| 复用形态 | B. 工作台 KPI 摘要 + 客户跟踪页完整表 | §2 / §3 |
| 数据源 | 复用 `/api/board/named-account-manage`（既有端点，零新端点） | §1.1 |
| 工作台位置 | 首页 `/`（S02 schema 受控渲染的 index.html） | §2.1 |
| 客户跟踪位置 | `/named-accounts.html`（侧栏菜单"客户跟踪"入口） | §3.1 |
| 渲染函数落地 | `src/portal/followReminder.js`（浏览器+vitest 共用，零 DB） | §1.2 |
| 与侧栏角标关系 | 同源：KPI 卡数字 = 侧栏角标数字 = 页签 badge 数字（皆来自 `followReminders`） | §2.1 |
| 既有「指名客户管理」告警区 | 保留不变（多源可访问；移除会产生回退） | §3.3 |

---

## §1 共享层

### §1.1 数据契约（既有，无改动）

`GET /api/board/named-account-manage?owner=` 响应顶层（2026-08-31 Task2 扩展后）：

| 字段 | 用途 |
|---|---|
| `rows[]` | 含 `alert`/`overdueDays`/`visitDue`/`lostContact`/`lastContactDays` |
| `followReminders` | 逾期红 ∪ 失联去重计数（KPI 顶端数字） |
| `lostContactCount` | 失联计数 |

**KPI 卡派生字段**（前端计算，不新增端点字段）：
- `redCount` = `rows.filter(r=>r.alert==='red').length`
- `maxOverdueDays` = `Math.max(0, ...rows.filter(r=>r.alert==='red').map(r=>r.overdueDays||0))`

### §1.2 复用渲染纯函数（新增 `src/portal/followReminder.js`）

浏览器 + vitest 共用，零 DB、零服务端 import（与 `alertRuleConfigRender.js` 同源范式）。

```js
// KPI 摘要卡（4 张）：应访未访 / 失联 / 最近逾期天数 / 查看完整告警
// 语义：仅在数字 >0 时染色 + 跳链；0/无数据时退化为"达标"色
export function renderFollowKpis({ rows, followReminders, lostContactCount }) → string

// 完整告警表格（两类子表：🔴应访未访 / 🟠长期失联）
// 语义：复用 Task4 renderAlerts 形态（去重：既逾期又失联只进红）
export function renderFollowTable(rows) → string

// HTML 转义工具（内联，避外部依赖）
function esc(s) { ... }
```

---

## §2 工作台（`/`）集成

### §2.1 落点：S02 schema 受控渲染的「客户跟踪」业务区

S02 schema（`src/pages/S02.schema.js`）已含"客户跟踪"业务区（合并 `named-accounts.html` 内容——早晨 working memory "门户首页作战室 = 首页 /"）。
**集成方式**：在 S02 schema 的"客户跟踪"业务区**最前**嵌入 `<div id="follow-kpi-mount"></div>`，schema 渲染后由 `index.html` 页面脚本 `mountFollowKpis(j)` 调用 `renderFollowKpis` 填充内容。

```html
<!-- S02 schema 片段（伪代码示意） -->
<section class="follow-kpi-host">
  <div id="follow-kpi-mount"></div>
  <a class="muted" href="/named-accounts.html">查看完整告警 →</a>
</section>
```

### §2.2 4 张 KPI 卡设计

| 卡 | 数据 | 0 时 | >0 时 |
|---|---|---|---|
| 🔴 应访未访 | `redCount` | 灰色达标 | 红色 + 跳指名客户管理 |
| 🟠 长期失联 | `lostContactCount` | 灰色 | 橙色 + 跳指名客户管理 |
| ⏰ 最近逾期 | `maxOverdueDays + "天"` | 灰色"无" | 红色 + 跳客户名 |
| 📋 查看完整 | 跳链接（恒存在） | 链接 | 链接 |

色值走 `--err`/`--warn`/`--ok` 语义变量（零硬编码铁律）。

### §2.3 数据加载

`index.html` 页面脚本启动后：
```js
const j = await api('/api/board/named-account-manage');
document.getElementById('follow-kpi-mount').innerHTML = renderFollowKpis(j);
```

失败/未登录静默：mount 留空（不破坏 S02 既有内容）。

---

## §3 客户跟踪页（`/named-accounts.html`）集成

### §3.1 落点：页面顶部、横幅之下、Tab 导航之上

当前页面结构：page-head → banner → nav.tabs → panels。
**集成方式**：在 `banner` 之后、`nav.tabs` 之前插入 `<section id="follow-table-host"></section>`，由页面脚本 `mountFollowTable(j)` 填充。

```html
<div class="banner" id="banner"></div>
<section id="follow-table-host" class="follow-host"></section>  <!-- 新增 -->
<nav class="tabs">...</nav>
```

### §3.2 复用原则

- **不重复渲染**：页面原本的「🔔 告警提醒」tab 内的 renderAlerts 保留（用户仍可从 tab 入口查看）；新插入的"工作台区"提供**顶部快速入口**
- **同一数据源**：页面脚本只 fetch 一次 `/api/board/named-account-manage`（load 函数已存在），同时填充 KPI mount + 顶部表格 mount + Tab 内的 renderAlerts

### §3.3 与既有「告警提醒」tab 的关系

| 入口 | 形态 | 角色 |
|---|---|---|
| 页面顶部（新增） | 完整告警表格 | 概览+操作（无须切 tab） |
| 「🔔 告警提醒」tab（保留） | 同上 | 详细分析（与「名单总览」「分配管理」并列） |

**两处展示同一表格的合理之处**：用户在 tab 上下文里已经聚焦"告警"主题，期望看到完整列表；顶部嵌入让"我先看一眼"的用户无须切 tab。移除 tab 是回退风险（用户已习惯），故保留。

---

## §4 文件变更清单

| 文件 | 变更 |
|---|---|
| `src/portal/followReminder.js` (**新建**) | `renderFollowKpis` / `renderFollowTable` 纯函数；零 DB、零服务端 import |
| `src/http/routes.js` (**修改**) | 静态映射 `/portal/followReminder.js`（`Content-Type: text/javascript`），对齐既有 `alertRuleConfigRender.js` 范式 |
| `src/pages/S02.schema.js` (**修改**) | 客户跟踪业务区最前追加 `<div id="follow-kpi-mount"></div>` + "查看完整"链接 |
| `src/web/index.html` (**修改**) | 页面脚本在 load 后调 `mountFollowKpis(j)` 填充；导入 `followReminderRender` 等价（路径：`/portal/followReminder.js`） |
| `src/web/named-accounts.html` (**修改**) | banner 后追加 `<section id="follow-table-host">` + `mountFollowTable(j)` 调用 |
| `test/portal/follow-reminder.test.js` (**新建**) | 纯函数测试：KPI 4 卡渲染、表格两类去重、零数据退化为达标色、HTML 转义 |
| `test/http/follow-reminder-mount.test.js` (**新建**) | 静态资源路由 200 + 跨页契约（KPI mount id / follow-table-host id 存在） |

---

## §5 风险与边界

1. **S02 schema 兼容性**：`S02.schema.js` 修改必须保持既有渲染契约——`renderHomePage` 行为不回归（既有 home-page.test.js 全绿作守门）
2. **数据流时序**：`index.html` 的 mount 必须在 `injectLayout()` 之后调用（DOM 节点已就绪）
3. **客户跟踪页 mount 与 Tab 同步**：Tab 内的 renderAlerts 与 mount 的 renderFollowTable 数据应一致——通过单一 `currentRows` 引用保证（页面 load 函数已用此模式）
4. **rows 累积与去重**：HTTP 测试 `beforeEach` 累积数据会污染 `maxOverdueDays`——纯函数测试用「提供 rows」而非「拉数据」，避免依赖
5. **路由注册**：`routes.js` 改动新增 `/portal/followReminder.js` 静态映射 → 需 server 重启（与 08-31 上午同一坑）

---

## §6 验收标准

| 检查项 | 期望 |
|---|---|
| 首页 `/` 加载后，「客户跟踪」业务区顶部 | 4 张 KPI 卡正确渲染（数据 = followReminders/lostContactCount/redCount/maxOverdueDays） |
| 跳链接 | KPI 卡的"查看完整"链向 `/named-accounts.html`；红/橙卡可点跳 |
| 客户跟踪页 `/named-accounts.html` 加载后，banner 之下 | 完整告警表格（🔴 + 🟠 两类） |
| 「🔔 告警提醒」tab 行为 | 不变（既有契约保持） |
| 纯函数单测 | `follow-reminder.test.js` 全绿（KPI/表格/边界/转义） |
| 路由可达 | `GET /portal/followReminder.js` 200 |
| 视觉一致性 | 工作台深色主题 + tokens 语义变量（零硬编码色值铁律） |
| 全量回归 | 与本计划相关文件不引入新失败（单独文件 ≥ baseline） |
