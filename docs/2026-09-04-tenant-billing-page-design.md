# 设计文档：多租户计费与费用页面（按账号计费 + 套餐功能门槛）

> 日期：2026-09-04
> 状态：设计已批准（brainstorming P5），待移交 writing-plans；2026-09-04 修订：档位由 4 档扩为 5 档（新增本地旗舰版）、计价由"账号费+Token费两线"改为"按账号/席位单线"，对齐对外宣传页定价
> 参考：attio / Lightfield 2026 计费模型；本项目 tenant 隔离 + 零信任 HITL 既有范式

## 1. 背景与目标

为 CRM-ai-native 平台新增**平台级计费域**，与既有「面向客户的销售回款」（`CRM_INVOICE` / `CRM_PAYMENT_PLAN` / `CRM_PAYMENT_RECORD`）解耦。目标：

- 按租户统计 **账号使用费（按账号/席位计费单线）**；套餐同时决定功能权益门禁。
- 租户**自助查询**本租户账单；管理员**集中查询**全部租户、并对账/导出。
- **在线缴费**：平台内缴费记录流（生成缴费单 + 状态机），不接真实第三方网关。
- 套餐（免费版/成长版/增强版/企业版/本地旗舰版，对应 Free/Starter/Pro/Enterprise/Local Flagship）参考 attio/Lightfield **SaaS 档位制**，底层 config 配置化（禁硬编码）。
- **功能门槛**：套餐不仅决定价格，还决定**功能权益门禁**（attio/Lightfield 按档解锁 AI agents / 自动化 / 报表 / SSO）。

## 2. 范围与边界

| 纳入（In） | 排除（Out） |
|---|---|
| token 计量补 tenant_id、计费表、计费配置、汇总/逾期/缴费/对账/导出 API、billing.html、功能门槛门禁（代表打标） | 真实第三方支付网关（Stripe/微信/支付宝） |
| 账期粒度可配（月/季）、逾期提醒、缴费方式记录、CSV 导出 | 记录/数据量第三计费线（仅按账号计费单线） |
| dispatch 第 1.7 闸 + 解析器 + 代表动作打标 | 全量 action 打标 / 前端锁定提示（后续版本） |

## 3. 已确认设计决策

1. **缴费深度**：平台内缴费记录流（缴费单状态机，零外部依赖）。
2. **计价模型**：attio/Lightfield 混合——`账号费 = seat_unit_price × 账号数`（按账号/席位计费，单价随档固定，无 Token 超量线）；config 配置化。
3. **四项增量**：导出与对账 / 逾期与提醒 / 缴费方式记录 / 账期粒度可配（全部纳入）。
4. **角色可见性**：租户内全员可读本租户账单 + 可发起缴费；集中查询仅 admin/sysadmin。
5. **出账时机**：手动 / 脚本 `issue` 落库为 statement（可重算）。
6. **计费线**：仅按账号（席位）计费单线；套餐即功能门禁。
7. **功能门槛**：真实门禁 + 代表打标（dispatch 第 1.7 闸 + 解析器 + 代表 action 标 `requiresEntitlement` + 页面功能矩阵）。

## 4. 数据模型

### 4.1 补 token 计量租户维度（前置必做）
`db/migration-billing-token-tenant.sql`：
```sql
ALTER TABLE crm.token_accounting
  ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'system';
CREATE INDEX IF NOT EXISTS idx_crm_token_accounting_tenant
  ON crm.token_accounting(tenant_id, created_at);
```
改写 `src/alerts/tokenAccounting.js` 写入逻辑：INSERT 增 `tenant_id`，值取自请求上下文（actor 所属租户 / `llm_config.tenant_id` / decision 上下文）。既有行因 `DEFAULT 'system'` 自动归 platform 默认租户。

### 4.2 计费配置（config_store，配置化禁硬编码）
`config_store['billing-settings']`：
```json
{ "cycle": "monthly", "default_plan": "free", "currency": "CNY", "grace_days": 15 }
```
`config_store['billing-plans']`（出厂默认，可改）：
```json
[
  { "plan_id":"free",          "name":"免费版",   "seat_unit_price":0,    "currency":"CNY", "features":"核心 CRM（含 3 席位）", "entitlements":["core_crm"] },
  { "plan_id":"starter",       "name":"成长版",   "seat_unit_price":698,  "currency":"CNY", "features":"+ AI 代理/360洞察", "entitlements":["core_crm","ai_agents","customer_360"] },
  { "plan_id":"pro",           "name":"增强版",   "seat_unit_price":2980, "currency":"CNY", "features":"+ 决策自治/事件自动化/审批/LLM/MCP/报表/审计", "entitlements":["core_crm","ai_agents","customer_360","decision_autonomy","event_automation","approval_flow","llm_config","mcp_access","advanced_reporting","audit_provenance"] },
  { "plan_id":"enterprise",    "name":"企业版",   "seat_unit_price":8800, "currency":"CNY", "features":"+ 行业配置/高级RBAC/客户记忆", "entitlements":["core_crm","ai_agents","customer_360","decision_autonomy","event_automation","approval_flow","llm_config","mcp_access","advanced_reporting","audit_provenance","industry_config","rbac_advanced","memory"] },
  { "plan_id":"local-flagship","name":"本地旗舰版","seat_unit_price":0,    "currency":"CNY", "features":"面议：私有化部署/数据不出域/全量功能+定制", "entitlements":["core_crm","ai_agents","customer_360","decision_autonomy","event_automation","approval_flow","llm_config","mcp_access","advanced_reporting","audit_provenance","industry_config","rbac_advanced","memory","private_deploy"] }
]
```
> `seat_unit_price` 为本档每账号/席位的月度单价（CNY）；免费版 / 本地旗舰版 `seat_unit_price=0` 表示不计费或面议（本地旗舰版按部署规模与 SLA 评估）。

### 4.3 计费表（新建，均带 tenant_id + 状态枚举约束）
```sql
CREATE TABLE IF NOT EXISTS crm.billing_statement (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   TEXT NOT NULL DEFAULT 'system',
  period      TEXT NOT NULL,                     -- '2026-09' / '2026-Q3'
  cycle       TEXT NOT NULL DEFAULT 'monthly' CHECK (cycle IN ('monthly','quarterly')),
  token_in    INT NOT NULL DEFAULT 0,
  token_out   INT NOT NULL DEFAULT 0,
  token_fee   NUMERIC(12,2) NOT NULL DEFAULT 0,
  seat_count  INT NOT NULL DEFAULT 0,
  seat_fee    NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_fee   NUMERIC(12,2) NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','issued','paid','overdue')),
  issued_at   TIMESTAMPTZ,
  due_at      TIMESTAMPTZ,
  paid_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, period, cycle)
);
CREATE TABLE IF NOT EXISTS crm.billing_payment (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  statement_id BIGINT NOT NULL REFERENCES crm.billing_statement(id),
  amount      NUMERIC(12,2) NOT NULL,
  method      TEXT NOT NULL CHECK (method IN ('bank_transfer','wechat','alipay','other')),
  status      TEXT NOT NULL DEFAULT 'paid' CHECK (status IN ('pending','paid','failed')),
  paid_at     TIMESTAMPTZ,
  txn_ref     TEXT,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 4.4 启用 tenants.plan
`crm.tenants.plan` 列已预留（`2026-09-03-crm-tenants.sql`）。新增写动作 `tenant-set-plan`（admin/sysadmin，写经决策第0闸 + HITL），更新该列；解析器据其查 `billing-plans` 得权益集。

## 5. 计费逻辑

- **活跃席位**：`COUNT(*)` from `crm.crm_users` where `tenant_id = ? AND status='active'`（按租户隔离）。
- **账号费** = `seat_unit_price × seat_count`（按账号/席位计费，单价随档固定；免费版不计费，本地旗舰版面议）。
- ~~Token 费~~：本期取消独立 Token 计量计费线（无隐藏 Token 税），Token 用量含于套餐，不单列超量。
- **逾期**：`status='issued'` 且 `due_at < now()` → 读取时幂等翻 `overdue`（免 cron）。

## 6. 功能门槛：套餐 → 权益 → 门禁

### 6.1 模型
- `billing-plans[].entitlements: string[]`（本档解锁功能键，见 6.2）。
- 解析器 `src/billing/entitlements.js`：`resolveEntitlements(tenantId)` → 读 `tenants.plan` → 查 `billing-plans[plan].entitlements` → 返回 `Set<string>`（可短期缓存）。

### 6.2 权益目录（**仅含本平台真实能力**，attio/Lightfield 仅参考其计价结构）

> 铁律：外部方法论（attio/Lightfield）只作**计价模型**参考，功能键必须对应本平台**已落地**能力；不得引入本平台不存在的功能（如通用 data_export / SSO）作门槛。

| 本平台真实功能（依据） | 功能键 | Free | 成长版 | 增强版 | 企业版 | 本地旗舰版 |
|---|---|:--:|:--:|:--:|:--:|:--:|
| 核心 CRM：客户/商机/合同/报价/回款 粒子 CRUD（`crm.particles` + `seed-actions`） | `core_crm` | ✓ | ✓ | ✓ | ✓ | ✓ |
| AI 智能体四件套：intake-router / quote-engine / followup-agent / review-gate（`src/agent/agentSpec.js`） | `ai_agents` | — | ✓ | ✓ | ✓ | ✓ |
| 客户 360 洞察（S35 `account-360.html` / `insightService`） | `customer_360` | — | ✓ | ✓ | ✓ | ✓ |
| 决策自治层：autonomyEngine + D 层 + 决策事件主轴（`autonomyEngine.js` / decision 体系） | `decision_autonomy` | — | — | ✓ | ✓ | ✓ |
| 事件触发自动化：eventTrigger + SSE + agent-event-trigger（`eventTrigger.js` / config 39） | `event_automation` | — | — | ✓ | ✓ | ✓ |
| 审批流配置：CRM_APPROVAL_FLOW（`approval-flow.html` / executor 第3闸） | `approval_flow` | — | — | ✓ | ✓ | ✓ |
| 多租户 LLM 配置（`llm-config.html` / `crm.llm_config`） | `llm_config` | — | — | ✓ | ✓ | ✓ |
| MCP 接入：crm-native MCP（:3001/mcp） | `mcp_access` | — | — | ✓ | ✓ | ✓ |
| 高级报表 / 对账看板（`finance-receivables` / `sales-decision-monitor` / `business-board`） | `advanced_reporting` | — | — | ✓ | ✓ | ✓ |
| 决策溯源/审计：C1-C4 provenance + 哈希链（`provenance.js`） | `audit_provenance` | — | — | ✓ | ✓ | ✓ |
| 行业配置化：方案 B 每租户自有 + 上线引导（`industry-onboarding`） | `industry_config` | — | — | — | ✓ | ✓ |
| 高级 RBAC：data_scope 域级收窄 / sysadmin（`role_context_profile`） | `rbac_advanced` | — | — | — | ✓ | ✓ |
| 客户记忆：memory lifecycle（`crm.memory_log`） | `memory` | — | — | — | ✓ | ✓ |
| 私有化本地部署（数据不出域） | `private_deploy` | — | — | — | — | ✓ |

### 6.3 门禁插入点（真实生效）
在 `src/action/executor.js` 第 1.5 闸(RBAC)之后插入**第 1.7 闸 `plan_entitlement`**：
```js
if (def.requiresEntitlement?.length) {
  const ents = await resolveEntitlements(ctx.tenantId);
  const missing = def.requiresEntitlement.filter(k => !ents.has(k));
  if (missing.length) return { ok:false, gate:'plan_entitlement', error:`当前套餐未解锁: ${missing.join(',')}，请升级套餐` };
}
```
Action 注册表项声明 `requiresEntitlement`（功能键取自 §6.2 本平台真实能力，禁引 attio/Lightfield 功能名）。**代表打标（本版）**：`ai_agents`（四大智能体调度路径）、`customer_360`（`crm-account-360`）、`decision_autonomy`（决策自治类 action）、`event_automation`（事件自动化派发）、`approval_flow`（`crm-review-gate-approve` 等）、`advanced_reporting`（对账/报表端点）。具体 action 注册表项名在 writing-plans 中按 `src/action/registry.js` 实名校准。其余 action 全量打标留作后续版本。fail-open：解析失败默认放行（调试期）。

### 6.4 页面呈现
`billing.html`「套餐档位对比区」升级为 **功能矩阵**（✓/— + 当前租户档高亮），并显示「切换套餐」CTA（admin 或租户自助改 `tenants.plan`，写经零信任 + decision_id）。

### 6.5 升降级
改 `tenants.plan` → `resolveEntitlements` 即时生效；低→高即时解锁；高→低对已用功能做软降级提示（不强制回收数据）。

## 7. API 设计（复用 applyTenantOverride / tenantQuery 隔离范式）

| 方法 | 路径 | 说明 | 权限 |
|---|---|---|---|
| GET | `/api/billing/plans` | 返回 billing-plans + settings | 登录 |
| GET | `/api/billing/summary?period=&cycle=&tenant=` | 按租户隔离聚合；admin 见全部/按 tenant 过滤 | 租户自助 / admin |
| GET | `/api/billing/usage?period=&cycle=` | token 聚合 + 活跃账号数（raw） | 同上 |
| POST | `/api/billing/statement/issue` | 生成/重算账期账单落库 | admin |
| GET | `/api/billing/reconcile?period=&cycle=` | 跨租户 已出账/已缴/逾期 汇总 + 按租户拆分 | admin |
| GET | `/api/billing/export?format=csv&period=&cycle=&tenant=` | 范围内账单 CSV | admin |
| POST | `/api/billing/pay` | 创建缴费单 → 标记已支付（method/note/txn_ref）；零信任 + decision_id | 租户自助 / admin |

## 8. 页面设计 `billing.html`（attio/Lightfield 风）

复用 `tenantScopeBar.js`（`mountTenantScopeBar` / `tenantQuery` / `tenantMap` / `fetchMe`）。自上而下：

1. **套餐档位对比区**：5 张档位卡（免费/成长/增强/企业/本地旗舰）+ 功能矩阵（✓/—），当前租户档高亮 + 「切换套餐」CTA。
2. **概览卡**：本期 活跃账号数、账号费、合计、待缴（单线按账号计费，无独立 Token 计量线）。
3. **待缴提醒区**：`issued/overdue` 且未付高亮（红=逾期）。
4. **账单明细表**：账期 + cycle 筛选；租户自助仅本租户、admin 见全部 + 租户列；每行「缴费」按钮。
5. **对账视图(admin)**：跨租户 已出账/已缴/逾期 汇总 + 按租户拆分 + **CSV 导出**按钮。
6. **缴费弹窗**：选账单 → 缴费方式（对公/微信/支付宝/其他，仅记录）→ 备注/流水号 → 标记已支付（落 `billing_payment`）。

## 9. 实施任务分解 + 生命契约 §A（双轨）

```contract-yaml
- task: "补 token_accounting 租户维度"
  agent: backend-dev
  skills: [ai-native-action-design, ai-memory-lifecycle]
  memory: [crm-ai-native]
  success: "token_accounting 含 tenant_id 列；新写入带正确租户；既有行回补 'system'；按租户可聚合"
- task: "计费配置化档位+账期+权益(config_store)"
  agent: backend-dev
  skills: [ai-native-action-design]
  memory: [crm-ai-native]
  success: "config_store 含 billing-plans(带 entitlements)/billing-settings(含 cycle/grace_days)；GET /api/billing/plans 返回档位"
- task: "计费表 billing_statement/billing_payment + tenants.plan 启用"
  agent: backend-dev
  skills: [ai-particle-system-design]
  memory: [crm-ai-native]
  success: "两表含 tenant_id/cycle/due_at/method 等列与状态枚举约束；tenants.plan 可写可读"
- task: "计费汇总/逾期/缴费/对账/导出 API"
  agent: backend-dev
  skills: [ai-native-action-design, ai-feedback-loop]
  memory: [crm-ai-native]
  success: "summary 按租户隔离；issued 超 due_at 幂等转 overdue；pay 后 statement.status=paid 且 payment 落库；reconcile/export 返回正确"
- task: "功能门槛门禁(dispatch 第1.7闸+解析器+代表打标)"
  agent: backend-dev
  skills: [ai-native-action-design, ai-capability-audit]
  memory: [crm-ai-native]
  success: "resolveEntitlements 返回租户权益集；dispatch 第1.7闸拦截未授权 action；代表 action(ai_agents/customer_360/decision_autonomy/event_automation/approval_flow/advanced_reporting) 已打标"
- task: "费用页面 billing.html(自助/集中/提醒/对账/缴费/功能矩阵)"
  agent: portal-dev
  skills: [ai-portal-page-generation]
  memory: [crm-ai-native]
  success: "billing.html 渲染；租户自助仅见本租户、admin 见全部+对账；待缴提醒/缴费弹窗(含方式)/CSV 导出/功能矩阵端到端走通"
```

**契约说明**：6 任务由 backend-dev / portal-dev 承接，调用对应 ai-* SKILL、读取 crm-ai-native 项目记忆；成功标准均为可验证的接口/数据判定式。

## 10. 闭环回写（workbench 监测 → 反馈 → 下轮吸收）

| 任务 | Agent | 缺口类型 | 观测 | 期望 | 严重度 | 状态 |
|---|---|---|---|---|---|---|
| （待 writing-plans 执行后由 workbench 回填） | | | | | | |

## 11. 风险与回滚

- **token_accounting 补列**：`DEFAULT 'system'` 保证既有行不报错；旧库该表已存在时 `ALTER` 独立执行，不进 `CREATE TABLE IF NOT EXISTS` 段（遵循 2026-09-02 铁律）。
- **计费写入禁忌**：遵循项目铁律——**绝对禁 DELETE**；逾期/缴费状态用软标记（`status` 枚举）而非删行；`billing_payment` 仅追加。
- **门禁 fail-open**：解析器异常默认放行，避免误杀正常写操作（与既有审计 fail-open 同范式）。
- **租户隔离**：所有计费查询强制 `applyTenantOverride` / `tenantQuery`，防跨租户泄露。
- **回滚**：新增表/列/配置均为可幂等 `IF NOT EXISTS` / `ON CONFLICT`；如需回滚，`tenant_id` 列保留不影响既有查询（默认 'system'）。
