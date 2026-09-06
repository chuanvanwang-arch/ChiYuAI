# CRM 销售智能工作台 · Buddy 应用设计文档

> 状态：已批准（2026-09-05）· 模式：复用优先，零新建业务逻辑
> 参考：腾讯电子签 AI 合同助手（顶部 Tab + 二级功能胶囊 + 对话区）
> Buddy 规范：https://open.workbuddy.cn/docs/buddy-app

## 一、应用定位

| 项 | 内容 |
|---|---|
| 应用名称 | CRM 销售智能工作台 |
| 定位 | AI 原生销售管理垂直行业 Harness（对标腾讯电子签 AI 合同助手） |
| 目标用户 | 全角色：销售一线 / 销售管理 / 平台治理 |
| 交付形态 | ① 开放平台配置 JSON（可本地预览）② 门户外壳 HTML（6 Tab + 胶囊 + 对话区）经 MCP App 内嵌 ③ 素材包 |
| 核心约束 | **复用优先，禁止重复造轮子**——所有页面/Skill/专家/连接器/组件一律复用现有资产 |

## 二、已核实可复用资产（非假设）

- **UI 组件库**：`src/web/components.js` + `src/web/tokens.css` + `src/web/common.css` ✓
- **70+ 现有页面**（直接 iframe 复用）：`account-360.html`、`named-accounts.html`、`named-account-targets.html`、`pipeline.html`、`kanban.html`、`deal-detail.html`、`funnel-quality.html`、`quotation-detail.html`、`offer-policy.html`、`price-list.html`、`product-catalog.html`、`approval-flow.html`、`decision-graph.html`、`decision-thinking.html`、`approval-config.html`、`sales-decision-monitor.html`、`business-board.html`、`seven-dim.html`、`agent-dashboard.html`、`rbac.html`、`billing.html`、`skill-registry-board.html`、`tenant-management.html` 等
- **对话区**：`agent-workbench.html`（加载 `/api/page/agent-workbench`，SSE 实时）✓
- **后端/工具**：`crm-native` MCP（localhost:3001/mcp，StreamableHTTP 双通道）✓
- **能力**：17 个 `method-*` / `crm-*` Skill、CRM 决策专家、DSM 销售方法论专家、完整 Action Registry ✓

## 三、六大维度 → 现有资产映射

| 维度 | 复用来源（不新建） |
|---|---|
| 工作模式 | System Prompt 复用既有 `crm-native` 角色定义；预绑定 Skill = `crm-native` / `crm-query` / `crm-risk`（已有） |
| 场景胶囊 | 每个胶囊 = 一个现有 Action（如 `crm-account-360`、`crm-approval-start`），直接引用 |
| 模型 | 平台模型池默认模型，仅勾选排序 |
| 垂直市场 | 专家 = `CRM 决策专家` / `DSM 销售方法论专家`（已有）；Skill = 现有 17 个；连接器 = `crm-native MCP`（已有） |
| 内嵌功能 | MCP App 接入 `crm-native` 后端（已有双通道） |

## 四、6-Tab → 现有页面 iframe 复用

| 主 Tab | 复用现有页面（iframe） |
|---|---|
| 客户洞察 | `account-360.html`、`named-accounts.html`、`named-account-targets.html` |
| 商机推进 | `pipeline.html`、`kanban.html`、`deal-detail.html`、`funnel-quality.html` |
| 报价折扣 | `quotation-detail.html`、`offer-policy.html`、`price-list.html`、`product-catalog.html` |
| 决策审批 | `approval-flow.html`、`decision-graph.html`、`decision-thinking.html`、`approval-config.html` |
| 业绩治理 | `sales-decision-monitor.html`、`business-board.html`、`seven-dim.html`、`agent-dashboard.html` |
| 平台管理 | `rbac.html`、`billing.html`、`skill-registry-board.html`、`tenant-management.html` |

## 五、唯一新增（3 个文件，零业务逻辑）

1. **门户外壳** `src/web/buddy-crm-portal.html`：复用 `components.js/tokens.css/common.css`，含 6 Tab 导航 + iframe 容器（切换加载 §4 页面）+ 底部对话区（iframe 嵌入 `agent-workbench.html`）。优先评估复用现有 `landing.html` / `home.html`，不满足才新建。须遵守 `docs/specs/2026-09-05-ui-authoring-rules.md` 并用 `scripts/new-page.mjs` 脚手架生成。
2. **Buddy manifest** `buddy-crm-manifest.json`：开放平台 5 模块配置，全部引用现有专家/Skill/连接器/页面。
3. **素材**：16px SVG icon（`assets/app-icon.svg`）+ 1000×910 日夜背景图（CSS 渐变占位版 `assets/hero-day.svg` / `hero-night.svg`）。

## 六、生命契约（§A 双轨）

```contract-yaml
- task: "构建门户外壳（复用现有组件与页面）"
  agent: crm-native
  skills: [crm-native]
  memory: [crm-copilot]
  success: "buddy-crm-portal.html 打开展示 6 Tab，Tab 切换 iframe 到对应现有页，底部对话区 iframe 复用 agent-workbench.html；新建文件 0 业务逻辑、UI 100% 复用 components.js/tokens.css/common.css"

- task: "导出 Buddy manifest（全量复用现有资产）"
  agent: crm-native
  skills: [crm-native]
  memory: [crm-copilot]
  success: "buddy-crm-manifest.json 含 5 模块，市场/工作模式/胶囊全部引用现有关联器(crm-native MCP)/Skill(≥5)/专家(≥2)，无新建能力"

- task: "生成规范素材"
  agent: crm-native
  skills: [crm-native]
  memory: [crm-copilot]
  success: "产出 16px SVG icon 与 1000×910 日夜背景图(渐变占位)，符合 buddy-app 设计规范"
```

**契约说明**：① 门户外壳由 `crm-native` 承接，复用组件库与现有页面，成功标准为 6 Tab + 对话区 iframe 复用且零新业务逻辑；② manifest 由 `crm-native` 承接，全量引用现有资产，成功标准为 5 模块完整且无新建能力；③ 素材由 `crm-native` 承接，成功标准为 icon/背景图尺寸符合规范。

## 七、闭环回写（§B）

| 任务 | 缺口类型 | 观测 | 期望 | 严重度 | 状态 |
|---|---|---|---|---|---|
| （待实现后由 workbench 回填） | — | — | — | — | 空 |

## 八、发布流程

```
创建应用填基础信息 → 平台审核 → 导入 buddy-crm-manifest.json 草稿 → 内嵌门户外壳(MCP App) → 预览调试 → 提交审核 → 发布
```

## 实现注意点
- 门户外壳页面必须遵守 `docs/specs/2026-09-05-ui-authoring-rules.md`（head 三件套、title 禁 emoji、控件 `crm-*`、本地 style 不重声明保留类），并用 `scripts/new-page.mjs` 脚手架生成以免踩 lint。
- 对话区 iframe 复用 `agent-workbench.html`，按当前 Tab 通过 URL query 注入场景上下文（如 `?mode=客户洞察`）。
- manifest 的胶囊 action 字段必须精确对应现有 Action Registry 名称（见 `src/action/seed-actions.js`）。
