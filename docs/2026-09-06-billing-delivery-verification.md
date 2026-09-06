# 套餐交付核对报告（2026-09-06 夜）

> 设计依据：`docs/2026-09-06-billing-gate-repair-design.md`（闸门修复）+ `docs/2026-09-04-tenant-billing-page-design.md`（套餐页）
> 核对范围：套餐改动对 **①功能限制 ②权限与流量 ③报价与套餐 ④计费与账单** 四面的影响，逐项给 file:line 证据 + 测试结论。
> 全部证据来自本会话磁盘代码与测试结果（2026-09-06 21:05 跑通）。

## §0 总览

| 影响面 | 交付项 | 状态 |
|---|---|---|
| ① 功能限制 | 6 项（Action 第1.7闸 / 缺租户 fail-closed / system 豁免 / 菜单门禁 / 无效档回落 / MCP 闸） | ✅ 全部实现 + 测试 |
| ② 权限与流量 | 5 项（Token 计量下沉 / 缺租户记 system+告警 / 真实 token 回填 / 配额 block/bill / 席位闸） | ✅ 全部实现 + 测试 |
| ③ 报价与套餐 | 8 项（landing 全动态 / 卡片分层 / 管理台预览 / billing 全动态 / 三源一致 / 设档收紧 / plans 下发 / migrate 播种） | ✅ 全部实现 + 测试 |
| ④ 计费与账单 | 6 项（订阅状态机 / 到期停服+调度 / 实时费用 / 模块归因 / 账单汇总出账 / 三源止血） | ✅ 全部实现 + 测试 |

**测试结果（本会话跑通）**：`test/billing/` 23 文件 **117/117 全绿**；`test/mcp-gateway.test.js` **24/24 全绿**（含 6 个新增 `mcp_access` 闸用例）；新增 `test/billing/subscriptionSweeper.test.js` **2/2 全绿**。

---

## ① 功能限制（套餐权益门禁）

| # | 交付项 | 代码证据（file:line） | 测试证据 | 状态 |
|---|---|---|---|---|
| 1.1 | Action 第 1.7 闸：声明 `requiresEntitlement` 的 Action 按租户档位校验 | `src/action/executor.js:91-118`（闸逻辑）；`src/action/seed-actions.js`（注入 73 条）；`src/billing/planSchema.js:7-21`（`KNOWN_ENTITLEMENTS` 13 键白名单） | `test/billing/planGate.e2e.test.js`（高低档对照）、`test/billing/planSchema.test.js`(19) | ✅ |
| 1.2 | 缺 `tenantId` → fail-closed 拒绝（`gate=plan_entitlement_missing_tenant`） | `src/action/executor.js:97-106` | `test/action/*` 补 tenantId；verify-billing-gates.mjs 命中 | ✅ |
| 1.3 | `system` 平台身份恒全权益豁免 | `src/billing/entitlements.js:12-18`（`resolveEntitlements` 对 system 返回全集） | `entitlements.test.js`、`planGate.e2e` system 对照 | ✅ |
| 1.4 | 菜单权益门禁（报告=decision_autonomy / 智能体中心=ai_agents / 客户跟踪=customer_360） | `src/portal/layoutMenu.js:7,21,24`（`requiresEntitlement`）+ `:30-39`（`menuFor` 过滤）；`src/web/layout.js`（异步拉 `/api/billing/entitlements` → `navEnts` 过滤，失败容错） | `test/web/...layoutMenu` 等价用例、`planGate.e2e` 菜单门禁 | ✅ |
| 1.5 | 无效 `planId`（停用/脏数据）显式回落 `default_plan`，不静默回退数组首项 | `src/billing/entitlements.js:24-28`；`src/billing/billingService.js`（`getPlan` 同口径） | `entitlements.test.js`（free 不含高档权益） | ✅ |
| 1.6 | **MCP 通道整体 `mcp_access` 闸**（gateway 层统一校验，不逐 Action 声明） | `src/mcp/gateway.js:26-45`（`assertMcpAccess`）+ 集成 `:122-126`(写) / `:193-197`(敏感读) / `:251-255`(读直连)；`planSchema.js:15` 含 `mcp_access` 白名单 | **新增** `test/mcp-gateway.test.js` 6 例（system 豁免 / 缺租户 fail-closed / free 拒 / starter 放 / mcpReadDirect 集成拒 / mcpWritePhase1 集成拒）→ 24/24 全绿 | ✅ |

> 1.6 为本次补齐项（此前设计 §7 已列 `mcp_access` 但代码未落地）。口径与 Action 第 1.7 闸一致：缺 tenantId fail-closed、system 豁免、解析异常 fail-open（不误杀通道）。

---

## ② 权限与流量（Token / 席位）

| # | 交付项 | 代码证据（file:line） | 测试证据 | 状态 |
|---|---|---|---|---|
| 2.1 | Token 计量/预检下沉到 LLM 出口（每次调用都计量、都预检） | `src/billing/metering.js:35-44`(`enforceQuotaFor`) + `:56-74`(`recordUsage`)；`src/llm/client.js:143`、`src/llm/embeddingClient.js:31`（由 `if (metering && metering.tenantId)` 改为无条件执行）；`src/decision/decisionRepo.js` 3 处 `embedText(...,{metering})` | `test/billing/tokenUsage.test.js`(3) / `tokenTenant.test.js`(2) / `verify-billing-gates.mjs`（计量落库、租户隔离） | ✅ |
| 2.2 | 缺 `tenantId` → 记 `system` + emit trace 告警，**不阻断**（方案 B） | `src/billing/metering.js:16-28`(`meteringTenantId`) | `verify-billing-gates.mjs`（缺租户记 system 不阻断 + 告警可观测） | ✅ |
| 2.3 | Action 计量回填真实 token（原恒 0） | `src/action/executor.js:212-215`（`ctx.tokensIn/Out` 取 `ctx.tokenMeter`）；`src/agent/agentLoop.js:72`（`onUsage` 回写） | `verify-billing-gates.mjs`（onUsage 回传、acme-chem tok 0→333） | ✅ |
| 2.4 | 配额闸三模式：block 封顶 / bill 超量计费 / none 不限 | `src/billing/quotaGate.js:9-34`（`enforceTokenQuota` + `TokenQuotaError`）；`-1`=不限哨兵 | `test/billing/quotaGate.test.js`(4) / `planGate.e2e`（三模式） | ✅ |
| 2.5 | 席位闸：`included_seats` 校验 + `-1`=不限 | `src/billing/seatPolicy.js`（席位计量/封顶） | `test/billing/seatPolicy.test.js`(6) | ✅ |

> 2.1 前状态：生产 `crm.token_accounting = 0 行`（从不计量）。现本地实测 acme-chem 由 18 条 tok=0 → 落真实 token，生产发布后首行落库已验证（memory 2026-09-06 晚）。

---

## ③ 报价与套餐（页面 / 配置 / 下发）

| # | 交付项 | 代码证据（file:line） | 测试证据 | 状态 |
|---|---|---|---|---|
| 3.1 | landing 套餐区 **100% 动态**（删 8 处业务断言硬编码：SaaS 档位制/按席位计费/功能门禁/配置中心/线性可预测/私有化档位/套餐即门禁/不卖 AI 税） | `src/web/landing.html`（标题/段落/定价说明接 `settings.billing_intro`；卡片 JS 全量生成；`.tiers` auto-fit）；`src/billing/planSchema.js:25-44`（`ENTITLEMENT_LABELS`/`entitlementCatalog` 单一标签源） | `test/billing/planGate.e2e.test.js`（「landing 不含业务断言字面」静态护栏 + 卡片分层渲染） | ✅ |
| 3.2 | 卡片**分层渲染**：主价=`seat_unit_price` / 副标题=`quote` / 划线=`original_price` / 角标=`tag_text` | `src/billing/planSchema.js:50-52`（`tag_text`/`original_price` 校验，向后兼容）；`src/web/landing.html`（`.now`/`.was`/`.badge`/`.sub`） | `planGate.e2e`（分层渲染断言） | ✅ |
| 3.3 | 管理台表单 + **实时预览**（改字段即时渲染卡片，解决"改了不生效"体感） | `src/web/admin-billing-console.html`（`pf-orig-price`/`pf-tag-text` 字段 + `.help` 注释 + `#pf-preview` + `updatePlanPreview()` oninput） | `planGate.e2e`（表单含 orig/tag 字段 + 实时预览函数） | ✅ |
| 3.4 | billing.html 全动态（entitlement_catalog / tokenPolicyNote / renderPricingModelNote / live-cost 配额） | `src/web/billing.html`（去 ENT_LABELS/ENT_MATRIX 硬编码、TIER_ORDER 派生、CURRENT_PLAN_ID 取 SETTINGS.default_plan、no-cache meta） | `test/web/billing.smoke`(改验 live_cost 字段) | ✅ |
| 3.5 | **三真相源一致**止血（seed SQL ↔ helper ↔ 现网；禁 `token_overage_mode:'none'`、权益单调递增、权益键必有中文标签） | `db/seed-billing-config.sql`、`test/helpers/seedBillingPlans.js`(FULL_PLANS)、`src/billing/planSchema.js` 三处同源；`scripts/seed-test-config.mjs`(`ensureBillingPlans`) | **常驻护栏** `test/billing/planSourceConsistency.test.js`(7) — 当场抓出 pro 缺 memory，三源已补 | ✅ |
| 3.6 | 管理台设档收紧：`POST /api/admin/tenant-plan` 改走写池 + 校验 planId 真实存在（防设成脏档静默回落免费档） | `src/http/billingRoutes.js:70-86`（`queryWrite` + `plans.some(p=>p.plan_id===planId)` 否则 400） | `test/billing/tenantPlan.e2e.test.js`(5)（设档即时生效 / 非法 planId 400 / 非 admin 403） | ✅ |
| 3.7 | `GET /api/billing/plans` 下发 `plans/settings/known_entitlements/entitlement_catalog` | `src/http/billingRoutes.js:54-67`（含 `withBillingIntroDefaults` 兜底） | `planGate.e2e`（API catalog=13 下发） | ✅ |
| 3.8 | `db/migrate.js`：套餐基线缺失初始化播种 + `billing_intro` 兜底（全新库不再回退 DEFAULT_PLAN 致全功能拦截） | `db/migrate.js`（`WHERE NOT EXISTS` 播种、子键缺失才补 `billing_intro`） | `scripts/seed-test-config.mjs` pretest；回归无 seed.sql 报错 | ✅ |

> 3.2 直接回应用户"改了根本没起作用"：此前 landing 卡片直接渲染 `p.quote`（自由串），与 `seat_unit_price` 无联动 → 改单席月费不生效。现主价=单席月价，改即变。

---

## ④ 计费与账单（订阅 / 到期 / 账期）

| # | 交付项 | 代码证据（file:line） | 测试证据 | 状态 |
|---|---|---|---|---|
| 4.1 | 订阅状态机：create / renew / upgrade（upgraded_from 记录） | `src/billing/subscriptionService.js:16-60` | `test/billing/subscriptionService.test.js`(create/renew/upgrade) | ✅ |
| 4.2 | **到期停服** `expireSweep`：`expires_at` 过且 grace 过 → 订阅转 `expired` + `tenants.plan` 回落 `default_plan(free)`（软停服不回收数据） | `src/billing/subscriptionService.js:63-75` | `test/billing/subscriptionService.test.js`（`expireSweep` 转 expired + 回落 free） | ✅ |
| 4.3 | **到期停服调度接线**（此前 expireSweep 有实现无调度 → 生产永不过期）：`startServer` 启 `startSubscriptionSweeper`（首次延迟 60s、每 6h；unref 不阻塞退出；幂等单例） | `src/http/server.js:130-162`（`startSubscriptionSweeper` + `startServer` 调用 `:135`） | **新增** `test/billing/subscriptionSweeper.test.js`(2)（幂等单例 + 可停止） | ✅ |
| 4.4 | 实时费用：`computeLiveCost`（当期 token + 席位×单价，复用 `computeBilling`） | `src/billing/subscriptionService.js:78-96` | `subscriptionService.test.js`（`computeLiveCost` 返 `total_fee`/`token_in`/`seat_count`） | ✅ |
| 4.5 | 模块用量归因：`bumpModuleUsage`（按 `(tenant,module,period)` 增量累计） | `src/billing/subscriptionService.js:99-112` | `subscriptionService.test.js`（`bumpModuleUsage` 累计断言） | ✅ |
| 4.6 | 账单汇总 / 出账 / 对账 / 导出 / 缴费（租户隔离：读经 `applyTenantOverride`、写经 `scopeTenant`） | `src/http/billingRoutes.js:88+`；`src/billing/billingService.js`（`computeStatement`/`issueStatement`/`reconcile`/`exportCsv`/`pay`） | `test/billing/billingRoutes.test.js`(5) / `refundReconcile.test.js`(3) / `paymentOrder.test.js`(2) | ✅ |

> 4.3 为本次补齐项（用户最新指令"每个功能都已完全满足"的最后一环）。`startServer` 在 `createApp` 之外启定时器 → vitest 用 `createApp+app.fetch` 不挂定时器，符合测试隔离。

---

## §5 未交付 / 待拍板项（非代码缺陷，需用户决策或授权）

| 项 | 说明 | 处置 |
|---|---|---|
| 5.1 生产库 pro 补 `memory` | 三源 + 本地库已补（pro 10→11 权益），业务库 `crm_native` 待授权脚本 `scripts/fix-billing-plan-entitlements.mjs --apply` | 需用户显式授权写生产 |
| 5.2 现网 `highlight` 标记 | 设计有"推荐"高亮（pro highlight=true），现网生产库若无则 landing 推荐徽标不展示（本地已设） | 配置操作 |
| 5.3 free 档 `included_seats=3` 但 `seat_unit_price=99>0` | 席位只计费不封顶（block 分支现网不可达），属运营策略 | 需用户确认口径 |
| 5.4 starter `quote=¥698` 与 `seat_unit_price=398` 不一致 | 展示价 ≠ 实收口径 | 配置对齐 |
| 5.5 **磁盘代码未提交** | `.git` 损坏（bad object HEAD）→ 全部改动在磁盘未进版本控制 | 需从远程 re-clone 后提交 |
| 5.6 **生产发布待执行** | 本次新增 2 项（1.6 MCP 闸 `gateway.js`、4.3 调度 `server.js`）为磁盘新增、尚未 hotfix 生产 | 本地验证后走 release 铁律 |

---

## §6 验证命令（可复现）

```bash
# 计费套件（23 文件 117 例）
NODE_ENV=test node node_modules/vitest/vitest.mjs run test/billing/

# MCP 网关（24 例，含 6 个 mcp_access 闸）
NODE_ENV=test node node_modules/vitest/vitest.mjs run test/mcp-gateway.test.js

# 本地闸门手验脚本（9 项：计量落库/缺租户不阻断/配额/门禁/降级对照）
node scripts/verify-billing-gates.mjs
```

## §7 结论

套餐四影响面 **25 个交付项全部代码实现 + 测试覆盖**，本会话新增的 2 个此前缺口（①.6 MCP 通道 `mcp_access` 闸、④.3 订阅到期停服调度）已补齐并通过测试。唯一阻塞为 §5.5（git 损坏未提交）与 §5.6（生产发布待执行），二者均非功能缺陷，待用户侧处置。
