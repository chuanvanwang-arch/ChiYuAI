# 配置中心 G1「平台与访问」新增项去重设计

- 日期：2026-09-04
- 状态：已批准（方案 A）
- 范围：配置中心 `平台与访问` 下「租户管理」(id40) / 「平台套餐管理」(id41) 两项接入方式
- 原则：**复用优先，不重复造轮子**——后续开发任务直接复用既有页面/后端/组件，而非另起平行实现

## 1. 背景：重复造轮子审计

2026-09-04 首轮实现中，为 G1 两项新建了 `tenant-management.html` 与 `platform-plan.html`，经审计发现与既有能力重叠：

| 拟新增条目 | 已存在的"轮子" | 重复度 |
|---|---|---|
| 平台套餐管理 (id41) | `admin-billing-console.html` 的「套餐管理」tab：`GET /api/billing/plans` + 整档 JSON 编辑/新增/软停用 | **100% 重复**（同一套逻辑的另一份实现） |
| 租户管理 (id40) | ① `admin-billing-console.html`「租户订阅」tab（只读订阅全景）；② `plugin-platform-admin/industry-onboarding` 智能体 Runbook（对话式新建行业租户，调 `POST /api/tenants`）；后端 `tenantRouter` 已就绪 | 新建页与 ② 在"新建租户"能力重叠 |

## 2. 设计方案（方案 A：全去重，零新页面）

两项均**深链到既有 `admin-billing-console.html`**，删除本轮新建的平行页面；新建租户仍走 `industry-onboarding` 智能体（平台治理 agent 化的既定定位）。

### 2.1 改动清单（5 处）

| # | 文件 | 改动 | 性质 |
|---|---|---|---|
| 1 | `src/portal/configCenter.js` | id41 `page`: `/platform-plan.html` → `/admin-billing-console.html#plans`；id40 `page`: `/tenant-management.html` → `/admin-billing-console.html#subs` | 去重 |
| 2 | `src/http/routes.js` | 删除本轮为两个新页加的 `sendFile` 路由（`/tenant-management.html`、`/platform-plan.html`） | 去重 |
| 3 | `src/web/admin-billing-console.html` | 加 ~6 行：读取 `location.hash`（`#plans/#subs/#settings`）在加载时 `showTab()` 定位初始 tab | 使深链生效 |
| 4 | `src/web/platform-plan.html` | **删除**（本轮新建的冗余页，= 套餐 tab 复刻） | 回收 |
| 5 | `src/web/tenant-management.html` | **删除**（本轮新建，与 industry-onboarding agent 新建能力重叠） | 回收 |

> 文件 4/5 是**本轮会话刚新建的冗余脚手架**，非用户数据/生产产物；删除属去重回收，不触碰"禁 DELETE"治理红线（该红线约束租户/用户/决策等业务数据）。

### 2.2 不去重的代价
- 双重事实源：`platform-plan.html` 与套餐 tab 各自维护 JSON 编辑/新增/软停用，逻辑漂移风险。
- 维护翻倍：套餐字段变更需同步两处。

## 3. 验证标准

- `config.html` 点击「平台套餐管理」「租户管理」分别直达 `admin-billing-console` 的 `#plans` / `#subs` tab。
- `node scripts/ui-lint.mjs`：删除两页后基线应 < 20 处警告，且无新增。
- `vitest configCenter.test.js`：14/14 全绿（id 数组仍含 40/41；若测试断言了 `page` 路径则同步更新）。
- `node --check` 校验 `routes.js` / `configCenter.js` / `admin-billing-console.html` 内联脚本。

## 4. §A 生命契约（双轨）

```contract-yaml
- task: "G1 两项去重（深链复用 admin-billing-console）"
  agent: crm-copilot
  skills: [writing-plans]
  memory: [crm-native]
  knowledge_scope: { layers: [L1], max_hops: 1 }
  success: "config.html 两项点击分别直达 admin-billing-console 的 #plans / #subs tab；platform-plan.html 与 tenant-management.html 已删除；ui-lint 无新增警告；configCenter 测试全绿"
```

**契约说明**：本去重任务由实现代理承接，须走 `writing-plans` 流程、读取 `crm-native` 项目记忆（L1，≤1 跳）；成功标准为深链生效 + 冗余页回收 + 校验全过。

## 5. 闭环回写

| 任务 | 智能体 | gap 类型 | 观测 | 期望 | 严重度 | 状态 |
|---|---|---|---|---|---|---|
| （待实施回填） | — | — | — | — | — | 待 P10 |

> P10 由 agent-workbench 运行时监控并回填 `*.feedback.json`；同 `(task, gap_type)` 复发 ≥2 次 → 产出 SKILL 改进提案（须用户批准）。
