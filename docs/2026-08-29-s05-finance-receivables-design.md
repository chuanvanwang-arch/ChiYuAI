# S05 财务应收闭环设计（方案 C：看板 + 自动预警回流）

- 日期：2026-08-29
- 作者：AI 助手（王川的开发搭档）
- 状态：已批准（brainstorming P5 批准闸门）
- 关联：CRM-ai-native Stage 1 业务闭环增量 · 回款应收深化
- 设计输入：docs/2026-08-24-ai-native-sales-crm-design.md §03 编排设计

## 背景与动机

业务闭环（线索→客户→商机→报价→合同→订单→回款）后半段的实体与写操作已落地：
`CRM_DEAL / CRM_QUOTATION / CRM_CONTRACT / CRM_ORDER / CRM_INVOICE / CRM_PAYMENT_PLAN / CRM_PAYMENT_RECORD` 粒子齐全；
写 Action 白名单覆盖 `crm-quote/contract/invoice/order-create+submit`、`crm-payment-plan-create`、`crm-payment-record-create`、`crm-invoice-reconcile`。

但回款应收的**聚合与可视化能力散落、未闭环**：
- `crm-finance-receivables`（INVOICE+PAYMENT 聚合 Action）已注册，但无端点暴露、无页面挂载（`pages/schema.js` 未引用，`routes.js` 无独立应收端点）。
- `reconcileInvoice()` 发票维度对账已闭环（`invoiceService.js:9-49` 算 `paid/gap/can`），但**合同维度"计划回款 vs 实际回款"差额未算**（PAYMENT_PLAN 无实回字段，需 JOIN PAYMENT_RECORD）。
- `paymentService.checkOverdueAndEmit`（paymentService.js:37）逾期检查+emit 已存在，但未接入待办/看板。
- `payment_due` 回款逾期 Alert 规则已启用（alertRegistry.js:38），`alertHook.js` 已能"粒子写事件→规则→告警落库+SSE alert 域转播"，但差额超阈值的预警规则缺失。
- 无专属"财务应收看板"页（S05 场景）。

本次"回款应收深化"选方案 C：把已有能力聚合成 S05 财务应收闭环（看板 + 逾期自动催收待办 + 差额超阈值预警写回），**不新建粒子类型、不引入新存储**。

## §0 目标与范围（YAGNI 边界）

**做**：
1. 暴露财务应收聚合端点 `GET /api/finance/receivables`。
2. 新建应收看板页 `/receivables.html`（S05 财务应收场景）。
3. 逾期自动生成催收待办（复用 CRM 粒子待办机制，S05 finance 视角可见）。
4. 应收差额超阈值预警写回（扩展 `alertHook`/`ruleEvaluator`，落 `alerts` 表 + SSE `alert` 域）。
5. **应收配置后台化**：`config_store['finance-receivables']` 承载 `payment_overdue_days` / `gap_threshold_pct` / `aging_buckets`；端点 `GET/PUT /api/config/finance-receivables`（sysadmin 闸 + 决策第0闸）；UI 并入 `config.html`「财务应收」tab。
6. **逾期告警规则扩维**：现有 `payment_due`（仅 `CRM_INVOICE` 维度，`alertRegistry.js:38`）扩到 `CRM_PAYMENT_PLAN` 合同维度（`plan_end` 逾期判定），`due_days` 阈值改读 `config_store.payment_overdue_days`；原 INVOICE 规则保留。

**不做**：
- 不新建粒子类型（复用 PAYMENT_PLAN / PAYMENT_RECORD / CRM_INVOICE + 待办机制）。
- 不引入新存储表（差额/逾期为聚合计算，非持久化新实体）。
- 不做线索生命周期独立化、不做端到端流程自动串联（属其他方向）。

## §1 数据流

```
CRM_CONTRACT
  ├─ CRM_PAYMENT_PLAN   (plan_amount, plan_end, plan_status: pending/partial/done)
  ├─ CRM_PAYMENT_RECORD (paid_amount, paid_at, voucher)
  └─ CRM_INVOICE        (invoice_amount, reconcile_status: open/reconciled)
        │
GET /api/finance/receivables  →  JOIN 聚合（tenantId='system'）算 合同维：
   应收余额    = Σplan_amount − Σpaid_amount
   逾期天数    = plan_end − today  （plan_status ≠ 'done'）
   账龄分层    = 读 config_store['finance-receivables'].aging_buckets（缺省 0-30/31-60/61-90/90+ 天，后台可配）
   发票对账    = invoice_amount vs reconcile_status（复用 canReconcile 逻辑）
        │
/receivables.html (finance 角色) → 总览卡 + 合同应收明细表 + 发票对账状态 + 逾期区
        │
逾期 (checkOverdueAndEmit 扩展)        → 写催收待办（粒子待波机制，S05 finance 可见）
差额超阈值 (扩展 alertHook/ruleEvaluator) → createAlert + SSE 'alert' 域转播
        │
后台配置  GET/PUT /api/config/finance-receivables (sysadmin 闸 + 第0闸)
   ├─ payment_overdue_days  → T6 逾期规则阈值（CRM_PAYMENT_PLAN 维度）
   ├─ gap_threshold_pct     → T4 差额预警阈值（合同应收余额占比）
   └─ aging_buckets         → T1 账龄分层档位
```

**角色闸门**：`finance` 角色（`roleProfiles.js:17` data_scope 覆盖 payment/contract/invoice）；非 finance 访问 `/receivables.html` 与 `/api/finance/receivables` 返回 403。

## §2 任务分解（生命契约双轨）

### T1 — 暴露财务应收聚合端点

```contract-yaml
- task: "实现 GET /api/finance/receivables 应收聚合端点"
  agent: crm-copilot
  skills: [data-particle-read]
  memory: [crm-copilot]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "GET /api/finance/receivables 返回合同维应收余额/逾期天数/账龄分层/发票对账，finance 角色可访问"
```

**契约说明**：本任务由 `crm-copilot` 承接，调用 `data-particle-read` SKILL、读取 `crm-copilot` 记忆（L1，≤2 跳）；成功标准为端点返回合同维应收余额/逾期/账龄/发票对账且 finance 可访问。
**实现要点**：`finance-receivables` Action 当前无 handler 落点 → 在 `src/http/routes.js` 挂载 `GET /api/finance/receivables`，内部 `queryParticles` 拉取 CONTRACT/PAYMENT_PLAN/PAYMENT_RECORD/INVOICE（复用 `routes.js:958` 已存在的合同维聚合范式），JOIN 计算差额/逾期/账龄；挂 `resolveMe` + finance 角色闸。

### T2 — 应收看板页（S05 财务应收场景）

```contract-yaml
- task: "新建 /receivables.html 应收看板（总览+明细+发票对账+逾期）"
  agent: crm-copilot
  skills: [data-particle-read]
  memory: [crm-copilot]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "finance 角色打开 /receivables.html 渲染总览卡+合同应收明细表+发票对账状态+逾期区，挂左侧导航"
```

**契约说明**：本任务由 `crm-copilot` 承接，调用 `data-particle-read`、读 `crm-copilot` 记忆；成功标准为 finance 打开页面渲染四区且左侧导航可达。
**实现要点**：新建 `src/web/receivables.html`，复用 `common.css` 页头/分区约定（方向 A 清爽分隔线）；调 `GET /api/finance/receivables`；总览卡（合同数/应收余额/逾期笔数/逾期金额）+ 合同应收明细表（plan/paid/gap/逾期天数/账龄标签/状态）+ 发票对账状态块 + 逾期区；左侧导航在 `layoutMenu.js` 加 finance 组入口（仅 finance 角色可见）；链 `/portal/page.css` + `tokens.css` + `common.css`（受控渲染页硬性依赖铁律）。

### T3 — 逾期自动催收待办

```contract-yaml
- task: "扩展 paymentService.checkOverdueAndEmit：逾期 plan 自动写催收待办（粒子待办机制）"
  agent: crm-copilot
  skills: [data-particle-read, data-particle-create]
  memory: [crm-copilot]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "造逾期 PAYMENT_PLAN → S05 待办工作台 finance 视角出现催收待办；fail-open 不阻断主流程"
```

**契约说明**：本任务由 `crm-copilot` 承接，调用 `data-particle-read`+`data-particle-create`、读 `crm-copilot` 记忆；成功标准为逾期 plan 自动生成催收待办且 S05 finance 可见、fail-open。
**实现要点**：扩展 `src/sales/paymentService.js:37 checkOverdueAndEmit`——对 `plan_status≠done && plan_end<today` 的 plan，写一条催收待办（复用 CRM 粒子待办机制，经 `queryParticles` 可读；不新建 `user_tasks` 表）；S05 待办工作台（`routes.js:751` 四角色视角，`role='finance'`）经 `queryParticles` 呈现。`fail-open`：写待办失败不阻断主流程（对齐 `routes.js:224`）。

### T4 — 差额超阈值预警写回

```contract-yaml
- task: "扩展 alertHook/ruleEvaluator：应收差额超阈值→createAlert+SSE alert 域"
  agent: crm-copilot
  skills: [data-particle-read]
  memory: [crm-copilot]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "造差额超阈值合同 → alerts 表新增 payment_gap 告警 + SSE 'alert' 事件转播；payment 写事件触发规则"
```

**契约说明**：本任务由 `crm-copilot` 承接，调用 `data-particle-read`、读 `crm-copilot` 记忆；成功标准为差额超阈值→`alerts` 表新增 `payment_gap` + SSE `alert` 事件、由 payment 写事件触发。
**实现要点**：在 `src/alerts/alertRegistry.js` 新增 `payment_gap` 规则（`match.particleTypes:['CRM_PAYMENT_PLAN','CRM_PAYMENT_RECORD']`，`check_params:{ gap_threshold_pct: 5 }`）；扩展 `src/alerts/ruleEvaluator.js` 加 `gap` 判定（差额=Σplan−Σpaid，超阈值→hit）；`alertHook.js` 订阅 `particle` 域已能 `createAlert`+`emit('alert',...)`，命中即落库+SSE 转播。阈值默认 5%（合同应收余额占比）落 `config_store['finance-receivables']`，可配置。

### T5 — 应收配置后台化（config_store + 端点 + UI tab）

```contract-yaml
- task: "应收配置后台化：config_store['finance-receivables'] + GET/PUT /api/config/finance-receivables + config.html 财务应收 tab"
  agent: crm-copilot
  skills: [data-particle-read]
  memory: [crm-copilot]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "config_store 含 finance-receivables 键（payment_overdue_days/gap_threshold_pct/aging_buckets）；GET/PUT /api/config/finance-receivables sysadmin 可写、非 sysadmin 403、写经第0闸；config.html 出现「财务应收」tab 可编辑三项阈值"
```

**契约说明**：本任务由 `crm-copilot` 承接，调用 `data-particle-read`、读 `crm-copilot` 记忆；成功标准为配置键落库 + 端点 sysadmin 可写 + UI tab 可见。
**实现要点**：仿 S20 `seven-dim` 范式（`src/http/sevenDimRouter.js:13` `CONFIG_KEY='seven-dim'`、`GET/PUT /api/config/seven-dim`、sysadmin 闸 + 决策第0闸 TEXT decision_id 无 FK）。新增 `src/http/financeReceivablesConfigRouter.js`（`CONFIG_KEY='finance-receivables'`，结构 `{ payment_overdue_days:7, gap_threshold_pct:5, aging_buckets:[[0,30],[31,60],[61,90],[91,9999]] }`），`routes.js` 挂载 `GET/PUT /api/config/finance-receivables`；`config.html`（`.tabs` 通用壳，`src/web/config.html:13`）动态注入「财务应收」tab（sysadmin 可见），三个 number/JSON 输入绑定 PUT 端点；缺省值种子写入 `config_store`（幂等，非空跳过）。

### T6 — 逾期告警规则扩维到 PAYMENT_PLAN

```contract-yaml
- task: "payment_due 规则扩维到 CRM_PAYMENT_PLAN 维度，due_days 读 config_store.payment_overdue_days"
  agent: crm-copilot
  skills: [data-particle-read]
  memory: [crm-copilot]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "造 1 条 PAYMENT_PLAN 逾期（plan_end<today, plan_status≠done）→ payment_due 规则命中（CRM_PAYMENT_PLAN 维度）生成逾期告警 + SSE 'alert' 事件；原 INVOICE 维度规则保留；阈值随 config_store.payment_overdue_days 变化"
```

**契约说明**：本任务由 `crm-copilot` 承接，调用 `data-particle-read`、读 `crm-copilot` 记忆；成功标准为 PAYMENT_PLAN 逾期触发 payment_due 告警且阈值可后台调。
**实现要点**：现状 `payment_due`（`alertRegistry.js:38`）`match.particleTypes:['CRM_INVOICE']` + `actions:['invoice_create','payment_create']` + `check_params:{due_days:7}`，**不覆盖 PAYMENT_PLAN**（grep 0 命中）。T6 在 `alertRegistry.js` 新增一条 `payment_due_plan` 规则（`match.particleTypes:['CRM_PAYMENT_PLAN']`、`actions:['payment_plan_create','payment_record_create']`、`check_params:{ due_days_ref:'config:finance-receivables.payment_overdue_days' }`），或由 `ruleEvaluator.js` 在 `payment_due` 命中时回查 `config_store.payment_overdue_days` 作为动态阈值；`plan_end<today && plan_status≠done` 即逾期。触发链路复用 `alertHook.js` 订阅 `particle` 域 → `createAlert` + `emit('alert',...)`。原 INVOICE 规则保留不动。

## §3 成功标准（端到端可验证）

1. `GET /api/finance/receivables` 返回 ≥1 合同的应收余额/逾期天数/账龄分层/发票对账（finance 可访问，非 finance 403）。
2. `/receivables.html`（finance）渲染总览卡 + 合同应收明细表 + 发票对账状态 + 逾期区，左侧导航可达。
3. 造 1 条逾期 `PAYMENT_PLAN` → S05 待办工作台 `role=finance` 视角出现催收待办。
4. 造 1 条差额超阈值合同 → `alerts` 表新增 `payment_gap` 告警 + SSE `alert` 事件。
5. `GET/PUT /api/config/finance-receivables` sysadmin 可写、非 sysadmin 403；`config.html`「财务应收」tab 可编辑 `payment_overdue_days`(缺省7)/`gap_threshold_pct`(缺省5)/`aging_buckets`(缺省四档)；三项阈值改动经端点持久化到 `config_store`。
6. 造 1 条 `PAYMENT_PLAN` 逾期（`plan_end<today`）→ `payment_due` 规则命中（`CRM_PAYMENT_PLAN` 维度）生成逾期告警 + SSE `alert` 事件；调小 `config_store.payment_overdue_days` 后同合同重新触发更早告警。

**测试策略（TDD）**：先写失败测试（`test/http/finance-receivables.test.js` 覆盖端点聚合/角色闸；`test/web/receivables.test.js` 覆盖页面渲染契约；`test/alerts/payment-gap.test.js` 覆盖规则命中），再实现。

## §4 边界与假设

- **待办写入**：复用 CRM 粒子待办机制（`queryParticles` 可读），不新建 `user_tasks` 表；`fail-open` 不阻断主流程（对齐 `routes.js:224`）。
- **后台配置（T5/T6）**：`config_store['finance-receivables']` 结构 `{ payment_overdue_days:7, gap_threshold_pct:5, aging_buckets:[[0,30],[31,60],[61,90],[91,9999]] }`；端点 `GET/PUT /api/config/finance-receivables`（sysadmin 闸 + 决策第0闸 TEXT decision_id，形态对齐 S20 seven-dim `sevenDimRouter.js`）；UI 并入 `config.html`「财务应收」tab（复用其 `.tabs` 通用壳，`src/web/config.html:13`）。**账龄/逾期/差额三项阈值均后台可调**，缺省如上；非 sysadmin 访问端点返回 403。
- **`finance-receivables` handler**：当前 `grep` 无落点 → T1 实现该 Action 的执行逻辑（或挂载为 `/api/finance/receivables` 专用端点）。
- **角色闸门**：`/receivables.html` 限 `finance` 角色（复用 `roleProfiles.js:17` data_scope）。
- **前端守卫契约铁律**：`api()` 直接透传后端 JSON，不包裹 `ok`；鉴权守卫先实测成功响应体真实字段（禁止假设含 `ok`），参考 `config.html` 教训。
- **受控渲染页硬性依赖**：`/receivables.html` 必须链 `/portal/page.css`，否则出片无样式。

## 闭环回写（P0 预检表）

| task | agent | gap_type | observed | expected | severity | ts |
|------|-------|----------|----------|----------|----------|-----|
| T1 | crm-copilot | — | — | — | — | — |
| T2 | crm-copilot | — | — | — | — | — |
| T3 | crm-copilot | — | — | — | — | — |
| T4 | crm-copilot | — | — | — | — | — |
| T5 | crm-copilot | — | — | — | — | — |
| T6 | crm-copilot | — | — | — | — | — |

> 本表由 agent-workbench 运行时监控 `contract-yaml` 命中情况并 upsert 反馈；下一轮 P0 吸收 ≥2 次同 `(task,gap_type)` 复盘，提出 SKILL 改进提案（需用户批准）。
