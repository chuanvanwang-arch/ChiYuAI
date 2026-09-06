# 实施计划：业务分级配置端点 + 配置页（第 18 项）

> 日期：2026-08-27 | 基线：CRM-ai-native Stage 3 已收口（398/398 绿）
> 上游：配置中心统一入口 `/config` 已建（configCenter.js 第 18 卡标记为 pending / 后端缺端点）
> 设计：已审批（用户「好」）

## 1. 背景与缺口
- `business_tier_config` 表（`db/schema.sql:179`）已建：列 `dimension / dimension_value / tier`，复合 PK `(dimension, dimension_value)`；tier ∈ {LEAD, NORMAL, HIGH}。
- `decisionRepo.computeBusinessTier({customer, project})`（`src/decision/decisionRepo.js:16`）按 `dimension='customer'/'project'` 查两行、取两维 tier 的 MAX 秩（HIGH>NORMAL>LEAD），无配置回退 `scenario.default_tier`。该引擎是自主边界（§6 主轴）的驱动源。
- **缺口**：该表无种子、无端点；config 中心第 18 卡为 `pending / 后端缺端点`。本期补齐"配置可写"，引擎自动消费。

## 2. 架构决策（YAGNI）
- 不复用 `configRouter`（它服务于 `config_store` 键值表），新建**表驱动** `businessTierRouter`，复用其"可测试 handler + 决策第0闸"范式。
- 数据面纯新增端点；引擎零改动。
- 禁删红线：仅 GET/PUT（UPSERT），无 DELETE。

## 3. 后端端点（src/http/businessTierRouter.js）
```
GET  /api/business-tier-config  → { rows: [{dimension,dimension_value,tier}] }
PUT  /api/business-tier-config  → body {dimension,dimension_value,tier}
       · 校验：三字段必填；dimension∈{customer,project}；tier∈{LEAD,NORMAL,HIGH}
       · 第0闸：produceDecision('config-change',{dimension,dimension_value,tier})
       · UPSERT：INSERT ... ON CONFLICT(dimension,dimension_value) DO UPDATE SET tier=$3
       · 返回 { ok, row, decision }
router.handlers = { get, put }   // 注入式测试
```
默认 deps：`listTiers`（SELECT 全表）、`upsertTier`（UPSERT）、`produceDecision`（复用 requireDecision/recordDecisionEvent，降级不硬抛）。

## 4. 前端（src/web/business-tier.html + src/portal/businessTier.js）
- 渲染模块 `businessTier.js`：纯函数 `renderBusinessTier(rows)` + `tierRank(tier)` + `tierBadge(tier)`（HIGH 红 / NORMAL 黄 / LEAD 灰），浏览器与 vitest 共用。
- 页面：行表格（dimension / dimension_value / tier 徽标）+ 新增表单（dimension 下拉 customer|project · dimension_value 输入 · tier 下拉 LEAD|NORMAL|HIGH）+ 保存（PUT，带确认弹窗）。默认只读；刷新拉 GET。
- 样式复用 `agents.html` / `config.html` 卡片范式。

## 5. 路由与导航（src/http/routes.js）
- `import { createBusinessTierRouter }` + `app.use(createBusinessTierRouter({}))`。
- 静态别名：`/business-tier.html` → sendFile；`/portal/businessTier.js` → 模块挂载。

## 6. config 中心卡更新（src/portal/configCenter.js）
- 第 18 卡：`status:'pending'→'ready'`、`page:'/business-tier.html'`、`note:'DEAL=客户维×项目维，驱动自主边界'`。

## 7. 测试（TDD）
- `test/web/businessTier.test.js`：
  1. `renderBusinessTier` 注入 2 行 → 输出含 dimension 文本 + tier badge class。
  2. 空数组 → 含"尚未配置"降级。
  3. `tierRank` 断言 HIGH(3)>NORMAL(2)>LEAD(1)，未知 0。
  4. handler 注入假 deps：GET 返行；PUT 校验缺字段 400；PUT 合法触发 `produceDecision` 且 upsertTier 被调用。
- RED → GREEN。

## 8. 改动文件清单
| 文件 | 动作 |
|---|---|
| `src/http/businessTierRouter.js` | 新 |
| `src/portal/businessTier.js` | 新 |
| `test/web/businessTier.test.js` | 新 |
| `src/web/business-tier.html` | 新 |
| `src/http/routes.js` | 改（挂载 + 别名 + 模块） |
| `src/portal/configCenter.js` | 改（第18卡） |
| `docs/superpowers/plans/2026-08-27-business-tier-config.md` | 新 |

## 9. 验证
- `node node_modules/vitest/vitest.mjs run test/web/businessTier.test.js` → 绿。
- `test/web/` 整体回归无退。
- `node --check` 新文件。
- 起服务冒烟：`/business-tier.html` → 200；`/api/business-tier-config` → 200（空表）；`/portal/businessTier.js` → 200。

## 10. 范围边界
仅分级配置增/改；不含删、不含把分级接入 autonomy 引擎的额外逻辑（引擎已自动消费）。自主边界实际生效由既有 `computeBusinessTier` 保证。
