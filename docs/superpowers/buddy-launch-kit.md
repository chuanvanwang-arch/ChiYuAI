# CRM 销售智能工作台 · Buddy 应用上架审核材料

> 对标：腾讯电子签 AI 合同助手（顶部主 Tab + 二级功能胶囊 + 对话区）
> 形态：标准 Buddy 配置 + 自建 H5 门户外壳（经 MCP App 内嵌）
> 原则：**复用优先，零新增业务逻辑** —— 全部能力来自 CRM-ai-native 平台既有资产

---

## 一、应用定位

| 项 | 内容 |
|---|---|
| 应用名称 | CRM 销售智能工作台 |
| 一句话简介 | AI 原生销售管理垂直行业 Harness，覆盖销售一线 / 销售管理 / 平台治理全角色 |
| 目标用户 | 销售代表、销售管理者、平台 / 租户管理员 |
| 交付形态 | ① Buddy manifest（开放平台 5 模块配置）② H5 门户外壳（5/6 Tab + 胶囊 + 对话区，财务 Tab 仅 finance 可见，经 MCP App 内嵌）③ 应用 icon / 背景图素材 |
| 差异化 | 报价必须走 `CRM_APPROVAL_FLOW`、写操作走决策第 0 闸（零信任 HITL） |

---

## 二、六大维度 → 现有资产映射（审核要点）

### ① 工作模式
- **System Prompt**：`你是 CRM 销售智能工作台 AI，遵循 DSM 销售方法论与 K-M-D 决策架构；写操作必须走确认/审批闸门；报价必须走 CRM_APPROVAL_FLOW。`
- **预绑定 Skill**：`crm-native` / `crm-query` / `crm-risk`（覆盖全部对话，均为既有 Skill）

### ② 场景胶囊（5/6 主 Tab × 4 胶囊；财务 Tab 仅 finance 角色可见，点击注入对话区预设 prompt）
| 主 Tab | 场景胶囊（绑定 Skill / Action，均复用现有） |
|---|---|
| 客户洞察 | 360 视图 / 重点客户 / 客户拜访 / 客户任务线 |
| 商机推进 | 管道看板 / 阶段评估 / 漏斗分类 / 商机复盘 |
| 报价折扣 | 报价生成 / 折扣策略 / 价目表 / 折扣审批 |
| 决策审批 | 审批流 / 复核闸门 / 决策追溯 / 根因分析 |
| 业绩治理 | 销售监控 / 决策监控 / 校准指标 / 团队看板 |
| 财务（仅 finance） | 回款计划 / 回款登记 / 发票管理 / 财务应收看板 |

**精确绑定机制**：胶囊携带 `skillSlug` + `targetAgent`，经对话区 `POST /api/agent/dispatch` 透传 → `routeThroughIntake`（`src/kanban/scheduler.js:79`）仅保留「落在目标 agent 的 `skillCalls` 闭包内」的 skill_slug，实现确定性路由到具体 `method-*` Skill。

### ③ 模型配置
- 默认推理模型（跟随平台模型池，如 `deepseek-v3.1`），仅勾选排序，不写死。

### ④ 垂直行业市场
- **专家（≥2）**：`CRM 决策专家` / `DSM 销售方法论专家`（既有）
- **Skill（≥5）**：17 个 `method-*` / `crm-*` 子集（既有）
- **连接器（≥1）**：`crm-native MCP`（StreamableHTTP，本项目 `localhost:3001/mcp`，生产替换为公网地址）

### ⑤ 内嵌功能
- MCP App 接入 `crm-native` 后端（既有双通道：3001/mcp + 3010 agent2b 旁挂）

---

## 三、门户外壳（H5 首页）能力截图说明

| 截图区域 | 内容说明 |
|---|---|
| 顶部标题栏 | 应用名「CRM 销售智能工作台」+ 主 Tab 切换（客户洞察 / 商机推进 / 报价折扣 / 决策审批 / 业绩治理 / 财务）；财务 Tab 经 `/api/auth/me` 角色闸门仅 finance/admin/sysadmin 可见（未登录隐藏） |
| 中部胶囊区 | 当前 Tab 的 4 个场景胶囊卡片；点击 → 预设 prompt 注入底部对话区输入框（**不自动发送，保留人工确认闸门**） |
| 业务视图（参考面板） | 每个 Tab 对应现有页面经 iframe 复用：如客户洞察→`account-360.html`、商机推进→`pipeline.html`、报价折扣→`quotation-detail.html`、决策审批→`approval-flow.html`、业绩治理→`sales-decision-monitor.html`、财务→`finance-receivables.html` |
| 底部对话区 | iframe 复用 `agent-workbench.html`，接收胶囊注入的 `skillSlug`/`targetAgent` 并随派发请求透传 |

**UI 规范合规**：UI 100% 复用 `/portal` 设计系统（`components.js` / `tokens.css` / `common.css`），通过 `ui-lint` 校验（77 文件无架构级违规）。

---

## 四、零信任与治理（审核红线）

1. **胶囊注入不自动发送**：仅预填对话区输入框，须用户确认后发送。
1b. **未登录引导（非硬墙）**：门户未登录时在含写类胶囊的 Tab 注入「请先登录/注册」提示（`buddy-crm-portal.html:applyLoginHint`）；写操作提交若 401，对话区结果框引导 `/home.html` 登录、`/landing.html#start` 注册（`agent-workbench.html` dispatch 401 分支）——**不设硬登录墙、不弹窗**，保持「先浏览后验证」的 Buddy 体验，实际写操作仍以 401 拦截兜底。
2. **写操作决策第 0 闸**：写类 MCP 工具（如 `crm-asset-attach`）触发 `DECISION_NEEDED`，须经决策/审批流（已真机验证）。
3. **重大商机闸门**：`routes.dispatch` 保留 `classifyRequirement` 的 intent/level，重大商机强制 `review-gate`。
4. **报价红线**：系统无报价基线 + 折扣超权限时，必须走 `CRM_APPROVAL_FLOW` + `decision_id`（参照 B 新能源口头预算教训）。
5. **多租户隔离**：`tenant_id` 全程透传（system 租户豁免）；平台管理类动作仅 sysadmin 角色。
6. **财务 Tab 角色闸门**：财务 Tab 经 `/api/auth/me` 按角色隐藏（仅 finance/admin/sysadmin 可见），写操作仍以 `requiresEntitlement(advanced_reporting)` 等下游闸门兜底（防御纵深）。

---

## 五、发布检查表（审核前自检）

- [ ] 应用名 / icon（`assets/app-icon.svg`，16px / 线宽 1.2 / 圆角 100%）/ 背景图（`assets/hero-day.svg` + `hero-night.svg`，1000×910 日/夜）就绪
- [ ] `buddy-crm-manifest.json` 含 5 模块：应用信息 / 工作模式 / 场景胶囊(5×4+财务 4，财务仅 finance 可见) / 垂直市场 / 模型；`market.connectors` 指向生产 crm-native MCP 地址
- [ ] 门户外壳 `buddy-crm-portal.html` 经 MCP App 内嵌；Tab 切换 + 胶囊注入对话区已联调（财务 Tab 角色闸门 + 未登录登录引导已验证）
- [ ] 全部 iframe 目标页在生产环境 `/portal/` 下可达
- [ ] `agent-workbench.html:314` 注入监听已部署（胶囊点击 → 对话区预填）
- [ ] 运行态验证：`npm run mcp` → `npm run buddy:e2e` 三层全绿（静态契约 + MCP 真机派发 + HTTP→DB 透传）
- [ ] 零信任五项（§四）经真机验证无误
- [ ] 开放平台预览 → 提交审核 → 发布

---

## 六、验证套件（CI / 本地复现）

| 脚本 | 层 | 用途 |
|---|---|---|
| `scripts/buddy-capsule-binding-check.mjs` | 静态契约 | 断言 24 胶囊→method-* 映射确定性保留且工具名在 MCP 暴露集（零依赖，CI 必跑） |
| `scripts/buddy-e2e-probe.mjs` | 运行态 MCP | `crm_login` + 真机 `callTool(method-funnel-classification)` 返回真实结果 |
| `scripts/buddy-dispatch-e2e.mjs` | HTTP→DB | 登录 → dispatch 透传 skillSlug/targetAgent → `crm.tasks` 落库断言 |
| `scripts/buddy-e2e-suite.mjs` | 编排 | `npm run buddy:e2e` 串联三层并汇总 PASS/FAIL |
| `.github/workflows/buddy-static.yml` | CI 门禁 | push/PR 触发，零依赖，必绿 |
| `.github/workflows/buddy-e2e.yml` | CI 运行态回归 | `workflow_dispatch` 手动触发 + `schedule` 定时触发（**每日北京时间 02:00 / UTC 18:00 夜间自动回归**）；PG 容器 + 全栈 bootstrap，跑三层套件并上传回归日志制品（保留 7 天） |
| `scripts/buddy-ui-e2e.mjs` | 浏览器 UI 回归（Playwright） | 5/6 Tab 渲染（财务角色闸门）+ 20/24 胶囊「点击→对话区注入预填」+ 单点闭环（胶囊→提交→dispatch→DB skill_slug 保留）+ 登录引导（未登录跳转登录页、写类胶囊 Tab 显示登录提示）；本地 `npm run buddy:ui-e2e`，CI `.github/workflows/buddy-ui-e2e.yml`（手动触发，装 Chromium） |
| `.github/workflows/buddy-ui-e2e.yml` | CI 浏览器回归 | `workflow_dispatch` 手动触发；pgvector 容器 + 安装 Playwright Chromium + 全栈 bootstrap + 跑浏览器 UI 回归 |

> **门户路由（2026-09-05 补齐）**：Buddy 门户外壳由后端 `app.get(/^\/portal\/([\w-]+)\.html$/)` 静态映射 `src/web`，访问路径 `/portal/buddy-crm-portal.html`（别名 `/buddy`）；iframe 复用 `/portal/agent-workbench.html` 与 `/portal/account-360.html`。此前这两类路径 404，门户实际不可达——现已接通并经 UI E2E 验证。

```powershell
# 本地复现
cd D:\system\CRM-ai-native
npm run mcp                      # 起 MCP（若未起）
npm run buddy:e2e               # 三层真机/静态验证
npm run buddy:ui-e2e            # 浏览器 UI 回归（需先 npm install playwright + npx playwright install chromium）
```
