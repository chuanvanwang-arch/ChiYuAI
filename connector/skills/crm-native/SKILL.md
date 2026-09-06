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

> **铁律：用户一旦选择「AI 原生销售助手」，第一件事必须是连上 crm-native-mcp；未连接则停止，绝不凭空作答。**

- 本助手的全部数据/工具能力经 `crm-native-mcp` 连接器暴露（StreamableHTTP 为主，stdio 为本地嵌入备选，服务由 `src/mcp/server.js` 提供）。
- **端点地址由连接器配置决定，包内不写死主机**：本地默认 `http://localhost:3001/mcp`（`npm run mcp:http`）；生产为 `http://<生产域名或IP>/mcp`（经 Nginx 反代，凭据配在连接器的 `Authorization` 头，勿内嵌于 URL）。同一套包可切本地与生产，**换环境只改连接器配置，不需要重新打包**。
- **强制首步**：每次被激活、进入首轮对话时，第一步必须是「确认 crm-native-mcp 已连接」——做一次只读探活（如 `initialize` 握手，或调用任意只读 Action 如 `data-particle-read`），确认工具列表可用。
- **未连接 → 立即停**：出现 `ECONNREFUSED` / 超时 / 工具列表为空 / 调用报错时，**显式告知用户「crm-native-mcp 未连接，AI 原生销售助手暂时无法工作」并停止**；绝不降级到无数据推理、绝不凭记忆编造 CRM 数据。
- 仅在 MCP 连接确认就绪后，才进入下方「意图路由 / 角色自适应 / 惰性编排」等后续流程。
- **恢复**：本地环境若 MCP 服务未运行，先执行 `npm run mcp:http`（默认端口 3001）再重试；生产环境由服务端常驻进程提供，无需本地启动。workbuddy 侧 `crm-native-mcp` 连接器须处于 enabled。

## 第 0.5 步 · 首次接入：先去平台网站注册并激活，再回来登录（仅首次）

> 用户首次使用「AI 原生销售助手」前，必须先在平台官网拥有**已激活**的账号；本助手不提供注册/激活界面，只做登录凭证校验。

- **触发**：调用任意业务工具时若网关返回 `gate:'auth_required'`（无有效凭证），即进入本引导，绝不降级为匿名只读放行。
- **引导话术（给用户）**：
  1. 打开平台官网首页（含「免费注册」入口，注册即按公司名自动开通企业租户）：http://81.70.184.198/
  2. 填写公司名称 / 邮箱 / 密码（手机号选填：填则走短信激活，否则走邮箱激活）→ 提交注册。
  3. 查收邮箱 / 手机短信中的 6 位激活码，在网站激活页输入完成激活。
  4. 回到本助手，触发**安全凭据对话框**（见下方红线），输入用户名（邮箱）与密码完成 `crm_login` 登录。
- **仅首次**：`crm_login` 成功后，连接器持久化 token，后续会话自动携带 → 用户无需再次输入用户名密码。
- **激活闸**：未激活账号 `crm_login` 会被拒（提示「请先通过邮箱/手机激活」）。若用户是某租户首位注册用户（自动成为 admin），MCP 助手仅接受业务角色账号（sales/manager/presales/exec/finance/contract_admin）——admin 仅限 HTTP 后台；请让其在网站「用户管理」加一个业务角色账号用于助手登录。
- 严禁在对话中索要/回显密码明文（见安全红线）；凭据仅经安全对话框回传用于 `crm_login` 鉴权。

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
| "查 XX 客户的记忆" | `crm-query` → `crm-memory-read`（客户记忆时间线检索） |

## 角色自适应（不问你是谁，自推断）

- 从对话内容推断角色（销售提商机/经理看组合/售前出方案/高管看止损/财务看回款），加载对应 profiles。
- 不索身份：无凭证/凭证未知 → 最小权限降级 `sales`（只读直连；写需两阶段确认）。

## 惰性编排（用到才加载）

- 不预载全部引擎：按意图路由只加载目标技能与其依赖（九引擎各司其职）。
- 一次对话可能串联多技能：查 → 评估 → 写入，按需依次加载。

## 安全红线（继承总则）

- **MCP 凭据验证铁律：不得在对话中直接向用户索要用户名/密码。** 凡需经 `crm-native-mcp` 做用户名+密码验证（登录/身份校验），必须**弹出系统对话框/凭据输入界面**（对话框式采集），由用户在界面内输入后回传，仅将验证结果用于 MCP 鉴权；绝不让用户在聊天里明文报出账号密码。若环境无对话框能力（CLI/受限环境），则**明确告知用户无法安全采集、并停止该操作**，绝不退化为对话问密码。
- 只读直连放行；写必须两阶段（phase1 取表单 → phase2 confirm_token 执行）+ decision_id（第0闸）。
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
| `crm-deal-advance` / `crm-lead-pick` / `crm-lead-recycle` / `crm-deal-rollback` | 商机/线索推进（只进不退/输单必填/高危 force） |
| `crm-proposal-write` | 技术方案写（presales） |
| `crm-quote-create` / `crm-quote-submit` / `crm-quote-activate` | 报价三段 |
| `crm-contract-create` / `crm-contract-submit` | 合同两段 |
| `crm-invoice-create` / `crm-invoice-submit` / `crm-invoice-reconcile` | 发票三段 |
| `crm-order-create` / `crm-order-submit` / `crm-order-advance` | 订单三段 |
| `crm-payment-plan-create` / `crm-payment-record-create` | 回款两段 |
| `crm-import-batch` | 批量导入（高危 force） |
| `crm-approval-flow-define` / `crm-approval-start` / `crm-approval-approve` / `crm-approval-withdraw` / `crm-approval-transfer` / `crm-approval-add-sign` | 审批流定义与操作 |

> 上述写 Action 由 crm-write 子技能经两阶段协议分发（phase1 取表单 → phase2 confirm 执行），本 SKILL 仅编排路由，不直接 dispatch。清单 Action 全部 ∈ `seedActions()` 注册集（防漂移）。

## 安全红线
- AI 永远不在对话中接收或显示密钥明文（凭证补完走 .env / 环境变量 / 命令 三种安全通道）。
- 写操作经 action-confirm 显式角色确认；无凭证自动降级 sales 只读并显式提示。