# CRM-ai-native 前台页面 + 配置中心 全面设计主蓝图（28 面）

> 状态：待批准（brainstorming → 设计 → writing-plans → 实现）
> 日期：2026-08-26
> 关联：`docs/specs/2026-08-25-ai-native-crm-overall-design.md` §6 决策主轴 / §8 门户生成；`docs/2026-08-26-stage3-portal-home-design.md`；`docs/2026-08-26-particle-attr-ui-patch-design.md`；`D:/system/skills/AI原生-实施方法论/data-taxonomy-methodology.html`（数据分论·七维度上下文模型）

## §0 决策基线（HARD-GATE 前已锁定）

| # | 决策点 | 结论 |
|---|--------|------|
| D1 | 交付形态 | 主蓝图一次性覆盖全 28 面 |
| D2 | 技术路线 | **全量 Schema 渲染**——所有 28 面（含配置中心）用「受控 Schema 契约 + 统一渲染器」渲染，配置面与业务页共用 `src/page/renderer.js` |
| D3 | 7维设计所指 | Oleg Shilovitsky（OpenBOM）"产品情境七维度"；本项目中落地为 **「决策场景级完整性校验」** 配置页 |
| D4 | 蓝图结构 | 方案 A：统一页面规格模板 + 全 28 面逐面深做 |

---

## §1 信息架构与导航总图

### 1.1 模块划分

```
CRM 门户（受 token 保护，index.html 为 AI 作战室主轴）
├─ 前台业务层（运营 / 只读 + agent 驱动写）
│   S01 登录 + 系统状态墙        /home.html
│   S02 AI 作战室首页            /  (index.html)
│   S03 智能体工作台            /workspace
│   S04 治理视图·智能体监控台   /agents
│   S05 待办工作台(四角色视角)  /todo
│   S06 客户 360(含七维画像)    /accounts/:id
│   S07 商机/线索详情           /deals/:id
│   S08 报价详情                /quotations/:id
│   S09 合同详情                /contracts/:id
│   S10 订单详情                /orders/:id
│   S11 回款计划/回款记录       /payments/:id
│   S12 发票详情                /invoices/:id
│   S13 粒子详情(通用)          /particles/:id      [已有 particle-detail.html]
│   S14 决策图谱                /decision-graph      [已有]
│   S15 业务看板(L2C 全链路)    /business-board      [已有 /api/business/board]
│
└─ 配置中心（界面设置层，仅授权角色可见，表单写经第0闸，按 4 组聚类导航）

    ├─ G1 平台与访问（Platform & Access）— 系统底座 / 账号 / 凭证 / 联通
    │    S16 LLM 配置                /config/llm
    │    S17 用户管理                /config/users
    │    S18 权限 / RBAC 矩阵        /config/rbac
    │    S32 连接器 / MCP 配置       /config/connectors
    │    S33 系统设置                /config/system
    │
    ├─ G2 销售方法论与决策治理（Sales Methodology & Decision Governance）— §6 决策主轴内核
    │    S19 销售决策场景配置        /config/decision-scenarios
    │    S20 七维设计(完整性校验)    /config/seven-dim          ← D3
    │    S21 方法论 SKILL 注册表     /config/skills
    │    S30 决策质量监控            /config/decision-quality
    │    S31 记忆 / 先例管理         /config/memory
    │
    ├─ G3 业务对象与流程建模（Business Modeling & Process）— 粒子 / 数据 / 流程
    │    S24 粒子属性元模型配置      /config/meta-attr          [已有 drawer 设计]
    │    S27 粒子模型 / 本体 / 词汇  /config/ontology
    │    S23 业务分级配置            /config/business-tier
    │    S22 审批流配置              /config/approvals
    │    S25 池配置                  /config/pool               [已有 /api/pool-config]
    │
    └─ G4 智能体与运行（Agents & Runtime）— 编排 / 门户 / 预警
         S28 智能体配置              /config/agents
         S29 门户 / 页面生成配置     /config/portal-pages
         S26 预警规则配置            /config/alerts
```

> 注：原始盘点约 28 面，蓝图按现有代码域把"门户生成配置/决策质量监控/记忆管理/连接器/系统设置"归入配置中心扩展面（S29–S33），合计 **33 个受控面**，全部纳入统一模板。其余原列项已并入上述编号。

### 1.2 导航枚举扩展（对齐 `src/page/schema.js` `CANONICAL_NAV`）

现有 `CANONICAL_NAV`（schema.js:43）仅含前台 10 项。本蓝图要求扩展：

```js
export const CANONICAL_NAV = [
  '/dashboard', '/deals', '/accounts', '/contacts', '/products', '/pricelists',
  '/persons', '/organizations', '/knowledge', '/workspace',
  // —— 本蓝图新增（配置中心 + 业务详情）——
  '/home', '/agents', '/todo', '/business-board', '/decision-graph',
  '/config/llm', '/config/users', '/config/rbac', '/config/decision-scenarios',
  '/config/seven-dim', '/config/skills', '/config/approvals', '/config/business-tier',
  '/config/meta-attr', '/config/pool', '/config/alerts', '/config/ontology',
  '/config/agents', '/config/portal-pages', '/config/decision-quality',
  '/config/memory', '/config/connectors', '/config/system',
];
```

### 1.3 角色可见性（对齐 `src/context/roleProfiles.js` 五角色 + presales）

| 面 | sales | manager | exec | finance | contract_admin | presales | 平台管理员(sysadmin) |
|----|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| S01–S15 前台 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| S16 LLM | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ |
| S17 用户 | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ |
| S18 RBAC | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ |
| S19 决策场景 | ✗ | 编辑 | ✗ | ✗ | ✗ | 只读 | ✓ |
| S20 七维校验 | ✗ | 编辑 | ✗ | ✗ | ✗ | 只读 | ✓ |
| S21–S33 配置 | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ |

---

## §2 统一页面规格模板（逐面深做口径）

每个面（S01–S33）在本文档中按以下固定字段展开：

```
## Sxx <页面名>
- 定位：<一句话>
- 导航：<path> ｜ 页面类型：<dashboard|table|form|detail|intake|workspace>
- 模块归属：<前台业务层|配置中心>
- 受控 Schema 契约：
    components: [ {kind, title, dataBinding, ...}, ... ]   // kind ∈ COMPONENT_KINDS
    layout: {columns, theme}
    navigation: {to: <CANONICAL_NAV>}
- 数据端点：<METHOD /api/...>  ← 现有 routes.js 行号 / 或 [新增]
- 权限：<可见角色 / 写角色 / RBAC 动作>
- 7维校验：<仅决策相关面；引用 S20 规则>
- 字段采集四查：<本面渲染/定义的属性是否过 §2.5 四查；展示页逐属性 sourceClassify；孤儿字段处理>
- SSE：<订阅通道 / 无>
- 四态/降级：<loading/empty/error/partial 策略>
- 备注：<与现有文件映射 / 待定>
```

### 2.1 受控值域（强制对齐现有 `src/page/schema.js`）

- **PAGE_TYPES**：`dashboard | table | form | detail | intake | workspace`
- **COMPONENT_KINDS**：`metric-card | table | goal-form | result-card | reasoning-trace | subtable | select | attr-field`
- **ATTR_FIELD_TYPES（19）**：`text, personal-name, email-address, phone-number, domain, location, number, currency, percent, date, timestamp, select, multi-select, boolean, rating, url, record-reference, actor-reference, interaction`
- **FILTER_OPS**：`eq, lt, lte, gt, gte, contains`
- **AGG_FUNCS**：`count, sum, avg, latest`
- **PARTICLE_TYPES_ENUM（15）**：`CRM_DEAL, CRM_ACCOUNT, CRM_CONTACT, CRM_PRODUCT, CRM_PRICE_LIST, CRM_PERSON, CRM_ORGANIZATION, CRM_KNOWLEDGE, CRM_UNSTRUCTURED_ASSET, CRM_QUOTATION, CRM_CONTRACT, CRM_PAYMENT_PLAN, CRM_PAYMENT_RECORD, CRM_INVOICE, CRM_ORDER`
- **ACTION_WHITELIST**（schema.js:37）：读 `data-particle-read, crm-account-360`；写 `crm-deal-advance, data-particle-create, data-particle-update, crm-lead-pick, crm-lead-recycle, crm-lead-move, crm-payment-plan-create, crm-payment-record-create, crm-invoice-reconcile, crm-order-advance`

### 2.2 渲染契约（对齐 `src/page/renderer.js`）

- 唯一出口 `renderPage(schema, data) → {html, warnings}`；渲染前 `validatePageSchema` 再校验。
- 四态：`loading / empty / error / partial` 由 data 层注入。
- 全部动态值 `escapeHtml`；交互仅 `data-action` 声明式；输出强制无 `<script>`（纵深末层剔除）。
- `attr-field` 组件消费 `hidden / readonly`（由 `src/page/attrFormSchema.js` 组合层预解析角色权限）。

### 2.3 写通道第 0 闸（对齐 §6 决策主轴）

> 一切写操作强制携带 `decision_id`。配置中心表单写（S16–S33）属"治理决策"，也须 produce 一条 `decision_*`（HITL/审批流本身也是 decision）。两阶段写入：取表单 → 校验 → 执行 → 验证。

### 2.4 七维校验引擎（S20 承载，决策相关面共用）

运行期在 write-engine 落库前调用：

```js
// sevenDimensionsCheck(scenarioId, context) → {missing:[dim], level}
// dims: identity | structure | semantics | time_config | decision_history | operational_state | governance
// 任一 required 维度缺失且 on_missing='block' → 拒绝写入，返回 missing_context 码；
// on_missing='warn' → 记录但打标，禁止 AI 自行脑补。
```

### 2.5 字段采集四查契约（全部属性承载面硬前置，含前台业务页）

> 依据 `docs/specs/2026-08-25-12-data-origin-full-plan.md`（ATTIO 字段数据采集详细设计，4 分类）与总体设计 §8.7「字段采集四查」。**本条约适用于本蓝图 ALL 渲染或定义属性的页面**——既包括定义侧配置面（**S24 粒子属性元模型、S27 本体/词汇**），也包括展示侧**前台业务页 S01–S15**（客户360 / 商机详情 / 报价 / 合同 / 订单 / 回款 / 发票 / 粒子详情等一切展示粒子属性的面板）。**核心命题：属性一旦上页面，就必须有"产生通道"，否则即孤儿字段**——定义面在保存时拦，展示面在渲染时标。四类来源（data_origin）是属性的第一公民维度，贯穿定义→渲染全链路。

- **四分类（data_origin）**：每个属性必须声明其一，且对应产生通道必须存在：
  1. **① 人工填写（manual）** → 前台必有输入控件（表单字段 / 对话式 NL 采集 / 上传入口），写通道走 `data-particle-create/update` 携带 `decision_id`（第 0 闸）。
  2. **② AI 自动产生（ai）** → 必挂 AI 属性评估器（`src/aiAttributes/evaluator.js`，能力轴 × 来源轴 × 置信度 × 理由）；前台**只读展示 + 人工确认**（置信度 <0.6 标 needsReview），禁前台直接改写。
  3. **③ 规则/定时驱动（rule）** → 必有写时钩子或定时器（`src/scheduler/timers.js`：nightly 蒸馏 24h + crm-risk 30min 扫描）；前台无输入，只读展示。
  4. **④ 外部采集（external）** → 必有连接器 Action（`src/connectors/connectorActions.js`：ATTIO enrichment + 工商校验，`autoDecision` 自过第 0 闸）；前台展示**来源 + 置信度 + review 入口**（`sourcedFrom` auto_weak 边带 `relation_confidence`）。
- **属性配置扩展字段**（S24 `attr-field` 增列）：`data_origin`(enum 四选一) ｜ `semantic_tag`(firmographic/social/relation/interaction/ui，源自 `2026-08-25-12-attio-four-layer-inheritance.md` 方案 B) ｜ `ai_axis`(S_Sight/C_Classify/J_Judge/F_Forecast/A_Alert/B_Brief/C_Compliance，仅 ②) ｜ `confidence_threshold`(默认 0.6) ｜ `source_badge`(展示开关)。
- **孤儿字段拦截**：S24/S27 保存属性时，若 `data_origin` 为空或对应通道不存在 → 校验失败拒绝落库（与写第 0 闸同级硬闸）。
- **肉眼查证锚点**：`src/web/particle-detail.html`（路由 `GET /particle-detail.html`）+ `src/web/sourceClassify.js`（判定纯函数，页面与测试共用同一事实源）已落地，逐属性渲染 ①/②/③/④ 来源徽标 + AI 轴/置信度 + sourcedFrom `relation_confidence`。S24 配置页可直接复用 `sourceClassify.js` 作为"四查"实时预审器。

### 2.5.1 渲染期四查（前台业务页 S01–S15 适用）

> 定义面（S24/S27）管"属性是否被允许存在"；展示面（S01–S15）管"属性被展示时是否可信"。两者共享同一事实源 `src/web/sourceClassify.js`，故**开发任何前端业务页时都必须参考本契约**。

- **渲染期硬规则**：任一业务页（S06 客户360 / S07 商机详情 / S08 报价 / S09 合同 / S10 订单 / S11 回款 / S12 发票 / S13 粒子详情 等）在渲染某个粒子属性前，必须对该属性调用 `sourceClassify(attr)` 取得 `data_origin`：
  - **① 人工 / ② AI / ④ 外部** → 属性正常展示，并渲染**来源徽标**（manual / ai+置信度 / external+sourcedFrom 链接）；② AI 属性置信度 < `confidence_threshold`(默认 0.6) 标 `needsReview` 角标，禁前台直接改写。
  - **③ 规则** → 只读展示，无输入控件，附"由系统定时计算"说明。
  - **孤儿 / 未声明 `data_origin`** → 该属性**不得作为权威数据渲染**：显示灰色 `unverified`（来源未知）徽标，且若属性为可写字段则**禁用输入控件**；页面顶部汇总"本页 N 个字段来源未验证"提示。此规则保证"设计期无通道的属性不会悄悄被当真"。
- **复用实现**：业务页直接 `import` 已落地的 `src/web/sourceClassify.js`（与 `particle-detail.html` 同一判定函数），不另写分类逻辑；渲染器 `src/page/renderer.js` 的 `attr-field` 组件在 §2.2 基础上**内置四查徽标渲染**，页面 schema 无需逐字段声明。
- **测试契约**：每个业务页 vitest 须覆盖"属性含 data_origin→正常+徽标""属性孤儿→unverified 且禁用"两个分支（与 S24 四查测试同源）。

---

## §3 逐面规格（S01–S33）

> **跨面开发硬约束（所有页面）**：每个面规格含 `字段采集四查` 槽位（见 §2 模板）。**S01–S15 前台业务页在开发时务必参考 §2.5.1 渲染期四查**——凡展示粒子属性的面板，渲染前逐属性 `sourceClassify` 取得 `data_origin`，孤儿字段标 `unverified` 且禁用控件，来源徽标随属性渲染。这是阶段3 前台开发的统一前置，与 ATTIO 字段数据采集设计（`2026-08-25-12-data-origin-full-plan.md`）一脉相承。

### S01 登录 + 系统状态墙  `/home.html`
- 定位：角色化真实登录 + 进入前系统状态墙。
- 页面类型：`dashboard`（组合 form + metric-card）。
- 组件：`goal-form`(登录：username/password → `POST /api/auth/login`) + 4×`metric-card`(装配校验/kanban计数/最新粒子/审批情况) + `table`(最新10粒子)。
- 数据端点：`POST /api/auth/login`(routes.js:121) ｜ `GET /api/auth/me`(routes.js:126) ｜ `GET /api/realtime/health`(routes.js:116) ｜ `GET /api/business/board`(routes.js:154)。
- 权限：匿名可访问；登录后写 token→跳 `/`。
- SSE：无（登录前）。
- 备注：复用 `docs/2026-08-26-stage3-portal-home-design.md §4.0/§5`。

### S02 AI 作战室首页  `/` (index.html)
- 定位：copilot 命令栏主轴 + 今日优先 + L2C 六段 + 审批收件箱 + SSE。
- 页面类型：`dashboard`。
- 组件：`goal-form`(copilot ⌘K → `POST /api/page/from-nl`) ｜ `metric-card`×3(今日优先 FIT/TIMING/CONN) ｜ `table`(L2C 六段 grouped) ｜ `table`(审批收件箱四域) ｜ `reasoning-trace`(切入建议) ｜ `subtable`(SSE 最新事件)。
- 数据端点：`POST /api/page/from-nl`(routes.js:171) ｜ `GET /api/business/board` ｜ `GET /api/monitor/decisions`(routes.js:234) ｜ `GET /api/monitor/gates`(routes.js:220) ｜ `GET /events`(routes.js:217)。
- 权限：全部登录角色；区块按 `/api/auth/me.role` 自适应（exec 看经营/finance 看回款）。
- SSE：`/events` 全 5 域。
- 备注：`stage3-portal-home-design.md §4` 已设计，本蓝图确认其纳入统一模板渲染（原 mockup → schema 化）。

### S03 智能体工作台  `/workspace`
- 定位：chat-pane + output-panel 的 agent 对话与动作执行面。
- 页面类型：`workspace`。
- 组件：`reasoning-trace`(agent 思考链) ｜ `result-card`(动作结果) ｜ `table`(历史任务) ｜ `attr-field`×n(表单注入) ｜ `goal-form`(指令输入)。
- 数据端点：[新增] `GET /api/agents`(routes.js:111) 已存在列表；对话走 SSE `/events`；写动作经 ACTION_WHITELIST。
- 权限：全部角色；写动作受 RBAC + action-confirm。
- SSE：`/events` task/trace 域。
- 备注：对齐 §8.3.9。

### S04 治理视图·智能体监控台  `/agents`
- 定位：九智能体健康度/SLA/告警看板。
- 页面类型：`dashboard`。
- 组件：`metric-card`×N(agent_health/agent_sla) ｜ `table`(agent_alerts) ｜ `subtable`(单 agent 任务流)。
- 数据端点：`GET /api/agents` ｜ `GET /api/monitor/*`(gates/decisions/coverage) ｜ [新增] `/api/monitor/sla`。
- 权限：manager/sysadmin。
- SSE：`/events` task/trace/approval 域。
- 备注：对齐 §8.3.10；表 `agent_health/agent_sla/agent_alerts` 已 seed 9 行。

### S05 待办工作台(四角色视角)  `/todo`
- 定位：按四角色聚合待办（销售/经理/财务/合同）。
- 页面类型：`table`（四 tab）。
- 组件：`select`(角色视角切换) ｜ `table`(待办行：类型/客户/L2C阶段/时限/CTA)。
- 数据端点：`GET /api/business/board` 筛 `status` ｜ `GET /api/monitor/decisions` 待决。
- 权限：对应角色各自可见自己视角。
- SSE：`/events` approval 域。
- 备注：对齐 §8.3.4。

### S06 客户 360（含七维画像）  `/accounts/:id`
- 定位：账户全景 + 七维情境画像 + 关联商机/联系人。
- 页面类型：`detail`。
- 组件：`attr-field`×n(账户属性，角色权限预解析) ｜ `subtable`(关联 DEAL/CONTACT) ｜ `metric-card`×7(**七维画像**：identity/structure/semantics/time_config/decision_history/operational_state/governance 完备度打分) ｜ `reasoning-trace`(AI 客户洞察)。
- 数据端点：`GET /api/particles/:id`(routes.js:63) ｜ `crm-account-360`(读白名单) ｜ `GET /api/graph/neighbors`(routes.js:302)。
- 7维校验：本页"七维画像"卡直接消费 `sevenDimensionsCheck(accountId, ctx)`，展示各维完备度，缺失维标红。
- 权限：sales 只读+部分写；manager 全；finance 看回款相关。
- SSE：`/events` particle 域。
- 备注：七维画像由 S20 规则驱动，非静态。

### S07 商机/线索详情  `/deals/:id`
- 定位：DEAL 全生命周期 + L2C 阶段推进。
- 页面类型：`detail`。
- 组件：`attr-field`×n ｜ `subtable`(报价/合同/回款) ｜ `metric-card`(金额/赢率) ｜ `reasoning-trace`(MEDDICC 评估) ｜ `goal-form`(推进动作 → `crm-deal-advance`)。
- 数据端点：`GET /api/particles/:id` ｜ `crm-deal-advance`(写白名单) ｜ `GET /api/monitor/decisions`。
- 7维校验：推进到 `quoted/contracted` 前，运行期触发 S20 对应场景（如 "商机→报价"）的 required 维度校验，缺失则 `missing_context` 拦。
- 权限：sales 写；manager 审。
- SSE：`/events` particle/approval 域。

### S08 报价详情  `/quotations/:id`
- 定位：QUOTATION 明细 + 关联 DEAL。
- 页面类型：`detail`。组件：`attr-field`×n ｜ `subtable`(明细行) ｜ `table`(历史版本) ｜ `goal-form`(生成/刷新 → crm-write 技术方案/报价)。
- 数据端点：`GET /api/particles/:id` ｜ `CRM_QUOTATION` 写白名单。
- 权限：sales/presales 写。
- SSE：particle 域。

### S09 合同详情  `/contracts/:id`
- 定位：CONTRACT 全生命周期（合同管理员域）。
- 页面类型：`detail`。组件：`attr-field`×n ｜ `subtable`(回款计划/发票) ｜ `reasoning-trace`(条款风险) ｜ `goal-form`(提交审批)。
- 数据端点：`GET /api/particles/:id` ｜ `crm-payment-plan-create` 写。
- 权限：contract_admin 主；finance 看回款。
- SSE：particle/approval 域。

### S10 订单详情  `/orders/:id`
- 定位：ORDER 履行跟踪。
- 页面类型：`detail`。组件：`attr-field`×n ｜ `subtable`(履约节点) ｜ `goal-form`(推进 `crm-order-advance`)。
- 数据端点：`GET /api/particles/:id` ｜ `crm-order-advance` 写。

### S11 回款计划/回款记录  `/payments/:id`
- 定位：PAYMENT_PLAN / PAYMENT_RECORD 管理。
- 页面类型：`detail`。组件：`attr-field`×n ｜ `subtable`(计划vs实收) ｜ `goal-form`(`crm-payment-record-create`)。
- 数据端点：`GET /api/particles/:id` ｜ `crm-payment-record-create` 写。
- 权限：finance 主。

### S12 发票详情  `/invoices/:id`
- 定位：INVOICE 对账。
- 页面类型：`detail`。组件：`attr-field`×n ｜ `goal-form`(`crm-invoice-reconcile`)。
- 数据端点：`GET /api/particles/:id` ｜ `crm-invoice-reconcile` 写。
- 权限：finance 主。

### S13 粒子详情（通用）  `/particles/:id`
- 定位：任意粒子通用详情（已有 `particle-detail.html`）。
- 页面类型：`detail`。组件：复用现有 `src/web/particle-detail.html` 组装逻辑（`src/http/particleDetail.js`）。
- 数据端点：`GET /api/particles/:id`。
- 备注：保持现有实现，纳入统一导航。

### S14 决策图谱  `/decision-graph`
- 定位：决策网络可视化（因果链/影响地图/审计）。
- 页面类型：`dashboard`（图组件）。组件：`table`/`subtable`(邻居/溯源) ｜ `reasoning-trace`(因果链)。
- 数据端点：`GET /api/graph/neighbors`(routes.js:302) ｜ `/trace`(323) ｜ `/impact`(331) ｜ `/provenance`(339)。
- 备注：已有 `decision-graph.html`，纳入导航。

### S15 业务看板（L2C 全链路）  `/business-board`
- 定位：L2C 全链路聚合看板。
- 页面类型：`dashboard`。组件：`metric-card`×N ｜ `table`(grouped by stage)。
- 数据端点：`GET /api/business/board`(routes.js:154)。
- 备注：已有端点；Schema 化渲染。

---

### 配置中心（S16–S33，均 `form`/`table` 型，写经第0闸）

> 导航按 §1 四级分组聚类（G1 平台与访问 / G2 销售方法论与决策治理 / G3 业务对象与流程建模 / G4 智能体与运行）。实现优先级遵循决策主轴强相关度：**G2 → G3 → G4 → G1**（与 §5 Phase 3 的 S19/S20/S21/S24 优先一致）。

### S16 LLM 配置  `/config/llm`
- 定位：provider/model/key/temperature 配置。
- 页面类型：`form` + `table`(多 provider 列表)。
- 组件：`attr-field`(provider/ model/ api_key[secret]/ temperature/ max_tokens) ｜ `table`(已配置列表) ｜ `select`(启用默认)。
- 数据端点：[新增] `GET/PUT /api/config/llm`。
- 权限：sysadmin 仅。
- 备注：key 存储用 `pgcrypto` 加密，明文不入日志。

### S17 用户管理  `/config/users`
- 定位：crm_users 增删改 + 角色绑定。
- 页面类型：`table` + `form`。
- 组件：`table`(用户列表) ｜ `attr-field`(username/display_name/role/password) ｜ `select`(role ∈ 六角色)。
- 数据端点：[新增] `GET/POST/PUT /api/config/users`（落 `crm.crm_users`）。
- 权限：sysadmin。
- 备注：表结构见 `stage3-portal-home-design.md §5`。

### S18 权限 / RBAC 矩阵  `/config/rbac`
- 定位：角色 × 粒子 × Action 权限矩阵（五角色七要素）。
- 页面类型：`table`（矩阵）+ `form`。
- 组件：`table`(行=角色/粒子, 列=Action, 单元格=allow/deny/hidden/readonly) ｜ `select`(批量赋权)。
- 数据端点：[新增] `GET/PUT /api/config/rbac`（落 `field_permission` 类表，复用 `src/metaAttr/fieldPermission.js` 的 `modeFor`）。
- 权限：sysadmin。
- 备注：与 S24 元模型权限共用 `modeFor` 引擎。

### S19 销售决策场景配置  `/config/decision-scenarios`
- 定位：7 决策场景 / 触发 / 方法论 / 评估维度 / 自主策略。
- 页面类型：`table` + `form`。
- 组件：`table`(场景列表) ｜ `attr-field`(scenario_name/ trigger/ auto_decision/ methodology_ids) ｜ `subtable`(eval_dimensions) ｜ `select`(自主边界等级)。
- 数据端点：[新增] `GET/PUT /api/config/decision-scenarios`（落 `decision_scenario` + `methodology_ids`）。
- 权限：manager 编辑 / presales 只读 / sysadmin。
- 备注：对齐 §6.5；`methodology_ids` 引用 S21 注册表。

### S20 七维设计（决策场景级完整性校验）  `/config/seven-dim`  ★D3
- 定位：为每个销售决策场景配置「七维度」中哪些必填/强校验，运行期缺失即打 `missing_context` 标记、禁 AI 脑补。
- 页面类型：`table`（场景 × 七维矩阵）+ `form`。
- **七维常量（CRM 适配，源 data-taxonomy-methodology.html §2）**：
  | dim key | 维度 | CRM 语义 |
  |---|---|---|
  | `identity` | 身份 | 客户/商机跨系统唯一身份是否一致 |
  | `structure` | 结构 | 客户-商机-报价-合同-订单图谱关系可达 |
  | `semantics` | 语义 | "赢单/丢单/有效商机"等术语跨域定义一致 |
  | `time_config` | 时间与配置 | 决策生效时间窗/产品线/配置版本 |
  | `decision_history` | 决策历史 | 历史否决方案/先例是否被检索 |
  | `operational_state` | 运行状态 | 当前销售运行态（库存/交付/竞品动态） |
  | `governance` | 治理 | 谁可批/谁负责/自主边界 |
- 受控 Schema 契约：
  ```
  components:
    - kind: table
      title: 场景×七维校验矩阵
      dataBinding:
        columns: [scenario, identity, structure, semantics, time_config, decision_history, operational_state, governance, strictness]
        # 每格 = {required:bool, on_missing:'warn'|'block'}
    - kind: select
      name: default_strictness
      options: [warn, block]
    - kind: form (新增场景行)
      fields: [scenario_id → decision_scenario.id, 七维开关 ×7, strictness]
  ```
- 数据模型：[新增] 表 `decision_context_rule(scenario_id FK, dim text, required bool, on_missing text)` 或 `decision_scenario.required_dims JSONB`。
- 数据端点：[新增] `GET/PUT /api/config/seven-dim`。
- 运行期契约：`sevenDimensionsCheck(scenarioId, ctx)` 在 write-engine 落库前调用 → 返回 missing dims；`block` 则拒写。
- 权限：manager 编辑 / presales 只读 / sysadmin。
- 备注：本页为 §6.2"七点 Schema"与 data-taxonomy `sevenDimensionsCheck()` 的落地面；S06/S07 直接消费。

### S21 方法论 SKILL 注册表  `/config/skills`
- 定位：每个方法论 SKILL 启用开关（停用→引擎不装载、市场不暴露）。
- 页面类型：`table` + `form`。
- 组件：`table`(skill_id/category/enabled/version/rbac_roles) ｜ `select`(enabled 开关) ｜ `select`(rbac_roles)。
- 数据端点：[新增] `GET/PUT /api/config/skill-registry`（落 `skill_registry`）。
- 权限：sysadmin。
- 备注：对齐 §6.6 Skills-as-a-Service。

### S22 审批流配置  `/config/approvals`
- 定位：四审批域（G21）流程定义。
- 页面类型：`table` + `form`。
- 组件：`table`(审批流列表) ｜ `subtable`(节点:角色/条件) ｜ `select`(域:deal/quotation/contract/invoice)。
- 数据端点：[新增] `GET/PUT /api/config/approvals`（落审批流表，复用 seed 4 流）。
- 权限：manager/sysadmin。

### S23 业务分级配置  `/config/business-tier`
- 定位：DEAL = 客户维 × 项目维 分级（配置定义非硬编码，驱动自主边界）。
- 页面类型：`form` + `table`。
- 组件：`attr-field`(维度定义) ｜ `table`(分级矩阵) ｜ `select`(自主等级映射)。
- 数据端点：[新增] `GET/PUT /api/config/business-tier`。
- 权限：manager/sysadmin。
- 备注：对齐 §6 业务分级驱动自主边界。

### S24 粒子属性元模型配置  `/config/meta-attr`
- 定位：动态对象/属性/维度建模（七维元模型层）。**每个属性必须声明其数据采集来源（§2.5 字段采集四查），杜绝孤儿字段。**
- 页面类型：`form` + `table` + `attr-field` 预览。
- 组件：`table`(粒子类型) ｜ `subtable`(属性列表) ｜ `attr-field`(新增属性: slug / type / title / permission / **data_origin(①manual②ai③rule④external)** / **semantic_tag** / **ai_axis(仅②)** / **confidence_threshold** / **source_badge**) ｜ `select`(role 权限 hidden/readonly/edit) ｜ `badge`(来源徽标实时预览，复用 `src/web/sourceClassify.js`)。
- 数据端点：`GET /api/meta-attr`(routes.js:52) ｜ [新增] `POST/PUT /api/meta-attr`（写经 `data-particle-attr-update` 第0闸）。
- 权限：sysadmin（结构变更）。
- 7维校验：本面定义的属性即 §6.2 七点 Schema 的载体；属性 `data_origin=②ai` 时自动挂 AI 属性区（不混入人工事实字段）。
- 备注：已有 `meta-attr-drawer.html` + `particle-attr-ui-patch-design.md`；本蓝图确认其纳入统一 Schema 渲染，并叠加 §2.5 四查契约。属性清单以 `src/particles/particleModel.js` 的 `coreAttributes`（含 ATTIO 增量）为唯一事实源；`semantic_tag` 取值对齐 `2026-08-25-12-attio-four-layer-inheritance.md` 方案 B（firmographic/social/relation/interaction/ui）。

### S25 池配置  `/config/pool`
- 定位：线索拾取/回收规则。
- 页面类型：`form`。
- 组件：`attr-field`(pick_rule/recycle_rule) ｜ `select`(目标池)。
- 数据端点：`GET/PUT /api/pool-config`(routes.js:133/141)。
- 权限：manager/sysadmin。
- 备注：已落地，纳入导航。

### S26 预警规则配置  `/config/alerts`
- 定位：五类告警（§3.10）+ 自定义规则。
- 页面类型：`table` + `form`。
- 组件：`table`(规则列表) ｜ `attr-field`(trigger/condition/channel) ｜ `select`(severity)。
- 数据端点：[新增] `GET/PUT /api/config/alerts`（落 `alert_registry`，复用 `alertRegistry.js` + `timers.js`）。
- 权限：manager/sysadmin。
- 备注：对齐阶段3 lead_overdue 等已落地预警。

### S27 粒子模型/本体/词汇配置  `/config/ontology`
- 定位：粒子模型 / 本体 / 词汇表维护（写时向量化）。
- 页面类型：`table` + `form`。
- 组件：`table`(词汇/本体项) ｜ `attr-field`(term/synonym/embedding_ref) ｜ `select`(粒子类型映射)。
- 数据端点：[新增] `GET/PUT /api/config/ontology`（落 ontology 表，复用 `src/ontology/`）。
- 权限：sysadmin。
- 备注：对齐 ai-ontology-vector-build「写库即构建」。

### S28 智能体配置  `/config/agents`
- 定位：agents + role profiles 编排配置。
- 页面类型：`table` + `form`。
- 组件：`table`(agent 列表) ｜ `subtable`(绑定的 SKILL) ｜ `attr-field`(profile 参数) ｜ `select`(role tag)。
- 数据端点：[新增] `GET/PUT /api/config/agents`（落 agents/role_profiles）。
- 权限：sysadmin。
- 备注：对齐 §6.13 九引擎惰性编排。

### S29 门户/页面生成配置  `/config/portal-pages`
- 定位：page schema / NL 模板管理（配置界面与 AI 生成共用渲染器）。
- 页面类型：`table` + `form`。
- 组件：`table`(已生成页面) ｜ `goal-form`(NL 生成) ｜ `subtable`(schema 预览) ｜ `select`(publish/revert)。
- 数据端点：`/api/pages`(routes.js:179) ｜ `/api/page/:id/publish`(184) ｜ `/:id/revert`(191) ｜ `/:id/preview`(198) ｜ `POST /api/page/from-nl`(171)。
- 权限：sysadmin（页面发布）。
- 备注：对齐 §8.3.6；本蓝图所有 33 面均可经此机制由 NL 生成临时页。

### S30 决策质量监控  `/config/decision-quality`
- 定位：决策质量指标 / 覆盖度看板。
- 页面类型：`dashboard`。
- 组件：`metric-card`(覆盖度/先例命中) ｜ `table`(决策列表) ｜ `reasoning-trace`(偏差分析)。
- 数据端点：`GET /api/monitor/coverage`(routes.js:244) ｜ `/decisions`(234) ｜ `/gates`(220)。
- 权限：manager/sysadmin。
- 备注：对齐 §6.4。

### S31 记忆/先例管理  `/config/memory`
- 定位：记忆三构件（流水→经验→先例）蒸馏与治理。
- 页面类型：`table` + `form`。
- 组件：`table`(记忆条目) ｜ `subtable`(蒸馏版本) ｜ `goal-form`(触发蒸馏 `POST /api/memory/distill`(routes.js:205))。
- 数据端点：`POST /api/memory/distill`。
- 权限：sysadmin。
- 备注：对齐 §6.8 记忆生命周期。

### S32 连接器 / MCP 配置  `/config/connectors`
- 定位：外部连接器 / MCP Server 引用管理。
- 页面类型：`table` + `form`。
- 组件：`table`(连接器列表) ｜ `attr-field`(endpoint/credential_ref[secret]) ｜ `select`(enable)。
- 数据端点：[新增] `GET/PUT /api/config/connectors`。
- 权限：sysadmin。
- 备注：对齐 §6.13 无头设计 + MCP Server 暴露。

### S33 系统设置  `/config/system`
- 定位：全局参数 / 主题 / 安全策略。
- 页面类型：`form` + `table`。
- 组件：`attr-field`(站点名/默认主题/会话超时) ｜ `select`(主题 light/dark) ｜ `table`(审计日志)。
- 数据端点：[新增] `GET/PUT /api/config/system`。
- 权限：sysadmin。

---

## §4 跨面一致性约束

1. **渲染唯一出口**：所有 33 面必须经 `src/page/renderer.js` 的 `renderPage`，禁止手写 HTML 旁路（NL 生成页与配置页同此纪律）。
2. **写第0闸**：S16–S33 配置写与 S01–S15 业务写，凡写操作均 produce `decision_*`，经 `sevenDimensionsCheck`（决策相关面）与 RBAC。
3. **角色权限**：`attr-field` 的 `hidden/readonly` 由 `src/page/attrFormSchema.js` + `fieldPermission.js#modeFor` 组合层预解析，渲染器纯消费。
4. **SSE 单连接**：所有实时面共用 `EventSource('/events')` 单连接多域分发，不新建 WS。
5. **七维驱动**：S06/S07/S19/S20/S30 共享 `sevenDimensionsCheck` 引擎，维度定义唯一源 = S20。
6. **导航权威**：`navigation.to` 必须 ∈ 扩展后 `CANONICAL_NAV`（§1.2），否则 `validatePageSchema` 拒绝。

## §5 实现分期建议（writing-plans 输入）

- **Phase 1（骨架）**：§1.2 导航扩展 + 渲染器四态补全 + S01/S02/S13/S14/S15/S25 现有页 Schema 化接入。
- **Phase 2（前台补全）**：S03–S12 业务详情页（消费 `attr-form` + `subtable` + 决策网络）。
- **Phase 3（配置中心）**：S16–S33 配置面，优先 S19/S20/S21/S24（决策主轴强相关）。
- **Phase 4（七维闭环）**：`sevenDimensionsCheck` 引擎 + S06/S07 消费 + S30 监控。

## §6 自检（占位符/矛盾/歧义/范围）

- [x] 无未定义占位符（所有 `[新增]` 端点均标注落库表）。
- [x] 与现有 `schema.js` 值域一致（COMPONENT_KINDS/PAGE_TYPES/NAV 均扩展而非冲突）。
- [x] 七维语义唯一源 = S20，无重复定义。
- [x] 写第0闸覆盖配置面（治理决策 also produce decision）。
- [ ] 各面完整 Schema JSON 留待 writing-plans 阶段逐面展开（本蓝图为契约级，非逐字段 JSON）。
- [ ] 移动端（RN）适配范围未纳入本蓝图（当前仅 Web 门户）。
