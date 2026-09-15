# 外部数据接入（启信慧眼 / 新榜 / 租户自有系统）设计方案

> 状态：设计稿 v1（基于 2026-09-14 brainstorming 收敛结论，待批准移交 writing-plans）
> 日期：2026-09-14
> 定位：**获客模块（线索自主发现引擎 v8.1，`docs/2026-09-10-lead-discovery-design.md`）的数据源子层扩展**，非独立模块。
> 结论先行：90% 工作是对 `discovery`/`connector` 既有框架的复用与泛化；唯一真实新增面 = 2 个付费 adapter + 3 个通用 adapter + per-tenant 注册 + 凭据保险库 + `social_content` 信号键。**不新增粒子类型、不改业务域模型、不新增 Agent、不新增 SKILL、不新增决策场景（decision_scenario）。**

---

## 0. 一句话定位与衔接关系

外部数据接入 = 给「获客模块（发现引擎）」**接上更多数据源 + 让租户自有系统也能当数据源 / 回写目标**。

- 启信慧眼、新榜 = 两个新的 **Provider Adapter**，注册进既有 `providerRegistry`，被 `discovery-run` / `discoveryOrchestrator` 自动消费（与 `gaode`/`tender` 同一范式）。
- 租户自有系统（CLI/MCP/API） = 三个 **通用 adapter**（`generic-rest`/`generic-mcp`/`generic-cli`），按 `config_store` 里的实例描述符（endpoint/auth/field_map）运行时实例化，零租户代码。
- 强购买信号（融资/招聘/招投标/社媒）命中后的「建档 + 主动生成线索」= 复用既有 `monitorAccount` 闭环 + `conn-tender-push` 的 `createLeadFromTender` 模式。

---

## 1. 与获客模块（线索发现引擎 v8.1）的精确衔接

| 获客连续动作（你描述的） | 发现引擎承载层 | 外部数据接入落点 |
|---|---|---|
| 按条件筛选合格客户 | ① ICP `decision_scenario` + `named-account-targets` 分级 | 外部信号喂入 ① 评分 |
| 信息补全与查重 | ② `ontologySync` 本体优先富集 + `dedupResolver` | adapter 只补本体推断不出的缺口字段 |
| 数据查找 | `discovery-run` 轮询 provider | 启信慧眼 / 新榜 / 租户系统 = 新增 provider |
| 线索筛选 | ① 信号命中 + ③ 九标尺 `intent_score` | 融资/招聘/招投标/社媒 = **复用 `discoveryRules.js` 既有 signals 权重键** |
| 个性化撰写 | C2 Claygent + playbooks `action` 段 | 外部信号 → `why_narrative` 痛点钩子（非独立模块） |
| 流程触发 | 事件总线（signal→`decision-enrich`→action） | 外部推送信号直接进总线触发 |
| 系统同步 | ④ `data-*` MCP upsert + `duplicateCriteria` 去重 | 租户系统经 generic adapter **回写**，复用同一通道 |

**框架锚点（既有，已核实）**：
- 适配器统一接口：`src/connectors/discovery/providerAdapter.js`（`enrich(entity, fields, ctx) -> { [field]: { value, confidence, cost, provider, ts } }`）。
- 注册表：`src/connectors/discovery/providerRegistry.js`（`registerProvider` / `resolveAdapters` / `loadAdapters({tenantId})`），全局 `REGISTRY` 为模块级 `Map`。
- 出厂注册触发：`src/connectors/discovery/builtinAdapters.js`（`registerBuiltinAdapters()` 由 `discoveryOrchestrator.js:46` 显式调用，避免 REGISTRY 恒空）。
- 编排主循环：`src/agent/discoveryOrchestrator.js`（`runDiscovery`：`resolveAdapters(rules,{allowIds})` → `runWaterfall` → 写 `payload.enrichment`/`discovery` → 生成 `CRM_DEAL(stage:'S0')`）。
- 持续监控：`src/connectors/discovery/monitorAccount.js`（信号/定时 → `rescore` → `appendMemory` → `update payload.discovery`）。
- 写通道范式：`src/connectors/connectorActions.js`（`autoDecision:true` + `autoWeakEdge:'sourcedFrom'` + 禁 DELETE + 低置信 `confirm:'stage2'`）。
- 配置唯一事实源：`src/config/discoveryRules.js`（`DEFAULT_DISCOVERY_RULES` + `mergeDiscoveryRules` + `mergedDiscoveryRules({tenantId})`，per-tenant 懒克隆）。

---

## 2. 设计原则与铁律（不可逾越）

1. **§10 硬约束**：不新增粒子类型、不改业务域模型。外部数据只落 `CRM_ACCOUNT.payload.{enrichment,discovery}` + `sourcedFrom` 弱边 + 账户 append-only 记忆。
2. **配置驱动差异化**：所有源实例、信号权重、拉取频率、强信号阈值 100% 后台化，禁硬编码字面量。
3. **禁 DELETE**：连接器只增改，不删粒子/边/记忆。
4. **写操作必经第 0 闸**：强信号主动生成线索 = 写动作，必须 `autoDecision:true`（过决策/HITL），低置信走 `confirm:'stage2'`，绝不冒充人工。
5. **多租户隔离**：付费源按租户独立授权 + 独立密钥；租户自有系统实例按 `tenant_id` 隔离注册，跨租户读取返回空。
6. **复用优先**：新 adapter 照搬 `gaode.js`/`tender.js` 范式；强信号复用 `conn-tender-push` 的 `createLeadFromTender`；定时拉取复用 `timers.js` 的 `listActiveTenants` 循环。
7. **MCP 不死胡同**：任何新 write action 若 `autoDecision:true`，必须配 `deferDecisionMint:true`（handler 内 mint 决策携带 `involved_entities`），否则 MCP phase1 走 `DECISION_NEEDED` 死胡同（历史踩坑：crm-deal-reopen/return/archive-to-pool/reclaim-bulk 已修同范式）。

---

## 3. 配置层扩展（100% 后台化）

### 3.1 `src/config/discoveryRules.js` 两处增量
- `DEFAULT_DISCOVERY_RULES.providers` 增加两个付费源（出厂 `enabled:false`，按租户显式授权）：
  ```js
  { id: 'qixin',   kind: 'firmographics', scope: 'paid', costTier: 2, enabled: false },
  { id: 'xinbang', kind: 'social',        scope: 'paid', costTier: 2, enabled: false },
  ```
  > 注意：`mergeDiscoveryRules` 已按 `id` 覆盖既有项、不增删条数（`:52-57`），故新增 id 须同时在此与 `builtinAdapters.js` 注册，否则 `resolveAdapters` 的 `registry.has(id)` 恒假 → 静默零产出（与 gaode 同坑）。
- `DEFAULT_DISCOVERY_RULES.signals` 增加辅助信号键（配置化，不增字面量于代码逻辑）：
  ```js
  social_content: { weight: 0.4 },
  ```
  新榜产出 `social_content` 信号，权重由租户在后台可调。

### 3.2 两个新 config 键（per-tenant，pgcrypto 加密）
- **`config_store['integration-providers']`**：租户声明的**自有系统实例**数组（非付费源，是 CLI/MCP/API 三类通用 adapter 的运行时实例）。
  ```json
  [
    { "id":"erp-acme", "kind":"generic-rest", "enabled":true,
      "endpoint":"https://erp.acme.com/api", "auth_ref":"integration-secrets:erp-acme",
      "field_map": { "name":"companyName", "domain":"webDomain", "employee_range":"headcount" },
      "signal_map": { "open_tickets":"support_load" } }
  ]
  ```
  系统模板从 `system` 懒克隆；本键**允许租户新增 id**（区别于 `discovery-rules` 的「仅覆盖」语义），故走独立键、独立合并逻辑，不污染 `mergeDiscoveryRules`。
- **`config_store['integration-secrets']`**：per-tenant 加密凭据库。
  ```json
  { "qixin":"<pgp_sym_encrypt(apikey)>", "erp-acme":"<pgp_sym_encrypt(token)>" }
  ```
  落库走 `pgp_sym_encrypt(secret, process.env.PGCRYPTO_SYM_KEY)`；运行时 `pgp_sym_decrypt` 后注入 `ctx.credentials[providerId]`。**绝不进前端、不进日志、不进 memory**。

---

## 4. 适配层（5 个新 adapter + 1 处 registry 扩展）

### 4.1 付费源 adapter（照搬 `gaode.js` 范式）

**`src/connectors/discovery/adapters/qixin.js`**（启信慧眼 · 企业画像 / 招投标 / 融资 / 招聘）：
- `kind:'firmographics'`，`scope:'paid'`。
- `coverageFields` 同时声明**工商字段**与**信号字段**（信号字段名须命中 `discoveryRules.signals` 键，才能进 `intent_score`）：
  ```js
  coverageFields: ['registered_address','legal_person','biz_status',
                   'funding_round','hiring_icp_role','tender_match']
  ```
- `enrich()` 调启信慧眼 API，按 `fieldHit()` 返回；`funding_round/hiring_icp_role/tender_match` 三个字段**复用既有 signals 权重键**（`:29-31`），零新增信号逻辑。
- 凭据：`ctx.credentials?.qixin || process.env.QIXIN_KEY`（无 key 返回 `{}`，零请求）。

**`src/connectors/discovery/adapters/xinbang.js`**（新榜 · 公众号 / 小红书 / 抖音）：
- `kind:'social'`，`scope:'paid'`。
- `coverageFields:['social_content']`，`enrich()` 返回 `social_content:{value:{platform,posts,interactions},...}` → 进 `discovery.signals` 类型 `social_content`，权重取 `signals.social_content.weight`（§3.1 新增）。
- 凭据同 qixin 范式。

> 两个 adapter 在 `builtinAdapters.js` 的 `BUILTIN_ADAPTERS` 中追加注册（`:17-22` 同位置），保持与 `discoveryRules.providers[].id` 同源。

### 4.2 通用租户 adapter（零租户代码）

三个通用 adapter 是**框架代码**，不写死任何外部系统；实例差异全部来自 §3.2 的 `integration-providers` 描述符：

- **`src/connectors/discovery/adapters/genericRest.js`**：按 `endpoint`+`auth`+`field_map` 调 REST，把响应按 `field_map` 映射为 `enrichment` 字段；`signal_map` 项映射为 `discovery.signals`。
- **`src/connectors/discovery/adapters/genericMcp.js`**：把租户 MCP Server 暴露的 resource/tool 经 stdio/HTTP 拉取，按 `field_map` 映射。
- **`src/connectors/discovery/adapters/genericCli.js`**：执行租户声明的 CLI 命令（沙箱化、超时、白名单），解析 stdout 后按 `field_map` 映射。

三者统一实现 `enrich(entity, fields, ctx)`，返回格式与 `gaode`/`tender` 一致，被 `runWaterfall` 无差别消费。

### 4.3 `providerRegistry` 的 per-tenant 注册子机制（唯一真实新逻辑）

新增独立 `TENANT_REGISTRY = new Map()`（key = `${tenantId}:${instanceId}`），与全局 `REGISTRY` 并存：
```js
// providerRegistry.js 增量
const TENANT_REGISTRY = new Map();
export function registerTenantInstance(tenantId, descriptor, factory) {
  if (!descriptor?.id || typeof factory !== 'function') throw new Error('registerTenantInstance 参数非法');
  TENANT_REGISTRY.set(`${tenantId}:${descriptor.id}`, factory);
}
export function loadTenantInstances(tenantId, deps = {}) {
  // 读 config_store['integration-providers']（per-tenant）→ 逐条 registerTenantInstance
  // 返回该租户实例的 factory 列表（跨租户读取恒空 = 隔离）
}
export function resolveAdapters(rules, { allowIds, registry = REGISTRY, tenantId } = {}) {
  // 既有逻辑（builtin/generic framework）…
  const tenantFacs = tenantId ? loadTenantInstances(tenantId) : [];
  return [...builtinAdapters, ...tenantFacs].filter(...).sort(...).map(...);
}
```
隔离保证：实例以 `${tenantId}:` 为前缀，租户 A 的 `resolveAdapters({tenantId:'A'})` 永远取不到租户 B 的实例。

---

## 5. 凭据保险库

**`src/connectors/discovery/credentialVault.js`**（新增模块）：
```js
// 读 config_store['integration-secrets']（per-tenant）→ pgcrypto 解密 → 返回 { providerId: raw }
export async function resolveCredentials({ tenantId, providerIds, deps = {} }) {
  const read = deps.readConfig || storeRead;
  const row = await read('integration-secrets', { tenantId }).catch(() => null);
  const enc = row?.value || {};
  const out = {};
  for (const pid of providerIds) {
    const raw = enc[pid];
    if (raw) out[pid] = await pgpSymDecrypt(raw, process.env.PGCRYPTO_SYM_KEY);
    else out[pid] = process.env[`${pid.toUpperCase()}_KEY`] || null; // 回退 env（系统级单 key 场景）
  }
  return out;
}
```
- 写入侧（admin 端点 / onboarding）：`pgp_sym_encrypt(raw, key)` 落库，密钥取自 `PGCRYPTO_SYM_KEY`（平台环境变量，不落库）。
- `discoveryOrchestrator` 在 `runDiscovery` 内：`const credentials = await resolveCredentials({tenantId, providerIds: adapters.map(a=>a.id)})`，注入 `ctx.credentials`，供各 adapter `ctx.credentials?.[this.id]` 取用。

---

## 6. 采集编排（混合模式）

### 6.1 定时拉取（复用 `timers.js` 范式）
`timers.js` 新增 `integration-poll` 定时器（间隔取自 `config_store['integration-poll'].interval_ms`，env `INTEGRATION_POLL_MS` 可覆盖），**复用 `sales-daily-scan` 的 `listActiveTenants` 租户循环**（`:194-244`）：
```js
const { listActiveTenants } = await import('../tenant/tenantRepo.js').catch(()=>({listActiveTenants:null}));
const tenants = listActiveTenants ? await listActiveTenants().catch(()=>[{tenant_id:'system'}]) : [{tenant_id:'system'}];
for (const t of tenants) {
  const adapters = await loadAdapters({ tenantId: t.tenant_id });        // 含该租户启用的 qixin/xinbang/自有实例
  for (const ad of adapters) {
    const accounts = await query(`SELECT id, payload FROM crm.particles WHERE type='CRM_ACCOUNT' AND tenant_id=$1`, [t.tenant_id]);
    for (const acc of accounts.rows) {
      const { values } = await runWaterfall([ad], acc, ad.coverageFields, ctx);
      await monitorAccount({...deps}, acc.id, Object.keys(values).map(f=>({type:f,provider:ad.id}))); // 复用 C3 闭环
    }
  }
  emit('trace','integration-poll-done',{ tenant_id: t.tenant_id });
}
```
> 铁律对齐 `timers.js:5-6`：定时扫描**只产生预警/触发，不直接裸写粒子**：此处经 `monitorAccount`（其内走 `updateParticle` + 第 0 闸语义）闭环，不违反「定时扫描直接写粒子 = D4 反模式」。

### 6.2 事件推送（webhook）
`src/http/connectorRouter.js` 新增 `POST /api/integration/webhook/:provider`（admin/sysadmin 闸，仿 `/zhizao-verify`）：
- 启信慧眼/新榜订阅命中 → 解析推送 → `emit('integration','webhook',{provider, payload})` 进总线审计；
- 命中强信号（funding_round 等）→ 复用 `conn-tender-push` 事件驱动模式 → `createLeadFromTender` 生成 `CRM_DEAL(stage:'S0')`。

### 6.3 手动触发
`connectorRouter` 扩展 `/qixin-enrich` `/xinbang-sync` `/tenant-source-sync`（admin 闸），即时按需 enrich/verify，复用 `discovery-run` 的 `runDiscovery(ctx,{seed,allowIds})`。

---

## 7. 信号 → CRM 双模落地（你已选定：建档 + 主动生成）

### 7.1 被动建档（复用既有闭环，零新动作）
adapter 数据 → `discoveryOrchestrator`（`enrichment`+`discovery` 入 payload）→ `monitorAccount`（signals→九标尺+2D judge `rescore`→`appendMemory`→`update payload.discovery`）。qixin/xinbang 的信号字段名命中 `signals` 键即自动进 `intent_score`，无需任何新增评分代码。

### 7.2 主动生成（强信号 → 建线索，复用 `conn-tender-push`）
新增 **1 个 write action**（仿 `conn-tender-push`，`connectorActions.js:98-126`）：
```js
registerAction({
  name: 'conn-signal-lead-gen', kind: 'write', permission: 'auth',
  namespace: 'connector', agentTool: false,           // 仅 webhook/定时器触发，不进 agent 直调 → 免 agentSpec 改动
  needsApproval: true, autoDecision: true, confirm: 'stage2',
  deferDecisionMint: true,                              // 关键：防 MCP 死胡同
  autoWeakEdge: true, weakPredicate: 'sourcedFrom',
  schema: { signal_type: 'string', account_id: 'string', match: 'object' },
  parameters: { required: ['signal_type','account_id'] },
  handler: async ({ signal_type, account_id, match }, ctx) => {
    const { createLeadFromTender } = await import('../connectors/tenderConnector.js');
    const deal = await createLeadFromTender({ signal: { type: signal_type, ...match }, tenantId: ctx.tenantId });
    return { deal_id: deal.id, account_id, signal_type };
  },
});
```
触发条件：信号权重（取 `discoveryRules.signals[signal_type].weight`）≥ `config_store['integration-rules'].lead_gen_threshold`（按信号类型可配），由 webhook/定时扫描判定后调用。落 `CRM_DEAL(stage:'S0', pool_type:'new')` + `sourcedFrom` 弱边，过第 0 闸/HITL。

---

## 8. 多租户隔离 + 安全闭环

| 维度 | 机制 | 锚点 |
|---|---|---|
| 源隔离 | `discovery-rules.providers[].enabled` 为租户级状态；付费源出厂 `false`，按租户授权 | discoveryRules.js:18-27 |
| 自有实例隔离 | `TENANT_REGISTRY` 以 `${tenantId}:` 前缀，跨租户读取恒空 | §4.3 |
| 凭据隔离 | per-tenant `integration-secrets` + pgcrypto 加密，运行时解密注入 ctx | §5 |
| 写隔离 | 所有粒子写透传 `ctx.tenantId` | discoveryOrchestrator.js:24-26 |
| 管理面隔离 | `integration-providers`/`integration-secrets` 注册为 `CONFIG_ITEMS` 的 **system 级闸**（sales 访问 403） | configCenter.js 范式（同 `pool-config`） |

---

## 9. 接入管理 UI

复用 `discovery-rules.html` 后台页（设计 §3.2 C1 编排页），新增 **「数据源」Tab**：
- 已连源列表（系统默认 / 付费 / 租户自有实例）与各自 `enabled` 状态；
- 付费源「授权 + 填 key」按钮（写 `integration-secrets`，走第 0 闸）；
- 最近同步时间（读 `integration-poll-done` trace）；
- 信号流预览（只读展示各信号 `intent_score` 贡献）。
不新增独立页面，复用 portal render 范式。

---

## 10. 可观测

- 所有拉取/推送 emit 总线事件：`integration-poll-done` / `integration-webhook` / `integration-lead-gen`。
- 同步指标接入 `feedback-loop`：`monitorAccount` 已喂 `monitorAccount_refresh_rate`（monitorAccount.js:35）；新增 `integration_pull_cost`（Token-业务对账复用 `src/alerts/tokenAccounting.js recordTokens`，零新表）。

---

## 11. 是否需要新增 / 修改 SKILL？—— 否（结论）

| 项 | 是否需要 | 理由 |
|---|---|---|
| 新增 `method-integration-sync` SKILL | **不需要** | 定时拉取复用 `discoveryOrchestrator` 自身的 provider 轮询（`discovery-run`），不另造定时器/方法 |
| 修改 10 大 `ai-*` 方法论 SKILL | **不需要** | 纯平台集成逻辑，不触及方法论基线 |
| 修改 `method-quote-engine` 等既有 method | **不需要** | 外联/方案消费 discovery payload 的路径不变 |
| 修改 `agentSpec.js`（decision-agent 闭包） | **不需要** | 新 adapter 由 orchestrator 自动消费；`conn-signal-lead-gen` 设 `agentTool:false`（仅 webhook/定时器触发），不进 `capabilities.actions` |
| 修改 `src/skills/seed.js` | **不需要** | 无新 SKILL 步骤 |
| 修改 `builtinAdapters.js` | **需要（1 处）** | 在 `BUILTIN_ADAPTERS` 追加 `qixin`/`xinbang` 两个 factory（与 `discoveryRules.providers` id 同源） |
| 修改 `connectorActions.js` | **需要（1 处）** | 注册 `conn-signal-lead-gen`（仿 `conn-tender-push`） |

> 这是相对初版方案（曾提「新增 4 个 conn-* + method-integration-sync + 三处硬闭包改动」）的**重大收敛**：富集/补全复用既有 `discovery-enrich`，强信号复用 `conn-tender-push` 模式，SKILL/闭包几乎零改动。

---

## 12. 任务拆分（可逐 Task 执行的实施清单）

| # | 任务 | 落点文件 | 成功判据（可断言） |
|---|---|---|---|
| T1 | 配置增量：`discoveryRules.js` 加 qixin/xinbang 付费源 + `social_content` 信号键 | `src/config/discoveryRules.js:18-35` | `DEFAULT_DISCOVERY_RULES.providers` 含 qixin/xinbang 且 `enabled:false`；`signals` 含 `social_content` |
| T2 | 凭据保险库 `credentialVault.js`（pgcrypto 加解密 + env 回退） | 新增 `src/connectors/discovery/credentialVault.js` | 单测：加密→解密 round-trip 等于原文；缺失回退 env |
| T3 | per-tenant 注册子机制 | `src/connectors/discovery/providerRegistry.js` | `registerTenantInstance('A',desc,fac)` 后 `resolveAdapters({tenantId:'A'})` 含之；`tenantId:'B'` 取空（隔离） |
| T4 | qixin adapter（firmographics + 信号字段） | 新增 `src/connectors/discovery/adapters/qixin.js` | `enrich` 返 `funding_round/hiring_icp_role/tender_match` 字段；无 key 返 `{}` |
| T5 | xinbang adapter（social_content） | 新增 `src/connectors/discovery/adapters/xinbang.js` | `enrich` 返 `social_content` 字段；进 `discovery.signals` 类型 `social_content` |
| T6 | 通用 adapter generic-rest/mcp/cli（按 field_map 映射） | 新增 3 文件 `src/connectors/discovery/adapters/generic*.js` | 给定实例描述符，`enrich` 按 `field_map` 输出 enrichment 字段 |
| T7 | 在 `builtinAdapters.js` 注册 qixin/xinbang | `src/connectors/discovery/builtinAdapters.js:17-22` | `registerBuiltinAdapters()` 后 `listProviderIds()` 含 qixin/xinbang |
| T8 | orchestrator 注入 `ctx.credentials` | `src/agent/discoveryOrchestrator.js:49-56` | `runDiscovery` 内 `ctx.credentials[qixin]` 为解密值（单测注入 deps 可断言） |
| T9 | `conn-signal-lead-gen` write action（仿 conn-tender-push + deferDecisionMint） | `src/connectors/connectorActions.js` | 经 MCP phase1 返 `confirm_token`（非 DECISION_NEEDED）；生成 `CRM_DEAL(stage:'S0')`+`sourcedFrom` 边；无 DELETE |
| T10 | `integration-poll` 定时器（listActiveTenants 循环 + monitorAccount） | `src/scheduler/timers.js` | 定时器触发后该租户启用 provider 拉取并更新 `payload.discovery`，emit `integration-poll-done` |
| T11 | webhook 端点 + 手动端点 | `src/http/connectorRouter.js` | `POST /api/integration/webhook/qixin` 触发 → 进总线审计；admin 端点即时 enrich |
| T12 | `integration-providers`/`integration-secrets` 配置键 + system 级闸 | `src/config/configStore.js` + `configCenter.js` | sales 读 `integration-secrets` 返回 403；admin 可读写 |
| T13 | UI「数据源」Tab | `src/web/discovery-rules.html` | admin 见已连源列表 + 最近同步时间；可授权付费源 |
| T14 | 可观测：总线事件 + token 对账 | `src/alerts/tokenAccounting.js` | `integration-poll-done` 事件被 capture；`recordTokens` 落账零新表 |

---

## 13. 已知风险与待消解项（诚实披露）

1. **S5 narrative 路由不一致（既有 bug）**：记忆标注 `S5 narrative 总是经 assembleContextV2 注入、与 routing config 不一致`（context-routing id36 受保护、禁改）。外部信号进决策上下文的**实际路由路径**须在实施 T8/T10 时实证，不能假设已接通。
2. **pgcrypto 密钥管理**：`PGCRYPTO_SYM_KEY` 须由平台密钥管理注入（不落库、不进前端）；密钥轮转策略本期不实现，列为后续。
3. **generic-cli 沙箱**：租户 CLI 命令执行须限白名单 + 超时 + 资源配额，避免租户代码逃逸；本期给最小白名单（只读查询类命令），写入类命令禁止。
4. **强信号阈值误判**：`lead_gen_threshold` 初值须保守（如 ≥0.8 且信号置信 ≥0.7），避免噪音线索污染公海；由运营后台可调。

---

## 14. 写后自查（brainstorming P7）

| 检查项 | 结论 | 证据/处置 |
|---|---|---|
| 占位符 | ✅ 无 | 全文无 `TODO/TBD/待填`；代码块中 `...` 为示意值 |
| 矛盾 | ✅ 无 | ① 衔接关系 §1 与获客模块 v8.1 §2/§3 一致；② T9 `agentTool:false` 与 §11「免 agentSpec 改动」自洽；③ 配置语义：`discovery-rules` 仅覆盖、`integration-providers` 允许新增 id，两键分工明确 |
| 歧义 | ✅ 已消除 | ① 明确付费源出厂 `false` 且须按租户授权；② 明确 generic-* 零租户代码、差异全在 config；③ 明确强信号落 `S0` 公海 + sourcedFrom 边 |
| 范围 | ✅ 守界 | 不新增粒子类型（§2 铁律1）、不改业务域模型、不新增 Agent、不新增 SKILL、不新增 `decision_scenario`（§11） |
| 可落地 | ✅ | 每个任务有 file:line 落点 + 可断言成功判据（§12）；adapter/action 均照搬已验证范式（gaode/tender/conn-tender-push） |

---

## 15. 下一步

本方案为**就地扩展路线（获客模块数据源子层）**的可落地设计。批准后移交 `writing-plans` 按 §12 任务清单拆为逐 Task 实施计划（含完整代码）。
