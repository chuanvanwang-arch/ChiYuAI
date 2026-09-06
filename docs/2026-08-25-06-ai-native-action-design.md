# AI 原生 CRM · 06 原生 Action 表面设计（ai-native-action-design）

- 日期：2026-08-25
- 方法论依据：`ai-native-action-design`（R1-R6 基数规则 / 命名空间分层 / 查询-写入分离 / 写操作规则闸 / R3-RED 反折叠红线 / 禁删机制化）
- 业务基线：`docs/2026-08-24-ai-native-sales-crm-design.md` §5ter（19 小节业务全景）+ §5ter-quater（Q.19 理念差异 D1-D12 / Q.20 能力×业务设计输入）
- 前置架构：`docs/2026-08-25-ai-native-crm-overall-design.md` §1（四平面：Action 表面挂 L3 智能体平面，贯穿读写双通道）
- 前置粒子：`docs/2026-08-25-01-ai-particle-system-design.md`（9 粒子清单 → Action 消费 `data.particle` type 值）

## 0. 核心立场：Action = 原子能力动词（按对象聚合、写操作机制级过闸）

> **Action 表面是「智能体可执行的原子能力动词」，不是业务对象的 CRUD 表。业务对象（线索/客户/商机/合同…）全部复用平台 `data.particle` substrate 的 type 值，垂直域只定义「跨粒子的领域能力 Action」。**

对 CRM 销售域的关键判别（区别于朴素 CRUD 爆炸）：
- **Action 表面按对象聚合**：11 个 `crm-*` SKILL 各自是一个对象域（线索/客户/商机/报价/合同/订单/回款/线索池/公海/漏斗/预警），内部聚合该对象域的全部读/写能力动词——不按业务对象开 ×4 CRUD。
- **写操作机制级过闸**：所有写 Action 一律走「规则层 → action-confirm → HITL 审批流」三闸；删除 Action **从 Action 表面就不存在**（机制级禁删，非提示词红线）；读 Action 默认直连（免审批）。
- **命名空间分层**：一级 `crm-<对象>`，二级资源 `crm-contract-payment-plan`（合同×回款计划」式——`crm-contract` 承载回款计划/记录/发票等子对象 Action，不扁平罗列。

## 1. 方法论依据（跨域通用的核心法则 / 铁律 / 判据）

> 本节提炼 `ai-native-action-design` 的通用方法论，保持跨域；不写任何具体项目专有名词。CRM 实例化见 §2/§3。

### 1.1 心智模型铁律

- **粒子是通用数据底座（substrate），不是业务对象类型**。业务对象 = `data.particle` 的 `type` 值，全部复用平台 substrate；垂直域只开「跨粒子的业务动词」Action——否则 N 对象 ×4 CRUD 爆炸。
- **资源（走 substrate）≠ 能力（开 Action）**。领域能力 Action 只承载「跨粒子的业务动词」，绝不为每个业务对象单开 CRUD。

### 1.2 基数规则 R1-R6（每个数都能被解释）

| 规则 | 内容 | 适用 |
|---|---|---|
| **R1 Substrate 动词法** | 能力层按「动词」定数（read/write/correct/reconcile/observe），**不为每种数据类型单开 Action** | 上下文/观测/AI 属性轴 |
| **R2 资源×CRUD+生命周期** | 资源域按「实体数×4 + 领域特有生命周期动作」；「资源」= **平台级 substrate**，不是业务对象类型 | data / asset / 业务对象 |
| **R3 同类折叠为 op 枚举** | 同形状的不同操作收为 1 个 `operate({op})`；首类 Action 是快捷键，substrate 扛 op | 连接器/判定/增强 |
| **R4 属性不是 Action** | `needsApproval` / `agentTool` / `tenantScoped` 是挂在 Action 上的横切属性，不单独成类 | 全局 |
| **R5 一能力一 Action、一表面不重复** | 一个能力只定义一次，六面（tool/frontend/http/mcp/a2a/cli）共用；禁止二次包装；关系谓词统一由 `data.graph.edge` 承载（不为谓词开 Action）；同名不同侧必须分列（读侧 vs 写侧） | 全局 |
| **R6 高危写操作必须有 force 确认** | 数据修改（update/delete）和状态逆转必须带 `force` 参数；`force=false`（默认）→ 403/needs_force 不执行；`force=true` → 执行并落审计；Agent 自主调用默认 `force=false` | 全局横切安全 |

### 1.3 R3-RED 反折叠红线（R3 的边界）

以下任一条成立即**禁止折叠**为同一 op：① 幂等性不同；② `needsApproval` 不同；③ 审计级别不同；④ 调用方 Actor 不同（人类 UI vs 子 Agent）。四判据编码为 Action 显式属性 `sideEffect` / `needsApproval` / `auditLevel` / `agentTool`，机检 `wouldViolateRedLine(a,b)` 比对这些字段。

### 1.4 查询-写入分离铁律（双通道）

- **读默认直连**：查询 Action 不写事件、免审批、不挂规则层（仅过上下文分层 RBAC 过滤 + Output Guard）。
- **写显式过闸**：写 Action 一律过「规则层 → action-confirm → HITL 审批流」三闸之一或全部；写操作必有粒子写事件、必有审计、必有轨迹（无「无声写入」）。

### 1.5 写操作规则闸（三闸各管一问题）

1. **规则层**管「能不能写」（状态机合法流转 + 业务规则）。
2. **action-confirm**管「这次写要不要人确认」（关键 Action 一律确认；批处理/外部智能体免登录调用也过确认，确认人映射为调用者绑定角色）。
3. **HITL 审批流**管「写完后走什么流程」（可配置审批流：条件分支→审批人规则→字段权限→结果后动作）。

### 1.6 命名与治理约定

- 对外契约 kebab-case `<namespace>-<verb>`；dot 记法仅内部分组。
- 每个 Action 强制元信息：`surfaces`(六面) / `needsApproval`(R4) / `tenantScoped` / `audit` / `version` / `owner` / `agentTool` / `force`(R6)。
- **禁删机制化**：删除 Action 从 Action Registry 不注册（表面不存在），机检检测器 `detectCrudExplosion()` + 红线扫描兜底；绝不靠提示词约束。

## 2. 业务设计输入（Q.20 + §6.2 + §5ter 提取）

> 来源：Q.20 结论行「ai-native-action-design = crm-* 11 个 SKILL 明细化为 Action 表面；复合过滤维度=查询参数 Schema；金额计算=写时计算管线；写入引擎+规则闸+action-confirm；命名空间分层」。§6.2 候选 SKILL 清单 + §5ter 19 小节业务全景。

### 2.1 11 个 crm-* SKILL（按对象聚合，§6.2 实证）

| crm-* SKILL | 对象域 | 读能力（默认直连） | 写能力（过闸） | 落地阶段 |
|---|---|---|---|---|
| crm-lead | 线索 | 查询/详情/池查询 | 创建/领取/回收/转化/导入 upsert/跟进 | 阶段 3 |
| crm-account | 客户 | 查询/详情/360 聚合/联系人查询 | 创建/更新(force)/加联系人/移入公海/工商校验/跟进 | 阶段 3 |
| crm-opportunity | 商机 | 查询/详情/漏斗筛选 | 创建/阶段推进/回退(特权)/赢输单/报价关联 | 阶段 3 |
| crm-quote | 报价 | 查询/详情 | 创建(写时金额计算)/提交审批/转合同 | 阶段 3 |
| crm-contract | 合同 | 查询/详情/360 | 创建/提交审批/更新(force,超 20% 审批) + 二级资源 | 阶段 3 |
| crm-order | 订单 | 查询/详情 | 创建/提交审批/状态看板更新 | 阶段 3 |
| crm-payment | 回款/发票 | 计划查询/记录查询/发票查询 | 实回记录/对账/发票创建/核销 | 阶段 3 |
| crm-lead-pool | 线索池 | 共享线索查询（复合过滤） | 无独立写（领取/回收在 crm-lead） | 阶段 3 |
| crm-account-pool | 公海 | 共享客户查询（复合过滤） | 无独立写（移入公海在 crm-account） | 阶段 3 |
| crm-funnel | 全链路分析 | 漏斗分析/团队业绩排行/目标达成 | 无（纯读/聚合） | 阶段 2/3 |
| crm-alert | 全链路预警 | 预警列表/详情 | 预警由事件平面生成；确认/处理（写，过闸） | 阶段 2/3 |

### 2.2 复合过滤维度 = 查询参数 Schema（§5ter + §6.3quinquies 实证）

官方三大功能矩阵给出每个 SKILL 的检索维度，应**原生内建为查询 Action 的参数 Schema**（非运行时拼 SQL）：
- 线索：名称/状态/行业/来源/创建时间/归属人/池 ID（含深度关联联系人职能/电话/邮件 → 360 画像参数）。
- 商机：预计金额/截止日期/当前阶段/赢率区间。
- 合同：签约主体/回款状态（已支付/待支付）/到期区间。
- 客户 360：跨模块聚合（客户+联系人+商机+跟进+工商校验）参数。

### 2.3 金额计算 = 写时计算管线（§5ter.5 / §5ter.17 实证）

报价/合同金额**不是手填**，是写时运算符组合管线：定价 × 数量 × 折扣 × 税点 = 行金额，累计金额自动汇总（非人工填累计）；合同金额修改超 20% 自动路由审批流。该管线是 **write-engine 内的计算前置**，不是独立 Action（R1 不为每类计算开 Action，R4 金额规则是参数/属性）。

### 2.4 写入引擎 + 规则闸 + action-confirm（§5ter-quater Q.1/Q.13）

写 Action 统一走：规则层（状态机合法流转 + 业务规则）→ 两阶段安全写入（先取属性元模型 Schema → 校验）→ action-confirm（写操作必需，生成一次性令牌）→ HITL 审批流（四大写域：报价/合同/发票/订单）。安全红线（禁删/脱敏）贯穿写通道。

### 2.5 命名空间分层（§6.3quater 实证）

SKILL 内部支持「模块（对象）+ 二级资源（子对象）」两级结构。Action 表面支持**命名空间分层**（`crm-contract-payment-plan` 式），而非扁平 Action 列表——回款计划/记录、发票、工商抬头作为合同/客户域的二级资源 Action 承载。

### 2.6 §5quater 领域输入补充（印刷行业 + B2B 决策逻辑，2026-08-26）

> 来源：`doc/` 目录两份文档（§5quater 已系统化吸收为 Q.21）。本能力的行业/方法论强化输入：
- **三级报价 + 折扣换条件**（§5quater.2 阶段四 / P1/P8）：`crm-quote` 写 Action 须支持 开盘价/目标成交价/底线底价 三档 + 每次折扣必须换取对等条件（缩短周期/框架/增量/案例）；底价绝对不外露。
- **合同风险校验规则**（阶段四 决策 4）：模糊验收条款=回款坑 → 合同写 Action 须内置「验收标准可量化」校验闸（R-规则）。
- **增补订单 / 回款 / 续约 / 丢单复盘 Action**（阶段六/七）：合同外新增需求走增补订单 Action（禁人情式免费加需求）；回款/续约落 `crm-payment`；丢单复盘落 `crm-lead`/opportunity 终结态。
- **线索评分 + MEDDICC 校验 Action**（阶段一/二）：`crm-lead` 评分 Action（行业+规模+痛点+对接人级别打分，低于阈值→培育）；`crm-opportunity` 资格校验 Action（MEDDICC 清单式）。
- **非标参数化**（P7）：报价/产品写 Action 支持行业自定义维度（特殊色号/异形模切），由粒子属性元模型承载（见 ai-particle §5quater 输入）。

## 3. 落地设计（具体方案）

### 3.1 Action 表面命名空间规划（crm-*）

- 一级命名空间 = 对象域：`crm-lead` / `crm-account` / `crm-opportunity` / `crm-quote` / `crm-contract` / `crm-order` / `crm-payment` / `crm-lead-pool` / `crm-account-pool` / `crm-funnel` / `crm-alert`。
- 二级资源命名空间（合同域）：`crm-contract-payment-plan`（回款计划）/ `crm-contract-payment-record`（回款记录）/ `crm-contract-invoice`（发票）/ `crm-contract-business-title`（工商抬头）。
- 约定：① kebab-case；② 二级资源不下沉为独立 SKILL，归属父对象域 Action；③ 池（lead-pool/account-pool）是「粒子集合视图」= 查询 Action 的过滤参数组合，不建独立表、不建领取/回收写 Action（领取/回收挂在 crm-lead）。

### 3.2 每个 SKILL 的读/写 Action 清单草图（R5 同名不同侧分列）

**crm-lead（线索）**
- 读（直连）：`crm-lead-query(params)` / `crm-lead-detail(id)` / `crm-lead-pool-query(params)` / `crm-lead-followup-query(id)`
- 写（过闸）：`crm-lead-create` / `crm-lead-pick(poolId, force)` / `crm-lead-recycle(id)`（事件触发）/ `crm-lead-convert(id, target)`（状态机流转+confirm）/ `crm-lead-import`（批量 upsert 幂等）/ `crm-lead-followup-add`（追加 interaction 事件）

**crm-account（客户）**
- 读（直连）：`crm-account-query(params)` / `crm-account-detail(id)` / `crm-account-360(id)`（跨模块聚合）/ `crm-contact-query(accountId)`
- 写（过闸）：`crm-account-create` / `crm-account-update(id, patch, force)` / `crm-account-contact-add` / `crm-account-pool-move(id)`（移入公海）/ `crm-account-business-title-verify`（写时校验）/ `crm-account-followup-add`

**crm-opportunity（商机）**
- 读（直连）：`crm-opportunity-query(params)` / `crm-opportunity-detail(id)` / `crm-opportunity-funnel-filter(params)`
- 写（过闸）：`crm-opportunity-create` / `crm-opportunity-stage-advance(id, toStage, confirm)`（状态机合法流转）/ `crm-opportunity-rollback(id, force, needsApproval)`（特权回退，双保护）/ `crm-opportunity-close(id, result, reason)`（输单必填 reason）/ `crm-opportunity-quote-link`

**crm-quote（报价）**
- 读（直连）：`crm-quote-query(params)` / `crm-quote-detail(id)`
- 写（过闸）：`crm-quote-create(payload)`（写时金额计算管线）/ `crm-quote-submit(id)`（HITL 四大写域）/ `crm-quote-convert-to-contract(id)`

**crm-contract（合同 + 二级资源）**
- 读（直连）：`crm-contract-query(params)` / `crm-contract-detail(id)` / `crm-contract-360(id)`
- 写（过闸）：`crm-contract-create` / `crm-contract-submit(id)` / `crm-contract-approve(id)`（HITL）/ `crm-contract-update(id, patch, force)`（金额超 20% → needsApproval）
- 二级资源：`crm-contract-payment-plan-create` / `-update(id, patch, force)` / `crm-contract-payment-record-create`（实回）/ `crm-contract-invoice-create` / `crm-contract-invoice-writeoff(id)`（核销）

**crm-order（订单）**
- 读（直连）：`crm-order-query(params)` / `crm-order-detail(id)`
- 写（过闸）：`crm-order-create` / `crm-order-submit(id)` / `crm-order-approve(id)`（HITL）/ `crm-order-status-update(id, status, force)`

**crm-payment（回款/发票）**
- 读（直连）：`crm-payment-plan-query(params)` / `crm-payment-record-query(params)` / `crm-invoice-query(params)`
- 写（过闸）：`crm-payment-record-create`（实回）/ `crm-payment-reconcile(planId, recordId)`（计划↔记录对账）/ `crm-invoice-create` / `crm-invoice-writeoff(id)`

**crm-lead-pool / crm-account-pool（读为主）**
- 读（直连）：`crm-lead-pool-query(params)` / `crm-account-pool-query(params)`
- 写：无独立写（领取/回收/移入挂在 crm-lead / crm-account）

**crm-funnel（分析，纯读）**
- 读（直连）：`crm-funnel-analysis(params)` / `crm-funnel-team-ranking(orgId)` / `crm-funnel-target(params)`

**crm-alert（预警）**
- 读（直连）：`crm-alert-query(params)` / `crm-alert-detail(id)`
- 写（过闸）：`crm-alert-acknowledge(id)`（确认/处理，过闸；预警本身由事件平面生成，非人写）

### 3.3 查询参数 Schema（复合过滤维度，zod 草案）

```ts
// crm-lead-query 参数 Schema（其余 SKILL 同构）
{
  name?: string; status?: enum[new|assigned|converted|recycled];
  industry?: string; source?: enum[标讯|自拓|转介绍|导入];
  owner?: actorReference; poolId?: string;
  createdAt?: { from?: date; to?: date };
  contactDeep?: boolean;          // 深度关联联系人画像
  page?: number; pageSize?: number;
}
// crm-opportunity-query 增量维度：expectedAmount:{min?,max?} / dueDate / stage / probability:{min?,max?}
// crm-contract-query 增量维度：signParty / paymentStatus:enum[paid|pending] / dueRange
```

### 3.4 金额写时计算管线（crm-quote-create / crm-contract-update）

```
输入行明细 [{productId, qty, discount, taxRate}] + 价格表自动带价(price-list)
  → 行金额 = basePrice × qty × (1-discount) × (1+taxRate)   // 运算符组合，非手填
  → 累计金额 = Σ 行金额（自动汇总，拒绝手填累计字段）
  → 落库前写时校验（价格有效期/权限/变更日志）
  → 合同金额修改超 20% → 自动 inject needsApproval + 路由审批流（规则层判定）
```

### 3.5 写入引擎 + 规则闸 + action-confirm 流程（三闸顺序）

```
写 Action 请求（人/智能体/外部连接器）
  → 上下文分层注入（角色权限边界：能做/不能做）
  → 规则层（business-rules：阶段只进不退 / 金额超 20% 审批 / 输单必填原因）→ 不合法即拒
  → 两阶段安全写入（先取属性元模型 Schema → 校验输入）
  → action-confirm（生成一次性令牌；Agent 默认 force=false → 403/needs_force）
  → HITL 审批流（四大写域：quote/contract/invoice/order；非 APPROVED 不改状态）
  → 粒子写通道（事务写入 + 触发粒子写事件）→ 写后验证 → 返回
```

### 3.6 对外技能协议落地（§6.4 Skills-as-a-Service）

- **读默认直连、写显式过闸**：对外暴露的 SKILL 默认能力 = 只读查询接口（强语义 + 跨模块关联）；写能力显式、受限、过规则闸/HITL，与外部调用同套 Action 表面（无第二套实现）。
- **免登录直连**：外部智能体经受控凭证（短期令牌，请求结束即注销）直连能力层，权限检查统一在平台侧执行，外部不绕过。
- **角色自动识别**：接入时按凭据匹配角色 → 自动套用数据范围/关注重点/主动预警/输出风格（L4 治理决策层贯彻到外部每次调用）。
- **统一技能协议**：Action 表面 + 意图 NL 描述 + 角色上下文，跨智能体一致消费。
- **审计与闭环**：外部调用全量进事件总线与审计日志（ai-capability-audit 闭环）。
- **禁删红线**：对外协议同样不含任何 delete 类 Action（表面不存在）。

### 3.7 数据/接口草图（Action Registry 条目示例）

```json
{
  "name": "crm-opportunity-stage-advance",
  "namespace": "crm-opportunity",
  "verb": "stage-advance",
  "surfaces": ["tool","frontend","http","mcp","a2a","cli"],
  "readOnly": false,
  "needsApproval": false,
  "force": true,
  "agentTool": true,
  "tenantScoped": true,
  "audit": "write",
  "version": "1.0.0",
  "owner": "crm-team",
  "consumes": ["CRM_DEAL.stage", "CRM_DEAL.stage_history"],
  "produces": ["CRM_DEAL.stage", "transitionedBecause 边"]
}
```

## 4. 与其他能力 / 四平面的接口

- **被 L3 智能体平面消费**（总体架构 §1）：agentLoop 意图→Action 解析从 Action Registry 动态加载；只有 `agentTool=true` 的 Action 暴露给 LLM（读侧与低风险写侧开放，删除/`payment-hold` 类高危写侧隐藏）；`sideEffect` 决定确认策略（false=直执，true=需 confirm）。
- **过闸触发 L2 事件平面**：每个写 Action 落库后发射粒子写事件 → SSE 总线广播 → ai-ontology-vector-build（本体/向量写时构建）、ai-memory-lifecycle（记忆捕获）、ai-event-driven-evolution（预警规则扫描）、ai-feedback-loop（指标对账）、ai-capability-audit（审计日志）五路挂接，互不阻塞主事务。
- **写粒子 L1 平面**：Action 最终落到 `data.particle.*` substrate（业务对象 = `type` 值）；受控谓词（belongs_to/owned_by/transitionedBecause 等）统一由 `data.graph.edge` 承载——**不为每对象开 CRUD、不为每谓词开 Action**（R2/R5）。
- **与 ai-context-layering 权限边界**：读通道注入 L1-L4（角色 + 组织 RBAC + 区域层级树 parent_id 过滤）；写通道注入「能做-不能做」边界（回退特权=管理员角色白名单）。角色四/七要素 = L4 配置，外部技能访问同一套。
- **与 ai-multi-agent-orchestration 的 HITL 闸协同**：`needsApproval=true` 的写 Action 先 `consultGate`，非 APPROVED 返回 needs_approval 且**不改状态**；人工 `recordApprovalDecision(...,'APPROVED')` 后重派才执行；审批 Action 只守卫不翻转（L4 治理铁律）；编排侧 `blocked(approval)` 等待 HITL，不归 failed/熔断。

## 5. 验收判据（§5ter 覆盖 + D5/D6 差异点，可验证）

- [ ] **11 个 crm-* SKILL 全部明细化为 Action 表面**：每个有读清单 + 写清单，总数可被 R1-R6 解释（无 ×4 CRUD 爆炸、无关系谓词 Action）。
- [ ] **查询参数 Schema 覆盖 §5ter 三大功能矩阵复合过滤维度**（线索：名称/状态/行业/来源/时间/池；商机：金额/截止/阶段；合同：签约主体/回款状态）——且为内建参数非运行时拼 SQL。
- [ ] **写操作全过三闸**：规则层→action-confirm→HITL；四大写域（quote/contract/invoice/order）提交 Action 挂可配置审批流。
- [ ] **D6 红线机制化验证**：Action Registry 无 delete 类 Action（机检 `detectCrudExplosion()` + 红线扫描零命中）；删除在表面不存在，而非提示词约束。
- [ ] **D5 审批编排化验证**：审批 = HITL 闸节点（粒子域 + 事件流），非独立审批系统；审批 Action 只守卫不翻转，审批记录 = 审计事件源。
- [ ] **金额写时计算管线**：报价金额非手填、自动汇总；合同金额修改超 20% 自动路由审批（规则层判定命中）。
- [ ] **命名空间分层无扁平爆炸**：二级资源以 `crm-contract-payment-plan` 式命名，不下沉为独立 SKILL；池为视图化查询参数。
- [ ] **对外技能协议落地**：读默认直连、写显式过闸、外部调用全量进审计总线、免登录直连经短期令牌、角色自动识别。
- [ ] **§5ter 19 小节覆盖无空白**：每个业务域可映射到具体 Action（覆盖矩阵可回答「我们如何实现」）。

## 6. 不做的事（YAGNI + 理念边界）

- **不为每个业务对象开 CRUD**（R2）：线索/客户/商机/合同等全部走 `data.particle` type 值，垂直域 0 个粒子 CRUD——避免 11 对象 ×4 爆炸。
- **不为每种 AI 能力轴开 Action**（R1/R4）：金额计算是 write-engine 内计算管线（参数/属性），不是独立 Action；审批是 `needsApproval` 横切属性，不独立成类。
- **不为关系谓词开 Action**（R5）：belongs_to/owned_by/transitionedBecause 等统一由 `data.graph.edge` 承载。
- **不借鉴 CordysCRM 外层封装（D12）**：技能 = 原生内建（从第一行代码长出来），不是 Java/MySQL 上叠技能；池不做独立池表（视图化）；预警不做定时任务配置（事件驱动）。
- **禁删从 Action 表面不存在（非提示词红线，D6）**：不靠 SKILL.md 提示词约束删除，机制上删除 Action 不注册、检测器兜底。
- **不做第二套对外接口**：对外技能协议复用同一 Action 表面，不另行包装 `/api/*`（R5 一能力六面共用）。

> 扩展建议（非 SKILL 原方法，标注供评审）：①「批量写 HITL 确认闸 + 幂等 token」建议在阶段 3 批量导入场景显式化；②「关键变更二次确认」（金额 >1.1× 或关键方变更，SSE 执行中再确认）建议作为 action-confirm 的增强，待 PDM 范式对齐后纳入。

## 自检清单（对照 SKILL + 基线）

- [x] 11 个 crm-* SKILL 全部明细化为 Action 表面（读/写分列，R5 同名不同侧）
- [x] 复合过滤维度 = 查询参数 Schema（三大功能矩阵维度内建）
- [x] 金额计算 = 写时计算管线（非手填，超 20% 路由审批）
- [x] 写入引擎 + 规则闸 + action-confirm 三闸流程明确
- [x] 命名空间分层（crm-contract-payment-plan 式）约定清晰
- [x] 对外协议落地：读默认直连 / 写显式过闸 / 禁删 / 免登录 / 角色识别 / 审计闭环
- [x] 与四平面接口：L3 消费 / L2 事件触发 / L1 写粒子 / context 权限 / orchestration HITL 协同
- [x] 验收判据可验证（§5ter 覆盖 + D5/D6 差异点）
- [x] 不做的事覆盖 YAGNI + 不借鉴外层封装 + 机制级禁删
- [x] 不编造 SKILL 未定义方法（扩展以「建议」标注）
