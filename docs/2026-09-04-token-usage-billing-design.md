# 设计文档：账单页 Token 额度/使用明细（租户→账号→动作，端到端真实计量）

> 日期：2026-09-04
> 状态：设计已批准（brainstorming P5，用户「同意」），待 P7 契约自检 → P9 移交 writing-plans
> 关联：`docs/2026-09-04-tenant-billing-page-design.md`、`db/migration-billing-token-tenant.sql`、`src/billing/billingService.js`、`src/alerts/tokenAccounting.js`、`src/llm/client.js`

## 1. 背景与目标

前一轮审计确认：免费版 `included_tokens:50000`（`db/seed-billing-config.sql:19`）**仅用于算费公式，不构成任何拦截/限流**；且 `token_accounting` 实际恒为 0（写通道 `recordTokens` 读 `ctx.tokensIn ?? 0`，全代码库无人赋值），导致账单页"Token 用量"全为 0、且无"额度 vs 已用 vs 剩余"对比、无按账号/动作下钻。

本设计目标：在账单页新增「**Token 额度与使用明细**」专区，做到：
- **额度 / 已用 / 剩余 / 超量费** 清晰可视；
- **按 租户 → 账号 → 动作 三级下钻**，谁烧了多少一目了然；
- **底层真实计量补齐**：LLM/embedding 调用真实 token 用量回写 `token_accounting`，`actor` 关联真实账号（非 `'system'`）；
- 租户隔离与既有 `applyTenantOverride` / `scopeTenant` 范式一致，确保收费清晰、不可越权。

## 2. 范围与边界

| 纳入（In） | 排除（Out） |
|---|---|
| LLM/embedding 封装层统一真实 token 埋点（含 usage 解析、tenant_id+actor 回写） | 超量后硬封顶/限流闸门（仅展示与计费，拦截为后续独立设计） |
| `billingService` 三级聚合查询（quota / byAccount / byAction） | 历史数据回填（迁移前 `actor='system'` 行按"未归因"单列） |
| `GET /api/billing/token-usage` 端点（租户隔离，admin 可指定租户） | 跨租户汇总对比看板（仅本租户自助 + admin 集中） |
| 账单页 `billing.html` 新增明细专区（额度卡 + 账号表 + 动作表） | 计费模型/档位价格变更（沿用既有 config_store） |

## 3. 已确认设计决策（brainstorming P2/P3）

1. **范围**：端到端全做（展示层 + 底层真实计量一并补全）。
2. **下钻粒度**：租户 → 账号 → 动作，三级。
3. **计量采集点**：LLM 封装层统一埋点（`src/llm/client.js` 的 `callChat`），一处覆盖全链路；embedding 同理。

## 4. 现状差距分析（evidence 锚点）

- `src/billing/pricing.js:27`：`included_tokens` 仅用于超量费计算，无拦截语义。
- `src/action/executor.js:201`：`recordTokens` 读 `ctx.tokensIn ?? 0 / ctx.tokensOut ?? 0`，**全代码库无赋值点** → 恒 0。
- `src/alerts/tokenAccounting.js:25`：`actor` 为自由文本，建表注释为"人/Agent"，未关联到 `crm_users.username/user_id`。
- `src/llm/client.js:131 callChat`：解析 `j?.choices?.[0]?.message?.content` 但**丢弃 `j.usage`**（prompt/completion tokens）。
- `db/migration-billing-token-tenant.sql`：已补 `token_accounting.tenant_id` 并注册 `db/migrate.js:25` → 按租户聚合已可支撑。
- `src/billing/billingService.js:19 tokenUsage()`：已按 `tenant_id + to_char(created_at,'YYYY-MM')` 聚合，是叠加三级聚合的基座。

## 5. 详细设计

### 5.1 计量采集（LLM/embedding 封装层统一埋点）

- `src/llm/client.js`：
  - `callChat(cfg, messages, opts)` 增加 `opts.metering = { tenantId, actor, action }`；解析响应后从 `j.usage` 取 `prompt_tokens / completion_tokens`，调用 `recordTokens({ actor, action, tokensIn: prompt_tokens, tokensOut: completion_tokens, source:'llm', tenantId })`。
  - `getLlmThink` / `getLlmJson` 入参透传 `metering`；调用方在 `agentLoop`/action 执行处注入 `tenantId`（来自 ctx）+ `actor`（来自 ctx.actor 的真实账号 username，非 `'system'`）+ `action`（如 `crm-deal-advance`）。
  - 计量失败 `fail-open`（沿用 `recordTokens` try/catch 不阻断主写）。
- `src/llm/embeddingClient.js`：embedding 调用同样携带 `metering` 并回写（embedding 烧 token，需纳入）。
- 既有 `executor.js:201` 的 `recordTokens` 保留为兜底（写 Action 执行成功处的现有计量），与新埋点互补、不冲突；但明确 `actor` 必须来自真实账号上下文。

### 5.2 聚合与查询层（`src/billing/billingService.js`）

新增三个函数（均按 `tenant_id + 账期` 收敛，复用 `tokenUsage` 模式）：
- `tokenQuota(tenantId, period)` → `{ plan_id, plan_name, included_tokens, used_total, remaining, overage_fee, unlimited }`（`included_tokens === -1` → `unlimited=true, remaining=null`；其余 `remaining = included_tokens - used_total`；超量费经 `computeBilling(plan, used_in, used_out, 0)` 取 `token_fee`）。
- `tokenByAccount(tenantId, period)` → `[{ actor, username, tokens_in, tokens_out, total, share_pct, is_unattributed }]`，按 `actor` 聚合、按 `total` 降序；`actor` 无法匹配 `crm_users` 的标记为 `is_unattributed`。
- `tokenByAction(tenantId, period)` → `[{ action, tokens_in, tokens_out, total, share_pct }]`，按 `action` 聚合 TopN。

### 5.3 计费路由（`src/http/billingRoutes.js`）

新增 `GET /api/billing/token-usage`：
- 鉴权 `resolveMe`；`scope = applyTenantOverride(req, me)`（自助=本租户；admin/sysadmin 可 `?tenant=` 指定或 `*` 全量）。
- `period = req.query.period || currentPeriod()`。
- 返回 `{ period, scope, quota, byAccount, byAction }`。
- 租户隔离与既有端点一致；admin 越权收窄由 `applyTenantOverride` 强制。

### 5.4 账单页展示（`src/web/billing.html`）

新增 section「Token 额度与使用明细」：
- 顶部额度卡：当前租户 `included_tokens` / 已用 / 剩余（进度条可视化剩余比例）/ 超量费；`unlimited` 档显示"不限 Token"。
- 表格1「按账号」：账号 · in · out · 合计 · 占比；未归因行单列。
- 表格2「按动作」：动作 · in · out · 合计 · 占比。
- 复用现有 `api()` + `tenantQuery()`；admin 经 `mountTenantScopeBar` 切租户作用域时数据随动（`refresh` 触发重载）。
- 全部走现有 `crm-input/crm-button` 组件，满足 ui-lint 架构约束。

## 6. 数据模型与字段

`token_accounting`（已含 `tenant_id` 迁移列）：`id, actor, action, tokens_in, tokens_out, source, decision_id, tenant_id, created_at`。
- 新增约定：`actor` 写入真实账号标识（`crm_users.username` 或 `user_id`），使 `tokenByAccount` 可归因；存量 `actor='system'` 行由 `is_unattributed` 兜底。
- 不改表结构（无 DDL），仅修正写入语义与采集点。

## 7. 接口契约

```
GET /api/billing/token-usage?period=YYYY-MM[&tenant=xxx]
→ 200 { period, scope, quota:{plan_id,plan_name,included_tokens,used_total,remaining,overage_fee,unlimited},
         byAccount:[{actor,username,tokens_in,tokens_out,total,share_pct,is_unattributed}],
         byAction:[{action,tokens_in,tokens_out,total,share_pct}] }
```
- 自助用户：`scope` 恒为本租户，看不到其他租户。
- admin：`scope` 可为指定租户或 `*`；`*` 时 `byAccount/byAction` 按 `scope` 内各租户分别聚合（或返回聚合全集，由前端分页）。

## 8. 安全与隔离

- 租户隔离复用 `applyTenantOverride` / `scopeTenant`，与 `billingRoutes.js` 既有端点同范式，无新增越权面。
- 计量 `fail-open`：LLM/embedding 调用失败或计量写入失败均不阻断主业务。
- 不引入 DELETE / 不改动既有 `token_accounting` 表结构（仅语义修正）。

## 9. 测试与验收

- 单测（`src/llm/client.test.js` 或新增 `test/billing/tokenUsage.test.js`）：
  - `callChat` 在 mock 响应含 `usage` 时断言 `recordTokens` 被调用且 `tokensIn>0` + `tenantId` 正确。
  - `tokenQuota` 对 `included_tokens=-1` 返回 `unlimited`；对 50000 配额与已用计算 `remaining` 正确。
  - `tokenByAccount` / `tokenByAction` 聚合与占比正确；`actor='system'` 标 `is_unattributed`。
  - 路由：`/api/billing/token-usage` 自助仅本租户、admin 可指定租户。
- 验收：本地起服务，触发一次真实 LLM 调用 → `token_accounting` 出现 `tenant_id`+账号+`tokens_in>0` 行 → 账单页明细专区显示非零额度/已用/剩余与账号/动作下钻。

## 10. 闭环回写（§B）

| 任务 | 已观测缺口 | 建议（approval-gated） |
|---|---|---|
| LLM 埋点 | 此前 `j.usage` 被丢弃、`ctx.tokens*` 恒 0 | 本设计统一在 `callChat` 采集 |
| 账号归因 | `actor` 自由文本未关联账号 | 明确写入真实账号标识 |

## 11. Living Contract（§A 双轨）

```contract-yaml
- task: "LLM/embedding 封装层真实 Token 埋点回写"
  agent: crm-copilot
  skills: [ai-native-action-design]
  memory: [crm-copilot]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "callChat 解析 j.usage 并写入 token_accounting(tenant_id, actor=账号, action)；单测断言 tenant_id 正确且 tokens_in>0"
- task: "billingService 三级 Token 聚合查询"
  agent: crm-copilot
  skills: [ai-native-action-design]
  memory: [crm-copilot]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "tokenQuota/tokenByAccount/tokenByAction 三函数存在且按 tenant_id+账期聚合，返回 remaining 与 share_pct"
- task: "新增 /api/billing/token-usage 端点（租户隔离）"
  agent: crm-copilot
  skills: [ai-native-action-design]
  memory: [crm-copilot]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "自助用户仅见本租户、admin 可指定租户；返回 {quota,byAccount,byAction} 结构"
- task: "账单页 Token 额度/使用明细专区（租户→账号→动作）"
  agent: crm-copilot
  skills: [ai-portal-page-generation]
  memory: [crm-copilot]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "billing.html 渲染额度卡+账号表+动作表；admin 切租户作用域数据随动"
```

**契约说明：** 四个任务均由 `crm-copilot` 承接，调用 `ai-native-action-design` / `ai-portal-page-generation` SKILL、读取 `crm-copilot` 记忆（L1，≤2 跳）；成功标准分别为——LLM 封装层真实回写带租户与账号的 token 计量、三级聚合查询返回剩余与占比、租户隔离的 token-usage 端点、账单页三级明细专区可随租户作用域联动。
