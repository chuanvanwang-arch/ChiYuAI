# 设计文档：CRM 平台前端风格统一（内容区组件化）

- **日期**：2026-08-29
- **决策**：方向 A（清爽分隔线页头）· 全量一次性铺开（50+ 页）
- **范围**：仅统一**内容区**页头/分区/tab 写法；顶栏（layout.js）+ 左侧导航 + tokens 不变（已统一）
- **风险等级**：中（纯前端 CSS/HTML，无 API/路由改动；单页可回退）

---

## 1. 诊断（现状冲突）

顶栏 + 侧栏已由 `src/web/layout.js` 注入、`common.css` 定义，主色 `#6366f1`、深色专业风，tokens 单源（`tokens.css`）。**不统一在内容区**：

| 冲突 | 现状证据 | 问题 |
|---|---|---|
| 页头写法三套 | `my-todo.html:34` 裸 `<h2>📋 我的待办</h2>`；`account-360.html:28` 内容区另造 `#topbar`（返回+下拉）；渲染器页输出 `.pg-page`（page.css） | 同一平台三种"头部血统" |
| Tab 三套写法 | `my-todo.html:11-13` 自定义 `.tab`（pill，覆盖 common.css 同名）；`account-360.html:17-19` `.tab` 上边框式；`sales-decision-monitor.html:129` 自创 `.page-tabs/.page-tab`（common.css 无此类） | 类名重复定义、视觉割裂 |
| 副标题间距不一 | 各页自定义 `.sub` margin 不同 | 视觉跳动 |
| CSS 链接契约不一 | 手写页仅链 `tokens+common`；渲染器页加 `page.css` | 两套体系割裂 |

---

## 2. 统一设计系统（单一事实源）

### 2.1 新增内容区组件 → `src/web/common.css`

复用现有 tokens，新增以下类（**方向 A**：页头底部分隔线）：

```css
/* ── 内容区统一页头（风格统一专项 2026-08-29） ── */
.page-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;
  padding:16px 20px;border-bottom:1px solid var(--line);margin-bottom:18px}
.page-head .ph-main{min-width:0}
.page-head .back{display:inline-block;font-size:13px;color:var(--mut);text-decoration:none;margin-bottom:6px}
.page-head .back:hover{color:var(--ac)}
.page-title{font-size:19px;font-weight:700;margin:0;line-height:1.3}
.page-sub{font-size:13px;color:var(--mut);margin:4px 0 0}
.page-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.page-actions>*{border:1px solid var(--line);background:var(--panel);color:var(--ink);
  border-radius:8px;padding:7px 12px;font-size:13px}
.page-actions .btn.primary{background:var(--ac);border-color:var(--ac);color:var(--on-ac)}
/* 内容分区（替代裸 <h2> 段标题） */
.sect{margin-bottom:22px}
.sect-title{font-size:15px;font-weight:600;margin:0 0 12px;display:flex;align-items:center;gap:8px}
.sect-title::before{content:"";width:3px;height:14px;background:var(--ac);border-radius:2px;display:inline-block}
```

> **Tab 统一**：删除各页本地 `.tabs/.tab` 覆盖，统一使用 `common.css` 既有 `.tabs/.tab`（pill 样式）。上边框式（account-360）与自创 `.page-tab` 一律改为 `.tabs/.tab`。

### 2.2 链接契约（强制）

- 所有内容页 `<head>` 必须含：`<link rel="stylesheet" href="/portal/tokens.css">` + `<link rel="stylesheet" href="/portal/common.css">`
- 渲染器输出页（account-360 / account-insight / business-closure / deal-detail 等受控页）额外含 `<link rel="stylesheet" href="/portal/page.css">`
- 缺链的补齐；重复链的去重。

### 2.3 标记范式（每页内容区开头）

```html
<header class="page-head">
  <div class="ph-main">
    <a class="back" href="/">← 返回</a>            <!-- 可选 -->
    <h1 class="page-title">页面标题</h1>
    <p class="page-sub">副标题 / 说明</p>           <!-- 可选 -->
  </div>
  <div class="page-actions">                        <!-- 可选：下拉/按钮 -->
    <select>…</select><button class="btn primary">新建</button>
  </div>
</header>
<!-- 内部分组用 .sect > .sect-title；tab 用 .tabs > .tab -->
```

---

## 3. 迁移规则（按页面类型）

| 类型 | 代表页 | 处理 |
|---|---|---|
| 裸 `<h2>`+`.sub` 手写页 | my-todo, sales-decision-monitor, index, pipeline, business-board, decision-scenarios, seven-dim, config 等 | 包裹为 `.page-head`；`<h2>`→`.page-title`，`.sub`→`.page-sub`；tab 改 `.tabs/.tab` |
| 内容区自造 `#topbar` | account-360 | 删除 `#topbar`，返回/下拉收编进 `.page-head .back`/`.page-actions` |
| 渲染器受控页（`.pg-page`） | account-insight, account-360(画像区), business-closure, *-detail 系列 | 外层套 `.page-head`（标题/返回/actions）；内部 `.pg-*` 保持 page.css 不变 |
| 系统/管理页（users/rbac/agents…） | 共用 common.css，多已有标题 | 统一 `.page-head`；去除本地重复 `.tab` 覆盖 |

---

## 4. 执行顺序（全量）

1. `common.css` 注入 §2.1 组件（单文件，全局生效）。
2. 补齐/去重所有页 `<head>` 链接（§2.2）。
3. 按 §3 逐页改造页头标记（删除本地冲突 `.tab`/`.sub` 覆盖）。
4. 自测：选 3 类代表页（手写/自造顶栏/渲染器）在本地 server 刷新核对。

---

## 5. 风险与回退

- **低风险**：纯静态资源，无 DB/API 改动；`routes.js` 未动 → html 经 `sendFile` 实时读取，**无需重启 server**。
- **回退**：每页改造相互独立，单页 `git checkout` 即可回退；`common.css` 新增类不影响既有类（仅新增，不删改原规则）。
- **注意**：禁止删除 common.css 既有 `.tabs/.tab/.card` 等规则，仅新增 `.page-*`；避免破坏其它页面。

---

## 6. 验收口径

- 全站内容区页头视觉一致（同一 `.page-head` 结构、同一分隔线、同一 tab 样式）。
- 标题无 emoji 混用；副标题间距统一；tab 仅 `.tabs/.tab` 一套。
- 所有页正确链 tokens+common（+page.css 受控页）；无 404 样式。
- 顶栏/侧栏不变，功能（⌘K、头像菜单、RBAC 导航）不受影响。

---

## 7. 交付物

- `src/web/common.css`（新增 `.page-*` 组件）
- 全量 `src/web/*.html` 页头改造（按 §3）
- 不改动：`layout.js`、顶栏/侧栏、tokens.css、page.css、routes.js、任何后端
