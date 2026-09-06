# UI 统一 + 导航收敛 + 编码规范 设计（6 项全员菜单 + 系统组 2 项 admin 独享 · 全深色 · 主色 #6366f1）

- 日期：2026-08-27
- 状态：已获用户逐项确认（左侧导航 / 全深色 / 31 页全刷 / 6 项菜单 / 主色 #6366f1 / 配置中心 3 组）
- 范围：src/web 全部 31 页 + src/portal 配置中心（含 RBAC 过滤） + src/page/pageStore.js + src/particles/particleRepo.js + src/action/seed-actions.js + src/http/routes.js
- 前置依据：docs/2026-08-27-system-diag-report.md（P1–P6 证据链）
- 性质：设计文档（brainstorming 产物）；未动实现代码，实施走 writing-plans

---

## §1 导航体系（C 档极简 6 项，左侧导航 + 顶栏全局）

### 1.1 顶栏（全局固定，所有页面一致）
- 左：`⚡ CRM 作战室`（品牌，点击回首页工作台）
- 中：命令栏 `⌘K`（NL 入口，复用 index.html copilot 能力）
- 右：**头像（身份入口）** —— 显示姓名首字圆形头像（角色着色徽标）；点击弹出**用户小菜单**（见 §1.5）

### 1.2 左侧导航（6 项，分组标签 + 子项）

| 分组 | 菜单 | 子项/承载 | 来源收敛 |
|---|---|---|---|
| 销售 | 线索·商机 | 管道 6 列 + 速览 | 线索池 + pipeline + L2C 看板合并（nav.js:6；page-market.html:41 错指 /kanban.html 一并修正） |
| 销售 | 客户 360 | 客户详情 + 决策网络出边 | account-360（保留独立详情页） |
| 协同 | 审批 | 审批工作台 | workbench.html（HITL 四域） |
| 协同 | 待办 | 待办工作台 | todo.html |
| 洞察 | 决策网络 | 决策图 + 场景配置入口 | decision-graph + decision-scenarios（场景配置并入页内 Tabs） |
| 洞察 | 报告 | 销售决策监控报告 | sales-decision-monitor |
| 系统 | 配置中心 | 3 组 Tab（见 §1.4） | users/rbac/business-tier/approval-flow/alert-rules/mcp-identities/config/decision-scenarios/page-market/particle-detail 全部并入 |
| 系统 | 智能体中心 | 工作台 + 监控 + 任务执行 3 视图 | agent-workbench + agents + agent-dashboard + kanban 合并 |

> **RBAC**：「系统」分组（配置中心 / 智能体中心）仅 `admin` 角色可见可入；非 admin（sales/manager/presales/contract_admin/finance）左侧菜单不渲染「系统」分组，页面路由层二次拦截（403），命令栏 ⌘K 亦不返回系统页。

**不占菜单**：首页工作台（登录默认落地页：今日优先/L2C/审批收件箱/命令栏）= index.html；5 个业务详情页（deal/quotation/contract/order/payment-detail）从商机列表点击进入；portal-stage3-mockup 归档为页面资产原型；meta-attr-drawer 为抽屉组件。

### 1.3 菜单可发现性与可见性（RBAC）
- 顶栏 ⌘K 命令栏为全局第二入口（导航兜底）；但系统页仅 admin 可搜到/可达
- 配置中心 3 组页面内用左侧次级 Tabs（继承原系统分组）
- 「系统」分组（配置中心 / 智能体中心）仅 `admin` 可见：layout.js 依据 `/api/auth/me` 角色过滤；非 admin 直访系统页路由守卫返回 403 并跳回首页

### 1.5 头像用户小菜单（点击顶栏头像弹出）
| 项 | 目标 | 可见性 |
|---|---|---|
| 我的审批 | workbench.html（审批工作台） | 全员 |
| 我的任务 | todo.html（待办工作台） | 全员 |
| 工作台 | index.html（首页工作台） | 全员 |
| ───────── | | |
| 配置中心 | 配置中心（3 组 Tab） | 仅 admin |
| 智能体中心 | 智能体中心（3 视图） | 仅 admin |
| ───────── | | |
| 退出登录 | 清 token → home.html | 全员 |

- 头像显示 `display_name` 首字圆形（角色着色）；菜单为独立浮层（点击外部关闭）。
- RBAC 与左侧「系统」分组一致：非 admin 只显示前三项+退出，不渲染配置中心/智能体中心两项。

### 1.4 配置中心 3 组（9 项 → 3 组 Tab）

| 组 | 承载项 | 来源 |
|---|---|---|
| 系统设置 | LLM/七维配置（config.html） + 用户管理（users.html） + RBAC（rbac.html） | 基础运行面 |
| 业务规则 | 业务分级（business-tier.html） + 审批流（approval-flow.html） + 预警规则（alert-rules.html） | 销售运营规则 |
| 集成与资产 | MCP 身份（mcp-identities.html） + 决策场景（decision-scenarios.html） + 页面资产（page-market.html） + 粒子详情（particle-detail.html） | 连接器/受控面/数据探查 |

---

## §2 视觉规范（全深色专业风，tokens.css 单源）

### 2.1 tokens.css（新建 src/web/tokens.css）

```css
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

- 主色：`--ac:#6366f1`（用户指定）+ hover 亮化 `#818cf8`；禁止页面散用其它紫/蓝。
- 头像：`--ac` 底、白字首字圆形；角色徽标按六色（sales/manager/presales/contract_admin/finance/admin）。
- 全站深色：内容区 `--bg:#0f172a`、面板 `--panel:#1e293b`、文本 `--ink/--mut`。
- 语义色：成功 `--ok` / 错误 `--err` / 预警 `--warn` 统一。
- 字体/圆角/间距/阴影 统一 4 变量。

### 2.2 common.css（新建 src/web/common.css）
统一公共组件：`.btn/.btn.primary/.btn.ghost/.btn.danger`、`.card/.panel`、`.table/.tbl`、`.form/.field`、`.badge/.tag`、`.empty/.error`、`.filter/.chips`、`.toast`、`.sidebar/.nav/.topbar`、`.tabs`、`.kbd`、`.cmdbar`。

### 2.3 layout.js（新建 src/web/layout.js）
- 统一注入：顶栏（品牌/⌘K/身份/退出）+ 左侧 6 项导航（当前高亮）+ 页面容器骨架。
- 配置中心页注入 3 组次级 Tabs；智能体中心页注入 3 视图切换。
- 取代全部散落手写侧栏（index.html:52-62 / page-market.html:38-46 / portal-stage3:83-98）与 nav.js 注入（nav.js:31-36）；meta-attr-drawer 双导航收敛为仅布局注入。

### 2.4 全局替换清单（31 页）
- 每页 `<head>` 引入 `tokens.css` + `common.css`（移除各自内嵌 `<style>` 重复定义）。
- 每页 body 注入 `layout.js`（移除 nav.js 或手写侧栏）。
- 命令栏/身份/退出全站统一由 layout.js 提供（删各页零星实现）。

---

## §3 编码规范（落地为 docs/2026-08-27-frontend-coding-standards.md）

1. **数据读取**：统一 `api.js` 封装（自动 Authorization 头、JSON、401 跳登录、错误兜底）；页面只调 `api.get/post`，读直连不经第 0 闸；禁散乱裸 fetch。
2. **按钮定义**：唯一 `.btn/.btn.primary/.btn.ghost/.btn.danger` + loading/disabled 态；文案业务化（「创建商机」而非 action 名）。
3. **字段规范**：
   - `payload.stage` 六段枚举白名单：`lead / opportunity / quoted / contracted / ordered / paid`，拒绝 `leads` 类脏值；未知值渲染为「未分类」兜底列，不静默丢弃。
   - `state` = 粒子生命周期（ACTIVE 等），与业务 `stage` 严格分离；禁止把 stage 写进 state。
   - payload 字段驼峰命名；金额 NUMBER、日期 ISO8601；统一 `esc()` 防注入。
4. **新增真实写通道**（终结空壳新增）：新增 `POST /api/particles`（经 executor 第 0 闸 `requireDecision`）+ 前端「＋新建」按钮 → 确认 → 提交 → 刷新；userManagement 等配置写统一前置 `requireDecision`（对齐 §5 证据）。
5. **错误处理**：统一 toast 提示条，禁裸 `alert()`。
6. **RBAC 守卫**：路由层对系统页（配置中心/智能体中心）做角色校验，仅 admin 可见可入，非 admin 直访 403 并跳回首页；layout.js 菜单渲染按 `/api/auth/me` 角色过滤「系统」分组；⌘K 命令栏对非 admin 隐藏系统页条目。

---

## §4 分批刷新与回归（5 批，每批一 commit）

| 批 | 内容 | 验收 |
|---|---|---|
| 1 | 基建：tokens.css + common.css + layout.js + api.js（新文件，不动页面） | 无回归 |
| 2 | 业务页：index / pipeline / account-360 + 5 详情页 | 深色 + 左栏 + 可新增 |
| 3 | 协作页：workbench / todo / kanban | |
| 4 | 决策页：decision-graph / decision-scenarios / sales-decision-monitor | |
| 5 | 智能体+管理页：agent-workbench / agents(合并监控) / 管理 3 组 / page-market / particle-detail / portal-stage3 收敛 | |

每批后冒烟：菜单可达性遍历（31 页无孤儿）+ 数据加载 + 新增端到端。收尾全量 vitest（398 基线）+ 页面实测。

---

## §5 验收口径

- **可发现性**：任意页面 2 次点击内可达任意一级菜单；顶栏 ⌘K 可达任意页面（系统组仅 admin 可搜达）。
- **RBAC**：非 admin 登录后左侧无「系统」分组；直访系统页被守卫拦为 403 并跳回首页。
- **一致性**：31 页同一深色主题 + 同一字体 + 同一按钮/表格/表单样式；无页面残留独立内嵌 CSS 主色。
- **收敛完成**：nav 22 项平铺 → 6 项左侧菜单 + 顶栏；配置中心 9 页 → 3 组 Tabs。
- **可新增**：业务页面有真实「＋新建」写通道，新增后 15s 内出现在列表。
- **规范可查**：docs/2026-08-27-frontend-coding-standards.md 落地并引用。