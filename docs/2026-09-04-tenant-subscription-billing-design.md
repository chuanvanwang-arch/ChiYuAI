# 设计文档：租户订阅 · 模块控制与用量 · 实时费用 · 一键升级续费 · 套餐 DB 维护（含 Stripe 支付网关）

> 日期：2026-09-04
> 状态：设计已批准（brainstorming P5）——增量扩展自已批准基线 `docs/2026-09-04-tenant-billing-page-design.md`
> 参考：attio / Lightfield 2026 订阅与用量模型；本项目 tenant 隔离 + 零信任 HITL + 配置化既有范式
> 关键决策（P2 用户确认）：独立订阅表 | 账号+Token 混合计费线 | 接真实支付网关 Stripe + 缴费即开通

## 1. 背景与目标

在既有计费域（已批准 `docs/2026-09-04-tenant-billing-page-design.md`：5 档套餐 + 账号/Token 混合计价 + 功能权益门禁 + billing.html）之上，**增量补齐四缺口**：

1. **订阅周期**：租户当前套餐及用量、到期日、订阅状态（需求 1 前半）。
2. **模块控制/用量**：按模块开关 + 按模块计量（需求 1 后半）。
3. **实时费用 + 一键套餐升级**：实时累计费用、一键升级（需求 1 后半）。
4. **套餐 DB 维护**：套餐档位 CRUD 管理界面（需求 2）。
5. **在线续费与即时开通**：真实支付网关 Stripe Checkout + webhook → 缴费即开通（需求 3）。

## 2. 范围与边界

| 纳入（In） | 排除（Out） |
|---|---|
| 订阅表 + 订阅状态机（续费/升级/到期停服） | 真实第三方网关之外的支付渠道（微信/支付宝本期不接，留 Stripe 适配器扩展位） |
| 模块开关 + 模块用量归因（calls/tokens） | action 级精细控制（仅模块粒度，YAGNI） |
| 实时费用（累计 token + 席位折算） | 发票开具 / 税务合规（本期范围外） |
| 套餐 DB 维护端点 + admin 维护页 | 营销优惠 / 折扣码 / 发票 |
| Stripe Checkout + webhook 即时开通（测试模式驱动验证） | 订阅计费与既有「面向客户的销售回款」（CRM_INVOICE/CRM_PAYMENT_RECORD）解耦，不混用 |

## 3. 已确认设计决策

1. **订阅模型**：独立订阅表 `crm.tenant_subscription`（每租户一段订阅履历，append-only 可追溯）。
2. **计费线**：账号费（席位）+ Token 超量费（套餐内含额，超量按千 token 计）混合线，沿用已批准设计 + seed。
3. **开通机制**：接真实支付网关 **Stripe**（Checkout Session + webhook `checkout.session.completed`），**缴费即开通**（状态机自动化）。
4. **模块控制**：模块粒度开关（对齐权益键目录 §6.2），不做 action 级精细控制。
5. **套餐维护**：admin 可增删改套餐（禁物理删除，启停用软标记），配置化驱动（禁硬编码）。

## 4. 数据模型

### 4.1 新增 `crm.tenant_subscription`（订阅表）

```sql
CREATE TABLE IF NOT EXISTS crm.tenant_subscription (
  id             BIGSERIAL PRIMARY KEY,
  tenant_id      TEXT NOT NULL,                     -- 与 crm.tenants.tenant_id 同源
  plan_id        TEXT NOT NULL,                     -- 订阅档位（billing-plans[].plan_id）
  status         TEXT NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active','pending','expired','canceled','grace')),
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),-- 本订阅开始（开通/上次续费）
  expires_at     TIMESTAMPTZ NOT NULL,              -- 到期日（续费后延长至）
  grace_until    TIMESTAMPTZ,                       -- 宽限截止（过期后 grace 期免停服）
  payment_ref    BIGINT REFERENCES crm.billing_payment(id), -- 最近缴费关联
  upgraded_from  TEXT,                              -- 升级前档位（升级履历）
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, plan_id, started_at)           -- 每租户每档一段订阅史，append-only
);
CREATE INDEX IF NOT EXISTS idx_tenant_subscription_tenant
  ON crm.tenant_subscription(tenant_id, status, expires_at);
```

### 4.2 新增 `crm.module_usage`（模块控制 + 按模块计量）

```sql
CREATE TABLE IF NOT EXISTS crm.module_usage (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     TEXT NOT NULL DEFAULT 'system',
  module        TEXT NOT NULL,                      -- 模块键（对齐 §6.2 权益键）
  enabled       BOOLEAN NOT NULL DEFAULT true,      -- 模块开关（dispatch 闸消费）
  calls         INT NOT NULL DEFAULT 0,             -- 本账期调用计数（增量累计）
  tokens_in     BIGINT NOT NULL DEFAULT 0,          -- 本账期 token 用量（按模块归因）
  tokens_out    BIGINT NOT NULL DEFAULT 0,
  period        TEXT NOT NULL DEFAULT '2026-09',    -- 账期粒度（YYYY-MM；跨期自动重开）
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, module, period)
);
```

### 4.3 `token_accounting` 补租户维度（纳入既有缺口）

`db/migrate.js:25` 已挂 `migration-billing-token-tenant.sql`，但 `db/schema.sql`（单一事实源）未同步该 ALTER。本期在 schema.sql 同步：

```sql
ALTER TABLE crm.token_accounting
  ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'system';
CREATE INDEX IF NOT EXISTS idx_crm_token_accounting_tenant
  ON crm.token_accounting(tenant_id, created_at);
```

既有写入点 `src/alerts/tokenAccounting.js recordTokens` 已透传 `tenantId`（plan 已含此实现）。

### 4.4 配置扩展（config_store，配置化禁硬编码）

`config_store['billing-settings']` 增补 Stripe 相关（sk/live 凭据占位 + 成功/取消回跳 URL）：
```json
{ "cycle":"monthly", "default_plan":"free", "currency":"CNY", "grace_days":15,
  "stripe":{"secret_key":"","webhook_secret":"","success_url":"","cancel_url":""} }
```
`billing-plans` 档位维持（价格字段即升级/续费计费单价）。

## 5. 计费逻辑：订阅状态机 + 实时费用

### 5.1 订阅状态机

```
                  Stripe webhook 缴费成功
  ┌──────────┐   checkout.session.completed    ┌───────────┐
  │ request  │ ───────────────────────────────► │  active   │ ── 续费=延长 expires_at
  │ create   │                                  └─────┬─────┤ ── 升级=切换 plan + 记录 upgraded_from
  └──────────┘                                        │
        │ payment pending/failed                      │ expires_at 过
        ▼                                              ▼
   ┌──────────┐                                 ┌───────────┐
   │ pending  │ ── 支付确认后 ─────────────────► │  grace    │ ── grace 过 → 停服（plan 回落 free）
   └──────────┘           主动续费               └───────────┘
```

- **续费**：webhook 成功 → 当前订阅行 `expires_at += 周期`，`payment_ref` 关联缴费。
- **升级**：新档缴费成功 → 新建订阅行（`upgraded_from=旧档`）+ `tenants.plan` 即时切换 → 权益即时生效（低→高立即解锁，已有 §6.5 既有行为）。
- **到期停服**：`expires_at` 过且 `grace_until` 过 → `tenants.plan` 回落 `default_plan(free)` → `resolveEntitlements` 返回 free 权益 → **dispatch 第 1.7 闸天然拦截付费功能，无需新停服逻辑**（软降级不回收数据）。

### 5.2 实时费用（需求 1「租户实时费用」）

`computeLiveCost(tenantId)`：当前周期 `SUM(token_accounting.tokens_in+out)`（超量计费） + 当前席位 `COUNT(crm_users.status='active')` × 席位单价，复用 `computeBilling` 纯函数（入参=实时聚合值）。实时费用 = 截至当前应计费用，页面实时展示。

### 5.3 模块用量归因

`recordTokens` 调用处透传 `ctx.module`（intake-router / quote-engine / followup-agent / review-gate + 决策自治 / 事件自动化），按 `(tenant_id, module, period)` 累计 `calls/tokens_in/tokens_out`（`module_usage` `ON CONFLICT DO UPDATE`）。未带 module 走 `core`（核心 CRM）。

## 6. 套餐 DB 维护（需求 2）

- 既有 `config_store['billing-plans']` JSONB 为配置存储；新增 **`POST /api/admin/billing-plans`**（admin/sysadmin）整档 CRUD（新增/改价/改权益/启停软标记 `enabled`），`ON CONFLICT DO UPDATE` 幂等重播（复用 `seed-billing-config.sql` 同构）。
- `POST /api/admin/billing-settings`：联动维护 `billing-settings`（cycle/grace_days/currency/stripe 凭据）。
- **维护页 `admin-billing-console.html`**：套餐表 + 编辑弹窗 + 保存即生效。
- 铁律：绝对禁物理 DELETE（套餐停用=`enabled:false` 软标记，行保留）。

## 7. API 设计（新增/扩展）

| 方法 | 路径 | 说明 | 权限 |
|---|---|---|---|
| GET | `/api/billing/subscription` | 当前订阅（档/到期日/状态/剩余天数） | 租户自助 |
| POST | `/api/billing/subscribe` | 创建订阅/续费/升级 → 生成 Stripe Checkout Session | 租户自助（admin 可代） |
| POST | `/api/billing/stripe/webhook` | Stripe 回调：缴费成功 → 订阅状态机 + 即时开通 | Stripe 签名验签 |
| GET | `/api/billing/live-cost` | 实时费用（累计 token/席位/应计） | 租户自助 |
| GET | `/api/billing/module-usage` | 模块用量（calls/tokens） + 开关 | 自助读 / admin 写 |
| POST | `/api/admin/billing-plans` | 套餐档位 CRUD（软删除） | admin/sysadmin |
| POST | `/api/admin/billing-settings` | 计费设置维护（含 stripe 凭据） | admin/sysadmin |
| GET | `/api/billing/usage` | （扩展）token 聚合 + 模块拆分 | 自助 / admin |

- 写操作统一经 **决策第 0 闸**（decisio_id 强制，零信任 HITL）；租户隔离经 `applyTenantOverride` / `scopeTenant`（既有范式），防跨租户泄露。

## 8. 页面设计

### 8.1 `billing.html` 扩展（attio/Lightfield 风，复用 tenantScopeBar）

1. **订阅卡升级**：当前套餐 + 到期日 + 剩余天数 + 续费/升级按钮（到期前 30 天显示续费 CTA）。
2. **实时费用卡**：累计用量 / 应计费用 / 超量明细。
3. **模块用量与开关卡**：每模块 calls/tokens 进度条 + 开关（admin 可切）。
4. **一键升级弹窗**：档位选择 → 金额展示 → Stripe Checkout 跳转。
5. **一键续费按钮**：调用 subscribe（续费模式）→ Checkout。

### 8.2 `admin-billing-console.html` 新建（admin）

套餐维护 + 订阅全景（各租户订阅/到期/状态）+ 出账入口。

## 9. 实施任务 + 生命契约 §A（双轨）

```contract-yaml
- task: "订阅表+module_usage+token_accounting 补列(DDL)"
  agent: backend-dev
  skills: [ai-particle-system-design, ai-native-action-design]
  memory: [crm-ai-native]
  success: "tenant_subscription/module_usage 建表幂等可重播；token_accounting 含 tenant_id；schema.sql 同步"
- task: "订阅状态机(续费/升级/到期停服)+实时费用+模块归因"
  agent: backend-dev
  skills: [ai-native-action-design, ai-feedback-loop]
  memory: [crm-ai-native]
  success: "续费缴费后 expires_at 延长/plan 切换；实时费用=累计token+席位费；模块用量按(tenant,module,period)累计"
- task: "Stripe 网关适配器(Checkout+webhook)+subscribe API"
  agent: backend-dev
  skills: [ai-native-action-design]
  memory: [crm-ai-native]
  success: "POST /api/billing/subscribe 生成 Stripe Session；webhook 验签后触发状态机；测试模式可走通"
- task: "套餐 DB 维护(admin-billing-plans CRUD)+订阅/用量/实时费用 API"
  agent: backend-dev
  skills: [ai-native-action-design, ai-event-driven-evolution]
  memory: [crm-ai-native]
  success: "admin 可增删改套餐(禁物理删,启停软标记)；订阅/usage/live-cost 端点按租户隔离返回正确"
- task: "billing.html 扩展+admin-billing-console.html"
  agent: portal-dev
  skills: [ai-portal-page-generation]
  memory: [crm-ai-native]
  success: "billing.html 含订阅高亮区/实时费用卡/模块开关/升级续费弹窗端到端；console 页套餐维护+订阅全景走通"
- task: "测试+契约有效+回归"
  agent: backend-dev
  skills: [ai-feedback-loop, ai-capability-audit]
  memory: [crm-ai-native]
  success: "新增单测全绿；validate-contract.mjs 通过；计费域既有测试不回归"
```

**契约说明**：6 任务经 backend-dev / portal-dev 承接，各带可验证成功标准；SKILL 均取自本平台已落地能力。

## 10. 闭环回写（workbench 监测 → 反馈 → 下轮吸收）

| 任务 | Agent | 缺口类型 | 观测 | 期望 | 严重度 | 状态 |
|---|---|---|---|---|---|---|
| （待 writing-plans 执行后由 workbench 回填） | | | | | | |

## 11. 风险与回滚

- **Stripe 中国大陆不可用**：需境外主体方能真实验证；本期用 `sk_test` 测试模式驱动验证 Checkout 闭环（Stripe 提供测试卡 `4242 4242 4242 4242`），生产凭据配置化（`billing-settings.stripe`），上线前需境外主体资质或暂以平台内部结算兜底（适配器接口保留）。
- **订阅表 append-only**：绝对禁 DELETE（禁物理删）；升级/续费=新增行或状态机流转，历史可追溯。
- **token_accounting 补列**：`DEFAULT 'system'` 保证既有行不报错；`schema.sql` 同步与迁移同源，双写幂等。
- **模块开关误关**：fail-open——解析异常默认放行，避免误杀正常写操作（与既有审计 fail-open 同范式）。
- **webhook 安全**：强制验签（`webhook_secret`），拒签即 400；幂等（`ON CONFLICT`），重复事件不双倍延长。
- **回滚**：新增表/列/配置均 `IF NOT EXISTS` / `ON CONFLICT` 幂等，可安全重播；订阅表不落既有业务路径，风险隔离。
