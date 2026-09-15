# 拓客模块设计（Prospecting Module）— MCP 对话驱动批量建公海池

> 状态：**已批准**（2026-09-14，brainstorming P5 批准 + P8 用户评审批准）
> 适用范围：CRM-ai-native 平台 · 多租户通用 · 配置驱动
> 设计红线：**不新增粒子类型**（遵守已批设计 §10 硬约束）；不破坏既有 enrich 能力；禁 DELETE；写走第 0 闸

> **修订记录（2026-09-14，P8 用户评审批准后应用）**
> - **修订 1（P1）**：§5 溯源弱边主语统一为 `CRM_DEAL --sourcedFrom--> CRM_KNOWLEDGE`。原稿引用 `connectorActions.js:41` 的 attio 范式（`ACCOUNT→KNOWLEDGE`）与"复用 createLeadFromTender 范式"（tenderConnector.js:60，`DEAL→KNOWLEDGE`）**文档内部自相矛盾**；统一 DEAL 主语，与标讯/信号完全同构，避免边型双主语。
> - **修订 2（P2）**：fit_score 计算强制收敛于服务端 `mergedProspectingRules`（信号加权），**适配器不得注入/伪造 fit_score**；§2.3 补契约、§4.1 handler 注释同步、§7 T1 拆为 T1a（计分）+ T1b（服务端覆盖校验）。
> - **修订 3（对齐）**：§A 契约块承接智能体与 agentSpec.js 现状对齐——当前为 **4 agent 制**（intake-router / quote-engine / followup-agent / review-gate），`crm-copilot` 已废弃 → 契约块 agent 统一为 `prospecting`（新注册，见 §A.3），前端拓客 Tab 承接改 `review-gate`；`connector-qixin/xinbang` 为适配器而非 agent，由其嵌入调用。P7 契约自检 `--registry src/agent/agentSpec.js` 会因 agent 不存在而**失败**，故 `prospecting` agent 注册列入 writing-plans 前置 Task（§A.3）。

---

## §0 背景与问题

### 0.1 现状（源码锚点已核实）

现有线索来源共 5 条通路，全部是**存量数据写入**：

| 通路 | 触发 | 落库 | 锚点 |
|---|---|---|---|
| 手动新建 | 商机页填名称提交 | `POST /api/particles` → S0 `pool_type:'new'` | `src/web/pipeline.html:184-201` |
| 智能体发现 | `discovery-run` | S0 + `source:'discovery'` | `src/agent/discoveryOrchestrator.js:98-102` |
| 外部信号 | 融资/招聘/社媒 webhook | `conn-signal-lead-gen` → S0 | `src/connectors/connectorActions.js:128-146` |
| 标讯订阅 | 关键词/区域命中 | `conn-tender-push` → S0 + sourcedFrom | `src/connectors/tenderConnector.js:52-61` |
| 回流 | 超期 30 天回收/手动退回/战败归档 | `crm-lead-recycle/return/archive` | `seed-actions.js:931-1086` |

**核心差距**：缺「**主动拓客（outbound prospecting）**」——按 ICP/画像/强信号条件**批量搜索候选企业 → 销售圈选 → 批量入公海池**。现有 qixin/xinbang 适配器只支持**单点 enrich**（给已有企业补画像），无**批量搜索**能力。

### 0.2 已具备底座（复用，不重造）

| 底座 | 位置 | 复用点 |
|---|---|---|
| ProviderAdapter + 注册机制 | `src/connectors/discovery/providerAdapter.js` | qixin/xinbang 已注册 |
| resolveAdapters | `src/connectors/discovery/providerRegistry.js` | costTier 排序/启停过滤 |
| dedupResolver.resolveExistingOrCreate | `src/connectors/discovery/dedupResolver.js:18` | 查重（复用赢家，禁删） |
| createLeadFromTender 范式 | `src/connectors/tenderConnector.js:52-65` | S0+pool_type:'new'+sourcedFrom |
| 第 0 闸（autoDecision） | `src/decision/autonomyEngine.js (requireDecision)` | 写通道 |
| 双层配置 | `src/config/discoveryRules.js` | 出厂默认 ⊕ 租户覆盖 |
| 公海池 UI | `src/web/lead-pool.html` | 展示 S0（无圈选入口） |
| 启信慧眼/新榜适配器 | `src/connectors/discovery/adapters/qixin.js` / `xinbang.js` | **扩展 search() 能力** |

### 0.3 已确认决策（brainstorming P2）

| # | 决策 | 结论 |
|---|---|---|
| 1 | 目标 | **多租户通用，配置驱动**（不绑定行业） |
| 2 | 数据源 | **启信慧眼（强信号）+ 新榜（辅助信号）并行** |
| 3 | 入口形态 | **MCP 对话内闭环**（NL 问→列表→圈选确认→批量入池），`lead-pool.html` 拓客 Tab 为**旁路（第一迭代后补）**，调同一后端 Action |
| 4 | 方案 | **A：MCP 对话驱动单 Action + 状态机拓客管道**（旁路 Tab 也复用同一 Action，不另起管道） |

---

## §1 `prospecting-session` 状态机（新增 `src/action/prospectingSession.js`）

### 1.1 状态定义

| 状态 | 触发 | 产出 | 成功判定 |
|---|---|---|---|
| `searching` | MCP 发 NL 查询 | 候选清单 `prospecting_candidates` | 返回 ≥0 条候选 & fit_score 已计算（**服务端按 mergedProspectingRules 信号加权**，修订 2） |
| `listing` | 清单回传对话 | 候选列表（名称/行业/营收/信号摘要/fit_score） | 可被圈选 |
| `selecting` | 用户 `select` | 圈选列表 `selected_ids` | 非空 & 均来自候选 |
| `pending_confirm` | 用户确认 | 待入池清单（含 decision 预检） | 清单完整 |
| `pooled` | `confirm`（第 0 闸通过） | 批量 S0 粒子 | 每企业返回 decision_id |

### 1.2 会话实例

- **存储**：内存 Map（`tenantId:actor:sessionId`），保留最近 N（如 100）
- **不落粒子**（避免污染本体；符合不新增粒子类型）
- **可中断恢复**：`getSession` 幂等重建；超时（如 30 分钟）自动失效
- **并发隔离**：每租户同一 actor 同时仅一个活跃会话（新查询覆盖旧会话，先确认旧会话已结束）

### 1.3 状态机接口

```js
// src/action/prospectingSession.js
export function createProspectingSession({ tenantId, actor }) -> sessionId
export function getSession(sessionId) -> session | null   // 幂等重建，超时失效
export function updateSession(sessionId, patch) -> session
export function expireSession(sessionId) -> void

// 状态转移（纯函数，无 IO，单测友好）
export function transition(state, event, payload) -> nextState  // 非法转移抛错
```

---

## §2 适配器 `search()` 能力扩展

### 2.1 `qixin.js`（启信慧眼）新增 `search()`

```js
async search(query, ctx) -> [{
  name, domain, industry, revenue, funding_round, hiring_icp_role,
  tender_match, confidence, provider: 'qixin'
}]
// query: { industries, min_revenue, min_headcount, geo,
//          signals: { hiring, funding, tender }, limit }
```

- **实现**：调 `QIXIN_API` 企业搜索端点（企业列表接口），key 走 `credentialVault` / `ctx.credentials.qixin`
- **铁律**：返回 `[]` 而非抛错（fail-open 对齐 `providerAdapter.js`）；`confidence` 必须带；**不得返回 fit_score**（fit_score 是服务端计算物，修订 2）

### 2.2 `xinbang.js`（新榜）新增 `search()`

```js
async search(query, ctx) -> [{
  name, platform, social_content: { posts, interactions }, confidence, provider: 'xinbang'
}]
```

- **定位**：**辅助信号**，不单独产生候选；与 qixin 候选按 `name/domain` join，增强 fit_score
- **铁律**：返回 `[]` 而非抛错；辅助信号无命中不影响主候选；**不得返回 fit_score**

### 2.3 适配器接口契约（不改 ProviderAdapter 基类）

- `enrich()` 保持既有语义（单点补画像）
- `search()` 为**新增能力**，基类不强制（无 search 的适配器跳过搜索阶段）
- `coverageFields` 无变化（search 是独立方法）
- **fit_score 契约（修订 2）**：候选列表只承载原始画像/信号字段；`fit_score` 一律由服务端 `mergedProspectingRules` 按信号权重计算（`Σ(命中信号×权重) / Σ权重`，未命中按 0 计），**适配器不得写入/注入 fit_score**（防数据源伪造分数）；仅在服务端 `prospecting-search` handler 内统一计算

---

## §3 配置新增 `config_store['prospecting-rules']`

### 3.1 出厂默认（`src/config/prospectingRules.js`）

```js
export const DEFAULT_PROSPECTING_RULES = Object.freeze({
  icp: {
    industries: [],          // 租户自行配置（不绑定行业）
    min_revenue_y: 1e8,      // 营收阈值（元/年）
    min_headcount: 50,       // 人数阈值
    geo: ['CN'],
  },
  signals: {                 // 与 discovery-rules.signals 同构
    hiring: 0.7, funding: 0.9, tender: 0.8, social: 0.4,
  },
  sources: {
    qixin:   { enabled: false, weight: 0.6 },   // 付费源，出厂关闭，需授权+填 key（D1 纪律）
    xinbang: { enabled: false, weight: 0.2 },
  },
  candidate_limit: 50,       // 单次搜索候选上限
  fit_threshold: 0.6,        // 低于此不进入 listing
});
```

### 3.2 合并与加载（对齐 discoveryRules.js 范式）

- `mergeProspectingRules(base, tenantCfg)`：纯函数，浅合并 icp/signals，sources 以 id 为键覆盖（**不增删条数**，防租户越权新增付费源）
- `mergedProspectingRules({ tenantId })`：租户感知加载，读 `config_store['prospecting-rules']` ⊕ 出厂默认；fail-open 回退出厂默认

---

## §4 三个 MCP 工具（Action 注册，挂 MCP surface）

| Action | kind | 参数 | 产出 | 第 0 闸 |
|---|---|---|---|---|
| `prospecting-search` | read | `{ query: NL|structured, pool: 'new' }` | 候选清单（fit_score） | 无（只读） |
| `prospecting-select` | read（圈选不写） | `{ session_id, selected_ids }` | 更新会话 selecting | 无（只读） |
| `prospecting-confirm` | write | `{ session_id, confirmed_ids }` | 批量 S0 + 每企业 decision_id | **requiresDecision（autoDecision）** |

### 4.1 `prospecting-search`（注册于 `src/action/registry.js`）

```js
registerAction({
  name: 'prospecting-search', kind: 'read', permission: 'auth',
  namespace: 'prospecting', agentTool: true, force: false, needsApproval: false,
  autoDecision: false, confirm: 'stage0', owner: 'prospecting', version: '1.0.0',
  schema: { query: 'object' },
  parameters: { required: ['query'] },
  handler: async ({ query }, ctx) => {
    // ① 读 mergedProspectingRules → ICP/信号权重/候选上限
    // ② resolveAdapters(rules.sources) → qixin.search + xinbang.search
    // ③ dedupResolver.resolveExistingOrCreate → 候选查重（existing:true 标记）
    // ④ 计算 fit_score —— 服务端统一按 mergedProspectingRules.signals 加权（适配器不注入，修订 2）
    // ⑤ 返回候选清单（名称/行业/营收/信号摘要/fit_score/existing）
  },
});
```

### 4.2 `prospecting-select`

```js
registerAction({
  name: 'prospecting-select', kind: 'read', permission: 'auth',
  namespace: 'prospecting', agentTool: true, force: false, needsApproval: false,
  autoDecision: false, confirm: 'stage0', owner: 'prospecting', version: '1.0.0',
  schema: { session_id: 'string', selected_ids: 'array' },
  parameters: { required: ['session_id', 'selected_ids'] },
  handler: async ({ session_id, selected_ids }, ctx) => {
    // ① getSession(session_id)；不存在 → 400
    // ② 仅可圈选来自 candidate_list 的 id（防注入）
    // ③ updateSession → selecting + selected_ids
  },
});
```

### 4.3 `prospecting-confirm`（唯一写动作）

```js
registerAction({
  name: 'prospecting-confirm', kind: 'write', permission: 'auth',
  namespace: 'prospecting', agentTool: true, force: false, needsApproval: true,
  autoDecision: true, confirm: 'stage2', owner: 'prospecting', version: '1.0.0',
  autoWeakEdge: true, weakPredicate: 'sourcedFrom',
  schema: { session_id: 'string', confirmed_ids: 'array' },
  parameters: { required: ['session_id', 'confirmed_ids'] },
  handler: async ({ session_id, confirmed_ids }, ctx) => {
    // ① getSession；状态必须 selecting/pending_confirm
    // ② requireDecision(EXTERNAL_ENRICHMENT 同构场景 'PROSPECTING_CONFIRM',
    //    { connector:'prospecting', count: confirmed_ids.length },
    //    involved=[{type:'CRM_DEAL', id?}], { actor, disposition:'APPROVE' })
    // ③ 逐 candidate：查重（dedupResolver）→ 已存在跳过（existing:true）
    // ④ createParticle('CRM_DEAL', { stage:'S0', pool_type:'new', source:'prospecting',
    //    name, expected_amount, ... }, { tenantId, requireDecisionId })
    // ⑤ sourcedFrom 弱边：CRM_DEAL --sourcedFrom--> CRM_KNOWLEDGE（auto_weak，conf=fit_score，
    //    provenance:'prospecting-search', decision_id）——对齐 createLeadFromTender（修订 1）
    // ⑥ emit('prospecting','batch-pooled', { ... })
    // ⑦ 返回 [{ account_id, deal_id, decision_id, existing }]
  },
});
```

---

## §5 批量入池 + 溯源（复用 createLeadFromTender 范式）

- **不新增粒子类型**：每候选企业 → `CRM_DEAL` S0 + `pool_type:'new'` + `source:'prospecting'`（区别于 discovery/标讯/信号——可审计）
- **查重**：`dedupResolver.resolveExistingOrCreate`（复用赢家 = 不入重复池；已存在企业标记 `existing:true` 不入池，避免池内重复）
- **sourcedFrom 弱边（修订 1）**：`CRM_DEAL --sourcedFrom--> CRM_KNOWLEDGE`（auto_weak，provenance:`prospecting-search`，relation_confidence=fit_score）——**严格复用 createLeadFromTender 范式**（tenderConnector.js:60，主语 DEAL→KNOWLEDGE）。
  - **为何不用 `ACCOUNT` 主语**：`connectorActions.js:41/85` 的 `ACCOUNT→KNOWLEDGE` 属 attio 企业 enrich 语义（给**已有账户**补画像），与"批量建公海池（每候选先建 DEAL）"语境不同；`connectorActions.js:144` 的 `ACCOUNT→DEAL` 属信号回灌语义（账户已存在、把新 DEAL 挂到账户）。拓客是**新企业直落池**，候选尚无 ACCOUNT——以 ACCOUNT 起边会引入**第二个 sourcedFrom 主语**，破坏边型一致性（审计/图查询双轨）。统一 DEAL 主语，与标讯/信号完全同构。
- **事件**：`emit('prospecting','batch-pooled')`（进总线审计，对齐 `tender-lead-created`）

---

## §6 前端旁路（MCP 对话外，非对话入口）

- `lead-pool.html` 加「拓客」Tab：候选清单表格（fit_score/信号摘要/是否已存在）+「圈选」「确认入池」按钮，调同一后端 Action
- 对齐「A 方案为主，旁路可加」（已确认 §6 先不做第一迭代，后补）

---

## §7 测试与验收（防假绿）

| # | 验收项 | 判定（可执行） |
|---|---|---|
| T1a | 候选搜索返回 ≥0 且 fit_score 已算 | `prospecting-search` 对 mock 适配器返回清单，fit_score ∈ [0,1] |
| T1b | fit_score 仅服务端计算（修订 2） | mock 适配器返回**带 fit_score** 的候选时被服务端忽略/覆盖，最终 fit_score 只由 `mergedProspectingRules` 信号加权算出（`Σ(命中信号×权重)/Σ权重`） |
| T2 | 圈选只读不写 | `prospecting-select` 后粒子数不变（无 CRM_DEAL 新增） |
| T3 | 批量入池走第 0 闸 | `prospecting-confirm` 每企业返回 decision_id（非 'pending'） |
| T4 | 查重不重复入池 | 已存在企业 → `existing:true` 不入池 |
| T5 | 租户隔离 | 不同 tenantId 候选互不可见；写透传 tenantId |
| T6 | MCP→Action→入池闭环 | 全链路 event 总线有 `batch-pooled` 事件，含 decision_id |

### 测试文件规划

- `test/prospectingSession.test.js` — 状态机转移（含非法转移抛错）
- `test/prospectingRules.test.js` — 合并/租户覆盖（含不增删 sources）
- `test/prospectingActions.test.js` — 三 Action（mock 适配器注入，验证 readonly/write + decision 透传 + fit_score 服务端覆盖）

---

## §A Living Contract（生命契约）

### A.1 契约块（机器可读）

```contract-yaml
- task: "（不涉及）接诊分流沿用既有契约"
  agent: intake-router
  contract_task_id: ct-intake-route
  skills: [data-particle-read]
  memory: []
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "本设计不修改 intake-router 行为；既有契约键保持"

- task: "（不涉及）报价测算沿用既有契约"
  agent: quote-engine
  contract_task_id: ct-quote-calc
  skills: [data-particle-read]
  memory: []
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "本设计不修改 quote-engine 行为；既有契约键保持"

- task: "（不涉及）跟进提醒沿用既有契约"
  agent: followup-agent
  contract_task_id: ct-followup
  skills: [data-particle-read]
  memory: []
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "本设计不修改 followup-agent 行为；既有契约键保持"

- task: "（不涉及）决策复盘沿用既有契约"
  agent: decision-retro
  contract_task_id: ct-retro-decision
  skills: [data-particle-read]
  memory: [review-gate]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "本设计不修改 decision-retro 行为；既有契约键保持"

- task: "（不涉及）决策接线沿用既有契约"
  agent: decision-agent
  contract_task_id: ct-decision
  skills: [data-particle-read]
  memory: [review-gate]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "本设计不修改 decision-agent 行为；既有契约键保持"

- task: "实现 prospecting-session 状态机"
  agent: prospecting
  contract_task_id: ct-prospecting
  skills: [data-particle-read]
  memory: []
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "状态机 5 态转移测试通过（含非法转移抛错），getSession 幂等重建"

- task: "启信慧眼 search() 能力扩展"
  agent: prospecting
  contract_task_id: ct-prospecting
  skills: [data-particle-read]
  memory: []
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "qixinAdapter.search(query) 返回候选数组；无 key 返回 [] 不抛错；不带 fit_score"

- task: "新榜 search() 能力扩展"
  agent: prospecting
  contract_task_id: ct-prospecting
  skills: [data-particle-read]
  memory: []
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "xinbangAdapter.search(query) 返回内容信号候选；无 key 返回 [] 不抛错；不带 fit_score"

- task: "prospecting-rules 双层配置"
  agent: prospecting
  contract_task_id: ct-prospecting
  skills: [data-particle-read]
  memory: []
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "mergedProspectingRules 读 config_store ⊕ 出厂默认；sources 不增删条数"

- task: "三个 MCP 工具 Action 注册"
  agent: prospecting
  contract_task_id: ct-prospecting
  skills: [data-particle-read]
  memory: []
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "prospecting-search/select 只读不写；confirm 每企业返回 decision_id；fit_score 仅服务端计算（适配器不注入）"

- task: "批量入池 + 溯源弱边"
  agent: prospecting
  contract_task_id: ct-prospecting
  skills: [data-particle-read]
  memory: []
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "CRM_DEAL S0 source=prospecting + DEAL--sourcedFrom-->KNOWLEDGE 弱边(conf=fit_score)；重复企业 existing:true 跳过"

- task: "前端拓客 Tab（后补）"
  agent: review-gate
  contract_task_id: ct-review-gate
  skills: [data-particle-read]
  memory: [review-gate]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "lead-pool.html 拓客 Tab 调同一后端 Action 可圈选入池"
```

### A.2 契约说明（人读）

本设计共 **7 个任务**，主要承接智能体为 `prospecting`（**新注册 agent**，见 A.3）与既有 `review-gate`；`connector-qixin`/`connector-xinbang` 为**适配器**（嵌入 `prospecting` 调用，不注册 agent）。每个任务带可验证成功判定（防假绿）。所有写操作走第 0 闸；数据源 `search()` 无凭据即返回 `[]`（fail-open）。

### A.3 `prospecting` agent 注册（writing-plans 前置 Task）

P7 契约自检命令：`node scripts/validate-contract.mjs docs/2026-09-14-prospecting-module-design.md --registry src/agent/agentSpec.js`。
`src/contract/contractParser.js:112-131` 校验规则：`--registry` 时契约 `agent` 必须存在于 registry，且 `skills` ⊆ `agentSpec.capabilities.skillCalls`、`memory` ⊆ `agentSpec.memory.read`、`knowledge_scope.layers` ⊆ `capabilities.knowledgeScope.layers`。
因此 **writing-plans 首个 Task 必须注册 `prospecting` agent**：

```js
// src/agent/agentSpec.js 新增（对齐 4-agent 六段式）
'prospecting': {
  identity: { name: 'prospecting', derivedFrom: 'taskFlow:crm-prospecting', autonomy: 'recommend' },
  capabilities: {
    actions: ['data-particle-read', 'prospecting-search', 'prospecting-select', 'prospecting-confirm', 'crm-account-360'],
    skillCalls: ['data-particle-read', 'prospecting-search', 'prospecting-select', 'prospecting-confirm'],
    knowledgeScope: { layers: ['L1'], maxHops: 2 },
  },
  context: { knowledgeLevel: 1, coverage: '>=80%', coldStart: 'adaptive' },
  memory: { read: ['intake-router'], write: [] },
  evaluation: { metricTemplate: 'prospecting_quality', evaluator: 'stage2' },
  governance: { approvals: ['critical'], concurrency: 3, profile: 'full' },
}
```

> 注：`agentTool:true` 的 `prospecting-*` Action 必须同步登记于 `capabilities.actions`（agents.js:77 skillCalls⊆actions 硬闭包）与 `src/action/seed-actions.js` method-* 数组（装配闭包三处同改铁律）。

---

## §B 闭环回写

| 阶段 | 动作 | 载体 |
|---|---|---|
| 运行期监控 | workbench 解析 contract-yaml，跟踪 skill/memory/success | `docs/2026-09-14-prospecting-module-design.feedback.json` |
| 反馈吸收 | 同 (task,gap_type) 复发 ≥2 次 → 提 SKILL 改进提案（需显式批准） | 本文 `## 闭环回写` 表 |
| 契约校验 | `node scripts/validate-contract.mjs docs/2026-09-14-prospecting-module-design.md --registry src/agent/agentSpec.js` | P7 自检（A.3 先行） |

---

## §C 硬约束与红线（贯穿实现）

1. **不新增粒子类型**（遵守 2026-09-08 已批设计 §10）——拓客只用 `CRM_DEAL` S0 + 事件/会话（内存）
2. **禁 DELETE**——连接器/拓客只增改，不删除
3. **写走第 0 闸**——`prospecting-confirm` 必须 mint decision_id（非 'pending'）
4. **租户隔离**——候选/写全部透传 tenantId
5. **配置驱动**——ICP/信号权重/候选上限/数据源全从 config 读，禁硬编码
6. **付费源默认关闭**——qixin/xinbang `enabled:false`，需显式授权+填 key（D1）
7. **fail-open 数据源**——search 无凭据/异常返回 `[]`，不抛业务异常
8. **查重不重复入池**——复用赢家，已存在企业跳过
9. **fit_score 服务端计算（修订 2）**——适配器不得注入/伪造 fit_score，统一由 `mergedProspectingRules` 信号加权算出
10. **sourcedFrom 主语统一（修订 1）**——拓客弱边一律 `CRM_DEAL --sourcedFrom--> CRM_KNOWLEDGE`，不引入 ACCOUNT 主语

---

*文档结束 · 下一步：prospecting agent 注册（writing-plans 前置）→ P7 契约自检 → 移交 writing-plans（P9）*
