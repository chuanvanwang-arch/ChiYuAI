# 套餐驱动强制闸门设计（用户数 / 功能模块 / Token 超额）

> 基线对话：用户要求"超量后硬封顶/限流闸门"包含三块：① 免费租户用户数上限 ② 功能模块限制 ③ Token 超额控制；且"根据套餐内容来控制"（配置驱动、禁硬编码）。
> 状态：已批准（2026-09-04）。本文件为唯一设计基线，实施计划见 `docs/superpowers/plans/2026-09-04-plan-gated-quota.md`。

## 1. 现状盘点（evidence）

| 控制项 | 现状 | 落点 |
|---|---|---|
| 功能模块限制 | ✅ Action 派发层已落地（第 1.7 闸 `plan_entitlement`） | `src/action/executor.js:91` 读 `resolveEntitlements(tenantId)`；`src/billing/entitlements.js`；`src/action/seed-actions.js` 已给 13+ 付费 action 打 `requiresEntitlement`（crm-account-360→customer_360、agent-dispatch→ai_agents、decision-disposition→decision_autonomy、crm-approval-*→approval_flow 等）。**缺口：仅拦 Action，未拦前端导航入口。** |
| 免费租户用户数上限 | ❌ 未落地 | 用户创建：`src/portal/userManagement.js:160` `createUser`、`src/http/selfRegister.js:108`、`src/http/tenantRouter.js:34`（建租户首 admin，应放行）均不查席位。 |
| Token 超额硬封顶/限流 | ❌ 未落地 | `src/llm/client.js:135 callChat` 仅计量回写（`recordTokens`），无拦截。 |

套餐真相源：`config_store['billing-plans']` 每档含 `included_seats`、`seat_unit_price`、`included_tokens`、`token_overage_unit_price`、`entitlements`（功能白名单）。本轮新增 `token_overage_mode`、`token_hard_cap` 两字段。

## 2. 总体原则

- **唯一真相源**：所有阈值与行为来自 `billing-plans` 配置，禁硬编码；改档即生效（上一轮已验证 `resolveEntitlements` 即时读取）。
- **fail-closed vs fail-open**：
  - 席位/Tokens 超额**硬封顶 = fail-closed**（明确拒绝，防滥用）。
  - 权益解析异常 = fail-open（不误杀主链路，由闸二次判定）。
- **复用既有**：席位闸复用 `getPlan`；Token 闸复用上一轮 `tokenQuota()` 聚合；功能导航闸复用 `resolveEntitlements`。
- **YAGNI**：本轮不做 rate-limit token-bucket（按选择走"硬封顶/计费"模式）。

## 3. 三处改动

### 3.1 席位硬封顶（新建 `src/billing/seatPolicy.js`）

`checkSeatLimit(tenantId)`：
1. `plan = getPlan(tenantId)`（缺省回退 DEFAULT_PLAN）。
2. 统计 `SELECT count(*) FROM crm.crm_users WHERE tenant_id=$1 AND enabled IS TRUE`。
3. 行为推导：
   - `included_seats === -1` → `mode:'unlimited'`（本地旗舰版）。
   - `seat_unit_price > 0` → `mode:'bill'`（付费档按席位计费，不封顶）。
   - 否则（`seat_unit_price<=0 && included_seats>=0`）→ `mode:'block'`：若 `used >= included_seats` 拒绝新增。
4. 返回 `{ ok, mode, included, used, remaining }`（`remaining = unlimited?null:max(0,included-used)`）。

**注入点（仅"新增成员"两处，建租户首 admin 放行）：**
- `src/http/selfRegister.js`：`resolveTenantByCompany` 之后、INSERT 用户之前调 `checkSeatLimit(tenantId)`；`mode==='block' && !ok` → 返回 `{ ok:false, status:402, error:'当前套餐席位已满（used/included），请升级套餐' }`。
- `src/portal/userManagement.js:160` `createUser` dep 内、INSERT 之前调同一检查；超额 → 抛 `SeatLimitError`（由端点转 402）。

### 3.2 Token 超额闸门（新建 `src/billing/quotaGate.js`）

`enforceTokenQuota(tenantId, period)`：
1. `plan = getPlan(tenantId)`；`q = tokenQuota(tenantId, period)`（上一轮已建，返回 `used_total`）。
2. `mode = plan.token_overage_mode || 'bill'`；`cap = plan.token_hard_cap ?? (mode==='bill' ? plan.included_tokens*3 : plan.included_tokens)`。
3. 判定：
   - `mode==='block' && q.used_total >= plan.included_tokens` → 抛 `TokenQuotaError('额度已用完，请升级套餐')`。
   - `mode==='bill' && q.used_total >= cap` → 抛 `TokenQuotaError('本月用量已达安全上限，请升级套餐或购买加量包')`。
   - 否则放行。

**预检落点（已有 metering 上下文）：**
- `src/llm/client.js:135 callChat`：在 `fetch` 之前插入 `if (metering) await enforceTokenQuota(metering.tenantId, currentPeriod())`；
  `makeThink`（line 185）catch 中**识别 `TokenQuotaError` 并透传为 `{ action:null, reasoning:'额度已用完', degraded:true, quotaExceeded:true }`**，让 agent 返回"额度已用完"话术（不再一刀切降级吞掉）。
- `src/llm/embeddingClient.js embed`：同理在 fetch 前预检 + 透传 `TokenQuotaError`（其现有 try/catch 为 fail-open，需对 quota 错误单独透传）。
- 任何直接调 LLM 的 API 路由捕获 `TokenQuotaError` → 返回 `402 { error }`。

> 性能注记：`tokenQuota` 每次调用多一次聚合查询；MVP 阶段 LLM 调用频率可接受。后续可加短 TTL 缓存（非本轮必做）。

### 3.3 前端导航门禁（扩展第 1.7 闸到 UI）

- `src/portal/layoutMenu.js`：菜单项增加可选 `requiresEntitlement: string[]`；`menuFor(role, ents)` 仅保留 `requiresEntitlement ⊆ ents` 的项（无该字段=全员可见）。示例标注：
  - 洞察→客户 360 → `['customer_360']`；决策监控 → `['decision_autonomy']`；审批流 → `['approval_flow']`；AI 代理 → `['ai_agents']`；高级报表 → `['advanced_reporting']`。
- 新增 `GET /api/billing/entitlements`（复用 `resolveEntitlements`）→ `{ plan_id, plan_name, entitlements:[...] }`。
- 前端 `layout` 初始化拉取该端点，按权益集过滤菜单；`billing.html` 增加"当前套餐已解锁 / 未解锁模块"对照区（复用既有 `ENT_LABELS` 映射）。

### 3.4 配置种子更新（`db/seed-billing-config.sql`）

每档补两字段（幂等重播两库）：
- `token_overage_mode`：`free='block'`、`starter/pro/enterprise='bill'`、`local_flagship='bill'`。
- `token_hard_cap`：`free=null`（用 included_tokens）；付费档显式 = `included_tokens*3`（starter 600000 / pro 3000000 / enterprise 15000000）；`local_flagship=null`（不限）。

## 4. Living Contract（双轨）

```contract-yaml
- task: "配置种子新增 token_overage_mode / token_hard_cap"
  agent: crm-copilot
  skills: [ai-native-action-design]
  memory: [crm-copilot]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "billing-plans 每档含 token_overage_mode+token_hard_cap；幂等重播两库后 GET /api/billing/plans 返回新字段"
- task: "席位硬封顶 seatPolicy + 注入 selfRegister/userManagement"
  agent: crm-copilot
  skills: [ai-native-action-design]
  memory: [crm-copilot]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "免费租户第4用户创建被拒(402)；付费租户(seat_unit_price>0)不封顶；-1 不限；单测覆盖三态"
- task: "Token 超额闸门 quotaGate + callChat/embed 预检 + 错误透传"
  agent: crm-copilot
  skills: [ai-ontology-vector-build]
  memory: [crm-copilot]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "免费租户用量>=included_tokens 时 callChat 抛 TokenQuotaError 且不被 swallow；agent 返回额度用尽话术；单测断言闸拦截"
- task: "前端导航门禁：layoutMenu requiresEntitlement + /api/billing/entitlements + 前端过滤"
  agent: crm-copilot
  skills: [ai-portal-page-generation]
  memory: [crm-copilot]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "免费租户看不到 customer_360/决策监控 等菜单项；/api/billing/entitlements 返回权益集；billing.html 展示已解锁对照"
```

**契约说明：** 4 任务均由 `crm-copilot` 承接，分别调用 `ai-native-action-design`（配置/席位/种子）、`ai-ontology-vector-build`（Token 计量闸）、`ai-portal-page-generation`（前端导航）；成功标准以"免费租户被拒/隐藏、付费租户放行、错误不被吞"为判定式。

## 5. 关键取舍（已固化）

- 席位闸只在"新增成员"处拦（selfRegister + userManagement）；建租户首 admin 放行（其本身是首个席位）。
- Token 闸在 callChat/embed 单一出口预检，复用上一轮 `tokenQuota` 聚合，不重复造计量。
- 前端门禁不重复造授权逻辑，复用 `resolveEntitlements`，仅多一层 UI 过滤 + 新端点。
- 不做 rate-limit token-bucket（按选择走"硬封顶/计费"模式）。

## 6. 闭环回写

| 任务 | 代理 | gap_type | 观察 | 期望 | 严重度 |
|---|---|---|---|---|---|
| （待执行回填） | | | | | |
