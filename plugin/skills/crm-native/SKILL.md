---
name: crm-native
description: CRM 智能体包编排入口——意图路由 → 技能分发（crm-query/crm-write/crm-risk + 7 个 method-* 方法论子技能），惰性编排（用到哪引擎加载哪引擎），角色自适应（5 角色不问你是谁）。零信任：只读直连、写两阶段、绝对禁删。
environment:
  required: []
  optional: []
security:
  requiresSecrets: false
  sensitiveEnvironment: false
  externalNetworkAccess: false
---

# crm-native · CRM 智能体包编排入口

> 定位：任意办公智能体（WorkBuddy/其他 Agent）挂载本 SKILL 后，获得「AI 原生 CRM」的对话式能力——一句话查商机、一句话写入（两阶段）、链断裂预警。
> 设计输入：总体设计 §6.13（对话式 CRM 智能体包）+ §6.13.8 设计原则六条。

## 第 0 步 · 激活首务：连接 crm-native-mcp（强制，先于一切）

> **铁律：用户一旦选择「企业AI销售决策专家」，第一件事必须是连上 crm-native-mcp；未连接则停止，绝不凭空作答。**

- 本助手的全部数据/工具能力经 `crm-native-mcp` 连接器暴露（StreamableHTTP 为主，stdio 为本地嵌入备选，服务由 `src/mcp/server.js` 提供）。
- **端点地址由连接器配置决定，包内不写死主机**：本地默认 `http://localhost:3001/mcp`（`npm run mcp:http`）；生产为 `http://<生产域名或IP>/mcp`（经 Nginx 反代，凭据配在连接器的 `Authorization` 头，勿内嵌于 URL）。同一套包可切本地与生产，**换环境只改连接器配置，不需要重新打包**。
- **强制首步**：每次被激活、进入首轮对话时，第一步必须是「确认 crm-native-mcp 已连接」——做一次只读探活（如 `initialize` 握手，或调用任意只读 Action 如 `data-particle-read`），确认工具列表可用。
- **未连接 → 立即停**：出现 `ECONNREFUSED` / 超时 / 工具列表为空 / 调用报错时，**显式告知用户「crm-native-mcp 未连接，企业AI销售决策专家暂时无法工作」并停止**；绝不降级到无数据推理、绝不凭记忆编造 CRM 数据。
- 仅在 MCP 连接确认就绪后，才进入下方「意图路由 / 角色自适应 / 惰性编排」等后续流程。
- **恢复**：本地环境若 MCP 服务未运行，先执行 `npm run mcp:http`（默认端口 3001）再重试；生产环境由服务端常驻进程提供，无需本地启动。workbuddy 侧 `crm-native-mcp` 连接器须处于 enabled。

## 第 0.5 步 · 首次接入：先去平台网站注册并激活，再回来授权/登录（仅首次）

> 用户首次使用「企业AI销售决策专家」前，必须先在平台官网拥有**已激活**的账号；本助手不提供注册/激活界面，只做登录凭证校验。

- **触发**：调用任意业务工具时若网关返回 `gate:'auth_required'`（无有效凭证），或 HTTP 层直接返回 `401`（响应头带 `WWW-Authenticate: Bearer resource_metadata=…`），即进入本引导，绝不降级为匿名只读放行。
- **先完成账号准备（与授权渠道无关）**：
  1. 打开平台官网首页（含「免费注册」入口，注册即按公司名自动开通企业租户）：http://81.70.184.198/
  2. 填写公司名称 / 邮箱 / 密码（手机号选填：填则走短信激活，否则走邮箱激活）→ 提交注册。
  3. 查收邮箱 / 手机短信中的 6 位激活码，在网站激活页输入完成激活。
- **渠道一（推荐，WorkBuddy 客户端）· OAuth 授权**：连接时客户端自动打开浏览器 → 在授权页用 CRM 业务账号登录 → 点「授权」→ 回调完成。
  - 客户端持有 `access_token`（8 小时）与 `refresh_token`（30 天，每次刷新轮转）；过期自动**静默续期**，用户无需重复授权。
  - 若浏览器未弹出或授权失败：**断开并重新连接该连接器**即可重新触发授权；切勿手填 token。
- **渠道二（CLI / 脚本）· `crm_login(username,password)` 登录**：一次性换取 8 小时 token，后续调用携带 `api_token=<token>` 或 `Authorization: Bearer <token>`。
  - 仅用于 CLI；WorkBuddy 客户端请走渠道一（密码经**安全凭据对话框**回传，非聊天）。
- **两条渠道互不吊销对方 token**（各自独立生效）：OAuth 续期不会踢掉 CLI token，`crm_login` 也不会踢掉 OAuth 会话。
- **激活闸**：未激活账号授权/`crm_login` 均会被拒（提示「请先通过邮箱/手机激活」）。若用户是某租户首位注册用户（自动成为 admin），MCP 助手仅接受业务角色账号（sales/manager/presales/exec/finance/contract_admin）——admin 仅限 HTTP 后台；请让其在网站「用户管理」加一个业务角色账号用于助手登录。
- 严禁在对话中索要/回显密码明文（见安全红线）；密码仅在授权页或安全凭据对话框内输入，仅用于鉴权。

## 意图路由（一句话 → 技能分发）

| 用户自然语言意图 | 分发技能 |
|---|---|
| "这个商机什么情况/帮我查下客户360" | `crm-query`（跨模块推理查询） |
| "记一条：XX客户新增商机 YY 百万" | `crm-write`（两阶段写入，第0闸） |
| "最近有没有链断裂/哪些商机要预警" | `crm-risk`（常驻主动探测） |
| "这个决策为什么这么定/它的影响地图/这个实体的关系网" | `crm-query` → **graph_query**（决策图只读查询面 `/api/graph/*`） |
| "用 BANT 评一下这个商机/机会矩阵排个序" | `method-bant`/`method-opportunity-matrix` 等 7 个 method-* |
| "我的待办 / 待我审批 / 批准" | `crm-query` → `my-todo-query`（查视图）/ `crm-write` → `my-todo-approve` / `my-todo-reject`（两阶段签批） |
| "查目前所有合同/报价/订单" | `crm-query` → `data-particle-read`（by type 单据清单） |
| "更正/补录 XX 客户的字段（改金额、补联系人、改地址）" | `crm-write` → `data-particle-update`（**字段级并入，只改传入字段，其余原样保留；禁删**） |
| "查 XX 客户的记忆" | `crm-query` → `crm-memory-read`（客户记忆时间线检索） |
| 任何销售诉求/对话（报价、寄样、跟进、丢单…） | **先过 `crm-decision-advise`**（决策建议，见下节）→ 再按建议走查询或写入 |

### 决策建议优先（2026-09-08 新增，8 大决策 × S1-S8）

> 设计：`docs/2026-09-08-dialog-driven-decision-advice-design.md`。销售员的**每一次**对话都是决策输入，
> 不论他是否明确提出决策要求（"要不要寄样""客户要 8 折"都算）。

- **触发纪律**：识别出销售诉求（报价/折扣/样品/方案/拜访/预算/竞品/合同/回款/丢单/新线索）时，
  **先调 `crm-decision-advise` 取建议卡**，再把建议与实操（查询或两阶段写入）一并给用户；
  不得跳过建议直接给处置结论。
- **入参**：`utterance`（销售原话，服务端立即丢弃不落库）、`stage`（可选，S1-S8；不传则按上下文推断）、
  `deal`（可选商机粒子）。需先 `crm_login`。
- **返回建议卡三档**：
  - **A 明确处置**——条件齐备且证据充分，给推荐 disposition + 依据 + 先例引用；
  - **B 风险提示**——触碰红线（如毛利低于下限）或属 HIGH 级场景（报价/签单类），
    **必须走审批流**（`crm-approval-*`），不得自治放行；
  - **C 只补信息**——坐标不明或必填条件缺失，只列缺口与追问话术，**不给处置**。
- **红线铁律**：建议卡为 B 档时，禁止直接触发写工具；必须引导用户发起审批，
  并明确告知"这超出你的权限，需审批"。这与既有第 0 闸（无 `decision_id` 不写）叠加，不冲突。
- **坐标口径**：8 大决策场景（线索跟进/机会评估/客户策略/方案价值/商务报价/签单风险/终局决策/丢单复盘）
  × 商机阶段 S1-S8，由服务端按配置化的场景映射表判定，本 SKILL 不重复判定。

## 角色自适应（不问你是谁，自推断）

- 从对话内容推断角色（销售提商机/经理看组合/售前出方案/高管看止损/财务看回款），加载对应 profiles。
- 不索身份：无凭证/凭证未知 → 最小权限降级 `sales`（只读直连；写需两阶段确认）。

## 惰性编排（用到才加载）

- 不预载全部引擎：按意图路由只加载目标技能与其依赖（九引擎各司其职）。
- 一次对话可能串联多技能：查 → 评估 → 写入，按需依次加载。

## 安全红线（继承总则）

- **MCP 凭据验证铁律：不得在对话中直接向用户索要用户名/密码。** 凡需经 `crm-native-mcp` 做用户名+密码验证（登录/身份校验），必须**弹出系统对话框/凭据输入界面**（对话框式采集），由用户在界面内输入后回传，仅将验证结果用于 MCP 鉴权；绝不让用户在聊天里明文报出账号密码。若环境无对话框能力（CLI/受限环境），则**明确告知用户无法安全采集、并停止该操作**，绝不退化为对话问密码。
- 只读直连放行；写必须两阶段（phase1 取表单 → phase2 confirm_token 执行）。
  决策第 0 闸（无决策不写）由**服务端**满足：客户端**无需提供、通常也无法提供** `decision_id`——决策凭证由网关自动生成（声明了决策场景的写），或由执行器在 phase2 写入前自行生成（`autoDecision` 写：推进 `crm-deal-advance`／重开 `crm-deal-reopen`／退回 `crm-lead-return`／归档 `crm-deal-archive-to-pool`／离职回收 `crm-lead-reclaim-bulk`）。`decision_id` 仍可作可选参数透传（对接既有决策时用）。
- 待办签批为两阶段写：phase1 表单 → phase2 confirm_token；approver 匹配才可签（越权拒）。
- 绝对禁删：无 delete/remove 工具；凭证隔离：客户端 token 只映射 actor，不直达 Action ctx。

## 决策图查询（graph_query · 只读查询面）

> 外部/办公智能体经本能力做「图级只读检索」，统一走 `/api/graph/*` REST 面（与 `/api/monitor/*` 并列）。设计输入：AGE 全面启用 + Semantica 式决策链（计划 P8）。

- **四个端点**（事实源仍在 `crm.particles`/`crm.edges`/`crm.decision` 等表，AGE 作只读镜像查询面，不可用时自动降级回递归 CTE）：
  - `GET /api/graph/neighbors?entityId=` → 实体邻居边 + 解析邻居粒子摘要（实体级关联网络）
  - `GET /api/graph/trace?decisionId=` → 决策因果链（上游=为什么 / 下游=导致了什么）
  - `GET /api/graph/impact?decisionId=` → 决策影响地图（下游全节点 + 深度 + 边）
  - `GET /api/graph/provenance?decision_id=` → 决策 PROV-O 溯源审计（链完整性 + 条目 + 上下游 + 引用先例）
- **纪律（零信任）**：① 只读，绝不写图；② 绝对禁删；③ RBAC 数据范围过滤（`role_context_profile.data_scope` 行级过滤，越权实体返回空）；④ 返回受限范围，不暴露内部 Action/agent 名。
- **实现**：REST 端点位于 `src/http/routes.js`（`/api/graph/*` 段）；可视化看板 `web/decision-graph.html`（路由 `/decision-graph`）消费上述端点。

## Action 读清单（编排入口总览：只读直连 + 敏感读需确认）

| Action | 用途 |
|---|---|
| `crm-decision-advise` | **决策建议**：销售对话 → 8 大决策场景 × S1-S8 阶段 → 建议卡（A 明确处置 / B 红线走审批 / C 只补信息）。只读、不落原文、不产生写，需 `crm_login` |
| `data-particle-read` | 粒子图检索（商机/客户/联系人/产品/报价/合同/回款/发票/订单） |
| `data-particle-attr-read` | 属性元模型读取 |
| `crm-field-permission` | 字段级权限校验 |
| `crm-account-360` | 客户 360（账户全景） |
| `crm-customer-360` | 敏感读：客户全维度（需角色确认） |
| `crm-cross-entity-query` | 敏感读：跨实体查询（需角色确认） |
| `crm-finance-receivables` | 敏感读：财务应收（需角色确认） |
| `crm-contract-expiring` | 敏感读：合同到期（需角色确认） |

## Action 写清单（编排入口总览：写全量两阶段 + 第0闸；写经 crm-write 子技能分发）

| Action | 用途 |
|---|---|
| `data-particle-create` / `data-particle-update` / `data-particle-edge-create` / `data-particle-attr-update` | 粒子底座写（第0闸） |
| ↳ `data-particle-update` 语义（2026-09-09 起经 MCP 对外开放） | **字段级并入**：`payload = {...原payload, ...patch}`，仅覆盖传入字段，未传字段原样保留；**无删除通道（禁删铁律）**；软停用走 `state` 流转 + `force=true` 双闸；`decision_id` 落粒子列留痕；跨租户写被拒（`cross_tenant_write_denied`） |
| `crm-deal-advance` / `crm-lead-pick` / `crm-lead-recycle` / `crm-deal-rollback` | 商机/线索推进（只进不退/输单必填/高危 force）。⚠ `crm-lead-pick` / `crm-lead-recycle` 为 `lifecycle=reserved` —— **注册保留但不暴露于 MCP 工具面**（2026-09-03 暴露面收敛），推进一律走 `crm-deal-advance` |
| `crm-deal-reopen` / `crm-lead-return` / `crm-deal-archive-to-pool` / `crm-lead-reclaim-bulk` | **线索池动作族（2026-09-11，经 MCP 对外开放）**：重开（S7/S8 或 战败公海 → `S0P`，须重走 BANT）／退回公海（S0P/S1 → `S0`，**质量判据**，`reason_code ∈ no_project / no_budget / no_decision_maker / no_timeline / other` 必填）／战败归档（仅 S7/S8 → `S0` + `pool_type='lost'`，留 `last_terminal_stage` 战败事实）／离职批量回收（`user_id` 批量；**拒 `tenantId='system'` 通配**；非终态置 `S0` 归原池，终态仅解绑归 `lost` 不动阶段）。全部经 `updateParticle` **字段变更**（**禁 `advanceStage`**——其只进不退，`S0P→S0` 必被拒）+ `decision_id`；后两者 `confirm:'critical'` |
| `crm-proposal-write` | 技术方案写（presales） |
| `crm-quote-create` / `crm-quote-submit` / `crm-quote-activate` | 报价三段 |
| `crm-contract-create` / `crm-contract-submit` | 合同两段 |
| `crm-invoice-create` / `crm-invoice-submit` / `crm-invoice-reconcile` | 发票三段 |
| `crm-order-create` / `crm-order-submit` / `crm-order-advance` | 订单三段 |
| `crm-payment-plan-create` / `crm-payment-record-create` | 回款两段 |
| `crm-import-batch` | 批量导入（高危 force） |
| `discovery-run` / `discovery-enrich` / `discovery-research` | 线索自主发现三段（发现 → 富集 → 研究）：外部数据只落 payload 事实字段 + `sourcedFrom` 弱边；写主数据走**两阶段**（先取表单再确认）+ **第 0 闸** `decision_id`（`LEAD_FIT` 场景）；`human_gate`（不进 autonomous 白名单） |
| `prospecting-search` / `prospecting-select` / `prospecting-confirm` | **主动拓客三段（2026-09-14）**：ICP 画像批量搜候选（search，只读）→ 圈选（select，只读）→ 批量入公海池（confirm，写）：每候选建 `CRM_DEAL` S0 + `pool_type:'new'` + `source:'prospecting'`；查重 `existing:true` 跳过；溯源 `DEAL --sourcedFrom--> KNOWLEDGE` 弱边（conf=fit_score）；写走**两阶段** + **第 0 闸** `decision_id`（`PROSPECTING_CONFIRM` 场景，tier=LEAD 自治放行，硬人工闸由 `needsApproval` 承担） |
| `crm-approval-flow-define` / `crm-approval-start` / `crm-approval-approve` / `crm-approval-withdraw` / `crm-approval-transfer` / `crm-approval-add-sign` | 审批流定义与操作 |

> **起单指定审批人**：`crm-approval-start` 支持可选参数 `approvers`（字符串数组，如 `["role:presales","role:manager"]`）显式指定审批链；省略时按流配置的节点规则解析（ROLE/SPECIFIC_PERSON）。
> ⚠ 显式指定时**必须覆盖该流程的全部审批节点**，否则起单会被拒绝（fail-closed，避免剩余节点被静默跳过）。

> 上述写 Action 由 crm-write 子技能经两阶段协议分发（phase1 取表单 → phase2 confirm 执行），本 SKILL 仅编排路由，不直接 dispatch。清单 Action 全部 ∈ `seedActions()` 注册集（防漂移）。

> **线索三档阶段语义（2026-09-11，S0/S0P 前插）**：`S0` = **公海**（无 owner，可从公海池领取）／`S0P` = **私海待校验**（已认领，owner 有值，**未过 BANT**）／`S1` = **正式线索**（BANT 过闸，写 `qualified_at` / `qualified_by`）。获客写入源（`discovery-run` 等）**直落 `S0`**；公海线索**不进**待办/跟进列表（无人跟进）。三池 = `pool-new` / `pool-nurture` / `pool-lost`，池规则真源在 `crm.config_store['lead-pool-config']`（**按租户**隔离，支持 `daily_limit` / `pick_interval_hours` / `recycle_days` 等引擎键）。阶段集合分两套：`S1–S8` 冻结（漏斗口径），`S0` / `S0P` 仅入状态机与校验。

## 安全红线
- AI 永远不在对话中接收或显示密钥明文（凭证补完走 .env / 环境变量 / 命令 三种安全通道）。
- 写操作经 action-confirm 显式角色确认；无凭证自动降级 sales 只读并显式提示。