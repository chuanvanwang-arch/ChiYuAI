# AI 原生 CRM · 01 粒子系统设计（ai-particle-system-design）

- 日期：2026-08-25
- 方法论依据：`ai-particle-system-design`（C0-C4 五标准 / 阶段炸开检查 / 360° 属性 10 维 / 关联边受控谓词 / 知识分层 L1-L4 / Universal Context 注入）
- 业务基线：`docs/2026-08-24-ai-native-sales-crm-design.md` §5ter（外部业务全景 19 小节）+ §5ter-quater（业务×能力映射）
- 前置架构：`docs/2026-08-25-ai-native-crm-overall-design.md` §1（四平面）/ §3（粒子域全景定位）

## 0. 核心立场：粒子 = 世界中的实体（Endurant）

> **粒子 = 实体（Endurant）。文档与事件不冒充粒子，一切时变信息都是状态。**

对 CRM 域的关键判别：
- **线索、商机、合同不是三个粒子**——它们是同一交易实体（deal）的生命周期阶段（§5ter.1/3/6 的链路实证 + Attio/Prisma `Deal` 单模型实证）。**合并为单粒子 `CRM_DEAL` + 状态机**。
- **报价单不是独立粒子**——它是 deal 的一个状态（quoted 阶段）与证据资产（报价明细快照）→ 报价内容落 deal 的 `quotation` 状态快照，报价审批事件落 deal 事件流。
- **回款计划/回款记录不是独立粒子**——是合同（deal 的 contracted 阶段）的财务状态流 → 「计划(应回) → 记录(实回)」双状态 + 对账派生属性。
- **发票不是独立粒子**——是 financial 凭证的证据资产（票据 + 关联 + 电子附件 → 状态流）。
- **跟进记录不是独立粒子**——是 deal/account 的交互经历（事件流），计划→记录两态转化用状态表达。
- **订单不是独立粒子**——是 deal 的一个状态（ordered）与履约证据。
- **产品、价格表是独立粒子**——它们是实体（世界中的持续存在物），有独立身份（SKU/价格表 ID）与生命周期（价格有效期/变更日志）。
- **线索池/公海（lead-pool/account-pool）不是粒子**——是组织治理配置（池规则），降级为 organization 的池配置属性。

## 1. 真粒子清单（C0-C4 判定 + 降级去向）

| # | 粒子 | C0 实体性 | C1 独立身份 | C2 独立生命周期 | C3 跨场景引用 | C4 本体主体 | 判定 |
|---|---|---|---|---|---|---|---|
| P1 | **CRM_DEAL（交易）** | ✅ 世界中的持续实体 | ✅ deal_id（跨系统别名双轨） | ✅ 完整状态机（lead→opp→quoted→contracted→ordered→paid→lost） | ✅ 被销售/经理/财务/商务/跟进/漏斗≥2 场景引用 | ✅ 图谱节点 | ✅ 真粒子 |
| P2 | **CRM_ACCOUNT（客户）** | ✅ 企业主体 | ✅ account_id + 工商抬头（统一信用代码） | ✅ 生命周期（潜在→活跃→休眠→流失） | ✅ 被客户360/联系人/交易/跟进引用 | ✅ 节点 | ✅ 真粒子 |
| P3 | **CRM_CONTACT（联系人）** | ✅ 人 | ✅ contact_id | ✅ 生命周期（在职/离职） | ✅ 被客户360/跟进/交易引用 | ✅ 节点 | ✅ 真粒子 |
| P4 | **CRM_PRODUCT（产品）** | ✅ 商品 | ✅ product_id/SKU | ✅ 生命周期（在售/停售） | ✅ 被定价/报价/合同引用 | ✅ 节点 | ✅ 真粒子 |
| P5 | **CRM_PRICE_LIST（价格表）** | ✅ 定价实体 | ✅ price_list_id | ✅ 生命周期（生效/失效/版本） | ✅ 被产品/报价/合同引用 | ✅ 节点 | ✅ 真粒子（弱实体，跨场景≥2 + 状态机完整 + 身份独立） |
| P6 | **CRM_PERSON（员工/操作人）** | ✅ 人 | ✅ user_id | ✅ 生命周期（在职/离职） | ✅ 被组织/角色/待办/审计引用 | ✅ 节点 | ✅ 真粒子 |
| P7 | **CRM_ORGANIZATION（组织）** | ✅ 组织实体 | ✅ org_id（parent_id 层级树） | ✅ 生命周期（启用/停用） | ✅ 被 RBAC/区域/团队/待办引用 | ✅ 节点 | ✅ 真粒子 |
| P8 | **CRM_KNOWLEDGE（知识/本体词表）** | ✅ 知识实体 | ✅ knowledge_id | ✅ 生命周期（登记/停用） | ✅ 被检索/上下文/进化引用 | ✅ 节点 | ✅ 真粒子（知识类 1） |
| P9 | **CRM_UNSTRUCTURED_ASSET（非结构化证据）** | ✅ 证据实体 | ✅ asset_id | ✅ 生命周期（上传/归档） | ✅ 被跟进/报价/合同/发票引用 | ✅ 节点 | ✅ 真粒子（证据类 1） |

**降级对象去向**：

| 候选对象 | 判定 | 降级去向 |
|---|---|---|
| 线索 lead | 阶段非实体 | → `CRM_DEAL.stage=lead` 状态 |
| 商机 opportunity | 阶段非实体 | → `CRM_DEAL.stage=opportunity` 状态 |
| 报价单 quotation | 阶段+证据 | → `CRM_DEAL.stage=quoted` + 报价明细快照（unstructured/JSON 状态） |
| 合同 contract | 阶段非实体 | → `CRM_DEAL.stage=contracted` + 合同条款快照 |
| 订单 order | 阶段非实体 | → `CRM_DEAL.stage=ordered` + 履约证据 |
| 回款计划 payment-plan | 财务状态流 | → deal 的 `financial_state`（应回计划） |
| 回款记录 payment-record | 财务状态流 | → deal 的 `financial_state`（实回记录）+ 凭证资产引用 |
| 发票 invoice | 证据非实体 | → `CRM_UNSTRUCTURED_ASSET`（票据类型）+ 财务状态引用 |
| 跟进 follow | 经历非实体 | → 事件流（interaction 类型属性）+ `lastActivityAt/nextActionAt` |
| 线索池 lead-pool | 组织配置 | → `CRM_ORGANIZATION.pool_config`（领取/回收规则） |
| 公海 account-pool | 组织配置 | → `CRM_ORGANIZATION.pool_config`（公海规则） |
| 工商抬头 business-title | 客户属性 | → `CRM_ACCOUNT.business_title`（统一信用代码） |
| 审批流 approval-flow | 治理机制 | → 支撑粒子（见 §4 支撑粒子） |
| 规则 rule | 治理机制 | → 支撑粒子（规则引擎） |
| 角色 role | 治理配置 | → `CRM_ORGANIZATION` 关联的 role 标签边 |
| 事件 event | 经历非实体 | → 事件流（时间序列）+ 审计轨迹 |

**收敛结论**：真粒子 9 个（实体 6 + 知识 1 + 证据 1 + 弱实体 1）∈ 典型规模 8-12 区间。此前总体架构 §3 的 11 业务粒子清单**已按阶段炸开检查修正**（deal 合并）。

## 2. 每粒子 360° 属性模型（10 维）

### 2.1 核心业务粒子

#### P1 CRM_DEAL（交易实体的状态集）

| 维度 | 内容 |
|---|---|
| ① identity | deal_id(UUID 双轨：外部别名↔物理 ID) |
| ② lifecycle | 状态机：`lead → opportunity → quoted → contracted → ordered → paid` / `lost` / `disqualified` |
| ③ core_attributes | name / expected_amount(currency) / stage / stage_changed_at(timestamp) / source(select: 标讯/自拓/转介绍/导入) / owner(PERSON) / org(ORGANIZATION) / expected_close_date(date) / actual_close_date(date) / closed_reason(select: 赢单/输单原因) / probability(percent 赢率) |
| ④ ai_attributes | 见 2.3（2D 模型） |
| ⑤ states | current_stage + stage_history + derived(age_in_stage 天数 / funnel_position) |
| ⑥ processes | 跟进时间线（事件流） |
| ⑦ events | stage 转换事件 / 跟进事件 / 审批事件（traceable） |
| ⑧ relations | `belongs_to`(ACCOUNT) / `owned_by`(PERSON) / `part_of`(ORGANIZATION) / `references`(PRODUCT×PRICE_LIST) / `evidenced_by`(UNSTRUCTURED_ASSET) |
| ⑨ unstructured_data | 报价明细快照 / 合同条款附件 / 订单凭证 / 发票票据 |
| ⑩ vectors | 语义向量 L0（整实体）+ AI 派生属性向量 L2 |

#### P2 CRM_ACCOUNT（客户/公司）

| 维度 | 内容 |
|---|---|
| ① identity | account_id + 工商统一信用代码（跨系统身份锚） |
| ② lifecycle | `potential → active → dormant → lost` |
| ③ core_attributes | name / industry(select) / region(select，org 层级中间层) / business_title(工商抬头：统一代码/注册地址/法人) / source(select) / size(员工数) / rating(rating 评分) / **ATTIO A 桶**：domains(domain) / funding_raised_usd(currency) / foundation_date(date) / estimated_arr_usd(select) / employee_range(select) / categories(select) / logo_url(url) / linkedin·twitter·facebook·instagram·angellist(url) / **ATTIO D 桶**：champion_strength(select 关系强度) / key_contact(actor-reference 关键联系人) |
| ④ ai_attributes | 见 2.3 |
| ⑤ states | account_stage + customer_360 聚合快照（跨模块关联） |
| ⑥ processes | 联系人变更 / 工商校验时间线 |
| ⑦ events | 客户创建 / 公海移入移出 / 工商信息变更（企查查校验事件） |
| ⑧ relations | `has_employee`(CONTACT) / `owns`(DEAL) / `belongs_to`(ORGANIZATION) / `supplied_by`(外部工商数据源) |
| ⑨ unstructured_data | 工商证照 / 合作合同附件 |
| ⑩ vectors | L0 向量 + L1 属性字段向量（行业/区域/规模） |

#### P3 CRM_CONTACT（联系人）

| 维度 | 内容 |
|---|---|
| ① identity | contact_id |
| ② lifecycle | `active → departed` |
| ③ core_attributes | name(personal-name) / email(email-address) / phone(phone-number) / title(职能/职务) / department(select) / decision_power(select: 决策人/影响者/使用者) / **ATTIO B 桶**：job_title(text 同步 title) / avatar_url(url) / primary_location(location) / linkedin·twitter(url) / company(record-reference 冗余引用 ACCOUNT) / **ATTIO D 桶**：relationship_strength(select 关系强度) |
| ④ ai_attributes | relationship_heatmap(B_Brief) / stakeholder_influence(J_Judge) |
| ⑤ states | active/departed + last_contacted_at |
| ⑥ processes | 联系时间线 |
| ⑦ events | 联系人新增/变更/@提及事件（跨角色协作提醒） |
| ⑧ relations | `works_at`(ACCOUNT) / `contacted_for`(DEAL) |
| ⑨ unstructured_data | 名片/头像 |
| ⑩ vectors | L0 向量 |

#### P4 CRM_PRODUCT（产品）

| 维度 | 内容 |
|---|---|
| ① identity | product_id / SKU |
| ② lifecycle | `on_sale → discontinued` |
| ③ core_attributes | name / category(select) / base_price(currency，@DecimalMin/@DecimalMax 校验) / unit(select) / status(select) |
| ④ ai_attributes | price_trend(C_Classify) / demand_forecast(F_Forecast) |
| ⑤ states | on_sale/discontinued + price_change_log（变更日志=审计输入） |
| ⑥ processes | 价格变更时间线（写时审计） |
| ⑦ events | 价格变更事件（价格变更日志=ai-capability-audit 输入） |
| ⑧ relations | `priced_by`(PRICE_LIST) / `referenced_in`(DEAL) / `instanceOf`(KNOWLEDGE 类别) |
| ⑨ unstructured_data | 产品图/规格文档 |
| ⑩ vectors | L0 向量（产品名/描述，中英混名向量优先） |

#### P5 CRM_PRICE_LIST（价格表）

| 维度 | 内容 |
|---|---|
| ① identity | price_list_id |
| ② lifecycle | `draft → active → expired` |
| ③ core_attributes | name / currency / valid_from(date) / valid_until(date) / permission(select: 可见范围) / price_rules(JSONB：区域/客户等级/数量阶梯) |
| ④ ai_attributes | price_fairness(J_Judge) |
| ⑤ states | draft/active/expired + version（变更日志） |
| ⑥ processes | 价格生效时间线 |
| ⑦ events | 价格表发布/变更/过期事件 |
| ⑧ relations | `prices`(PRODUCT) / `used_in`(DEAL 报价) / `priced_by`(PRODUCT) |
| ⑨ unstructured_data | 定价说明文档 |
| ⑩ vectors | L0 向量（定价描述） |

#### P6 CRM_PERSON（员工/操作人）

| 维度 | 内容 |
|---|---|
| ① identity | user_id |
| ② lifecycle | `active → disabled → departed` |
| ③ core_attributes | name / email / phone / role_tags(multi-select 角色) / org_id / region(select) |
| ④ ai_attributes | activity_level(J_Judge) / workload_estimate(J_Judge) |
| ⑤ states | 在职状态 + 最近活跃时间 |
| ⑥ processes | 待办/跟进处理轨迹 |
| ⑦ events | 操作审计事件（谁做了什么） |
| ⑧ relations | `member_of`(ORGANIZATION) / `owned_by`(DEAL/ACCOUNT 归属) / `assigned_to`(跟进) |
| ⑨ unstructured_data | 头像 |
| ⑩ vectors | L0 向量（历史执行摘要） |

#### P7 CRM_ORGANIZATION（组织）

| 维度 | 内容 |
|---|---|
| ① identity | org_id |
| ② lifecycle | `enabled → disabled` |
| ③ core_attributes | name / parent_id(org 层级树，区域/子团队中间层) / pool_config(JSONB：线索池/公海领取回收规则) / capacity(配额) |
| ④ ai_attributes | region_performance(J_Judge) / team_health(A_Alert) |
| ⑤ states | enabled/disabled + 组织树版本 |
| ⑥ processes | 组织变更时间线 |
| ⑦ events | 组织/角色/池规则变更事件 |
| ⑧ relations | `parent`(ORGANIZATION) / `member_of`(PERSON) / `governs`(DEAL/ACCOUNT 数据范围) |
| ⑨ unstructured_data | 规章制度文档 |
| ⑩ vectors | L0 向量（组织名） |

#### P8 CRM_KNOWLEDGE（知识/本体词表）

| 维度 | 内容 |
|---|---|
| ① identity | knowledge_id |
| ② lifecycle | `registered → deprecated` |
| ③ core_attributes | term(中英双写) / type(select: 业务术语/行业词/规则/决策记录) / layer(L1-L4 归属) / semanticEntities(本体词条登记) |
| ④ ai_attributes | knowledge_coverage_map(S_Sight) |
| ⑤ states | registered/deprecated + 版本 |
| ⑥ processes | 本体词汇登记时间线 |
| ⑦ events | 词表登记/进化沉淀事件 |
| ⑧ relations | `instanceOf`(粒子类型) / `explains`(规则/决策) / `derivedFrom`(进化) |
| ⑨ unstructured_data | 术语定义文档 |
| ⑩ vectors | L0 向量（术语定义，长文本向量优先） |

#### P9 CRM_UNSTRUCTURED_ASSET（非结构化证据）

| 维度 | 内容 |
|---|---|
| ① identity | asset_id |
| ② lifecycle | `uploaded → archived` |
| ③ core_attributes | type(select: 报价明细/合同附件/发票票据/工商证照/跟进记录/会议纪要) / file_name / mime / size / owner / source_ref |
| ④ ai_attributes | doc_summary(B_Brief) / doc_class(C_Classify) |
| ⑤ states | uploaded/archived + 分块/向量状态 |
| ⑥ processes | 文档→分块→向量三层管道（写时构建） |
| ⑦ events | 上传/分块/向量化/归档事件 |
| ⑧ relations | `evidenced_by`(DEAL/ACCOUNT/跟进) / `sourcedFrom`(外部数据源) |
| ⑨ unstructured_data | 本体二进制（附件） |
| ⑩ vectors | 三层管道向量（文档→分块→向量，块带 source_ref + 顺序号） |

### 2.2 19 种属性类型约束

所有粒子属性**只从 19 种有穷类型集选择**（text / personal-name / email-address / phone-number / domain / location / number / currency / percent / date / timestamp / select / multi-select / boolean / rating / url / record-reference / actor-reference / interaction），**禁止自创类型**。上述属性模型均已标注类型。

### 2.3 AI 属性 2D 模型（能力轴 × 来源轴）

**P1 CRM_DEAL 逐属性能力轴映射表**：

| 原始属性 | 能力轴 | 派生 AI 属性 | 来源轴 | 置信度示例 |
|---|---|---|---|---|
| expected_amount(currency) | S_Sight + J_Judge | `revenue_forecast`(F_Forecast) | AI 生成 | 0.7 |
| probability(percent 赢率) | J_Judge | `win_probability_adjusted`(J_Judge) | 规则+AI 确认 | 0.85 |
| stage + stage_changed_at | J_Judge | `age_in_stage`(J_Judge) / `stuck_warning`(A_Alert) | AI 度量 | 0.8 |
| last_interaction(interaction) | S_Sight + B_Brief | `engagement_trend`(J_Judge) / `followup_overdue_alert`(A_Alert) | AI 生成 | 0.82 |
| actual_close_date vs expected_close_date | J_Judge | `close_accuracy`(J_Judge 预期 vs 实际对账) | AI 度量 | 0.75 |
| expected_amount + stage history | F_Forecast | `funnel_velocity`(F_Forecast) | AI 生成 | 0.7 |

**P2 CRM_ACCOUNT AI 属性**：

| 原始属性 | 能力轴 | 派生 AI 属性 | 来源轴 | 置信度 |
|---|---|---|---|---|
| industry + region + size | S_Sight + C_Classify | `account_segment`(C_Classify) | AI 生成 | 0.8 |
| deals(owned) + follow records | J_Judge | `customer_health_score`(J_Judge) | 规则+AI 确认 | 0.85 |
| last_interaction | J_Judge | `churn_risk`(A_Alert) | AI 生成 | 0.7 |
| business_title + 工商校验结果 | C_Compliance | `business_verified`(C_Compliance) | 规则+AI 确认 | 0.9 |

**其余粒子 AI 属性**（每粒子 1-5 个，J_Judge 覆盖底座）：

| 粒子 | AI 属性（轴，来源，置信度） |
|---|---|
| P3 CONTACT | relationship_heatmap(B_Brief, AI生成, 0.85) / stakeholder_influence(J_Judge, AI生成+人工确认, 0.8) |
| P4 PRODUCT | price_trend(C_Classify, AI度量, 0.8) / demand_forecast(F_Forecast, AI生成, 0.65) |
| P5 PRICE_LIST | price_fairness(J_Judge, AI生成, 0.75) |
| P6 PERSON | activity_level(J_Judge, AI度量, 0.85) / workload_estimate(J_Judge, AI生成, 0.7) |
| P7 ORGANIZATION | region_performance(J_Judge, AI生成, 0.75) / team_health(A_Alert, AI生成+人工确认, 0.8) |
| P8 KNOWLEDGE | knowledge_coverage_map(S_Sight, AI生成, 0.75) |
| P9 ASSET | doc_summary(B_Brief, AI生成, 0.8) / doc_class(C_Classify, AI生成+人工确认, 0.85) |

### 2.4 交互粒子必带属性

- **P1 DEAL**：`lastActivityAt` / `nextActionAt`（跟进计划挂载，interaction 类型）
- **P2 ACCOUNT**：`lastActivityAt` / `nextActionAt`
- **P3 CONTACT**：`lastContactedAt`
- **P6 PERSON**：`lastActiveAt` / `pendingTodoCount`
- **P7 ORGANIZATION**：`lastReviewAt`

> **ATTIO C 桶（2026-08-25 借鉴，见 11 增量设计 §3.4）**：交互粒子在 `payload.interaction_index` 内按渠道维护 **first/last/next 计算指针**（`src/particles/interactionIndex.js` 纯函数 + `recordInteraction` 写时维护）。渠道枚举：`email / calendar / call / meeting / general`；事件平面 `events.payload.channel` 记录每次交互渠道（GIN 索引加速查询）。

### 2.5 why 层硬门槛（记忆系统判据）

每个**核心业务粒子**带决策理由载体：
- **P1 DEAL**：`stage_change_reason`（赢单不可回退/输单必填原因）+ `transitionedBecause`（受控谓词边，记录"为什么推进到该阶段、哪些备选被否决"）
- **P2 ACCOUNT**：`dormant_reason`（客户休眠原因）
- **P3 CONTACT**：`decision_power_basis`（角色判定依据）
- **P4 PRODUCT**：`price_change_reason`（价格变更理由，价格变更日志必填）
- **P7 ORGANIZATION**：`pool_rule_reason`（池规则配置理由）

缺 why 载体 → 判为"记录系统"而非"记忆系统"。以上五个核心粒子全部补齐，满足 Oleg Product Memory 硬门槛。

## 3. 知识分层归属（L1-L4）

| 知识资产 | targetLayer | 物理 source | scbjFmocaKind |
|---|---|---|---|
| 粒子 Schema（类型/属性定义） | L1 | knowledge + AGE 图 | 结构定义 |
| 受控谓词表（19 谓词） | L1 | knowledge + AGE 图 | 结构定义 |
| 业务术语词表（线索/商机/赢率/公海…） | L1 | KNOWLEDGE 粒子 | 结构定义 |
| 历史案例（赢单案例/丢单原因/跟进复盘） | L2 | memory 粒子 | 实例数据 |
| AI 派生属性值（revenue_forecast/win_probability…） | L2 | memory（derived_attribute_value） | 实例数据 |
| 审批流契约（HITL 检查点/交接） | L3 | blueprint collaboration | 结构定义 |
| 审批闸门状态（待办/风险分级） | L4 | gate-event 粒子 + gates | 实例数据 |
| 池规则（线索池/公海领取回收） | L4 | organization.pool_config（治理配置） | 结构定义 |

**强制规则**：① 结构定义（Schema/词表/谓词）→ L1，实例数据（案例/AI 属性值/闸门状态）→ L2/L4，不混层；② 状态机枚举属性 → L1 登记 + L4 闸门过滤，**故意不走 L2 语义检索**；③ AI 自生成报告标 `aiGenerated:true`（下游软降权防自强化漂移）。

## 4. 关联边（受控谓词，拒绝裸外键）

**每粒子受控谓词**（已在 2.1 各粒子 ⑧ relations 中列全）：

| 边类型 | 语义 | 关键边属性 |
|---|---|---|
| `belongs_to` | DEAL→ACCOUNT（客户所有交易） | edge_source=auto（引用型自动建边） |
| `owned_by` | DEAL/ACCOUNT→PERSON（归属） | edge_source=auto |
| `part_of` | DEAL/PERSON→ORGANIZATION（组织归属） | edge_source=auto |
| `has_employee` | ACCOUNT→CONTACT | edge_source=auto |
| `works_at` | CONTACT→ACCOUNT | edge_source=auto |
| `priced_by` | PRODUCT↔PRICE_LIST（四级定价链） | edge_source=auto + valid_from/valid_until（价格有效期）|
| `used_in` | PRICE_LIST→DEAL（报价用价格表） | edge_source=auto |
| `referenced_in` | PRODUCT→DEAL | edge_source=auto |
| `evidenced_by` | DEAL/ACCOUNT→UNSTRUCTURED_ASSET | edge_source=auto_weak（AI 关联需确认）+ evidence_ref |
| `sourcedFrom` | UNSTRUCTURED_ASSET/DEAL→外部数据源（标讯/企查查） | edge_source=auto_weak（低置信需 review）+ relation_confidence |
| `transitionedBecause` | DEAL stage→reason（why 载体） | edge_source=human（决策理由）+ ai_reasoning_trace |
| `instanceOf` | PRODUCT→KNOWLEDGE（类别） | edge_source=auto |
| `explains` | KNOWLEDGE→规则/决策记录 | edge_source=auto_weak |
| `member_of` | PERSON→ORGANIZATION | edge_source=auto |
| `governs` | ORGANIZATION→数据范围（RBAC） | edge_source=auto + 权限语义 |
| `temporallyFollows` | 跟进事件 → 下一个动作（时序因果校验） | edge_source=rule + 时间因果校验（原因不得晚于结果） |

**追溯/归因主链**：
- **正向 L2C**：ACCOUNT →（owns）→ DEAL →（transitionedBecause）→ 阶段理由 →（evidenced_by）→ 报价/合同/发票证据
- **逆向客户 360**：UNSTRUCTURED_ASSET →（sourcedFrom）→ 外部数据源 →（evidenced_by）→ DEAL →（belongs_to）→ ACCOUNT
- **定价链**：PRODUCT ↔（priced_by）↔ PRICE_LIST →（used_in）→ DEAL（quoted 阶段报价明细）
- **财务对账**：DEAL（financial_state 计划）↔（temporallyFollows）↔ DEAL（financial_state 实回）→ 逾期判定

**时间因果校验**：跟进/阶段转换/回款记录等时序关联边，**原因不得晚于结果**（防幻觉边）；AI 关联边（auto_weak）带 `relation_confidence`，≤0.6 默认 needsReview 不自动入图（幻觉边治理）。

## 5. 知识增强层（非结构化 + 向量 + 本体 + RAG）

- **非结构化资产**：`CRM_UNSTRUCTURED_ASSET` 独立粒子（有独立身份保留为粒子），承载报价明细快照/合同附件/发票票据/工商证照/跟进记录/会议纪要。
- **三层管道**：文档→分块→向量。块按语义边界切（标题/段落/表格），块带 `source_ref`（文档 ID + 原文偏移）+ 顺序号（上下文拼接）；**拒绝整篇一个向量**。
- **向量化粒度**：L0 整实体默认（P0，覆盖 80% 检索场景）；L1 属性字段向量（P2，行业/区域/规模筛选）；**L2 AI 派生属性向量（P1——最有价值增量）**：对 `payload.ai.attributes[]` 逐条 embedding + 标 `axis` 码，AI 属性可语义检索（如"找到高流失风险的客户"），不只精确匹配。
- **KGEdge 语义边**：受控谓词边（§4），关键边带置信度 + 证据引用 + 有效期。
- **RAG 场景清单（≥5 个具体查询）**：
  1. "查询我名下本周新增的线索"（DEAL stage=lead + owner 过滤 + 语义检索）
  2. "最近我部门 30 天没有跟进的线索有哪些"（lastActivityAt 新鲜度 + 语义）
  3. "处于立项汇报阶段的商机有哪些"（DEAL stage + funnel_position 语义）
  4. "生成客户画像"（跨模块聚合：ACCOUNT + 联系人 + 交易 + 跟进 + 工商校验）
  5. "查看销售团队业绩排行"（PERSON 聚合 + 团队维度语义）
  6. "预警快要超期的商机"（expected_close_date + stuck_warning AI 属性语义检索）
  7. "一句话创建客户档案"（NL 写入：意图→Action，语义映射到 ACCOUNT 粒子）
  8. "回款逾期预警"（financial_state 计划 vs 记录对账 + 逾期判定语义）

## 6. Universal Context 注入对接（运行时 L1-L4）

- **注入管线**：`KnowledgeNeedsResolver`（任务知识需求→检索条件）→ `LayerChannelRouter`（L1 AGE / L2 向量 / L3 蓝图 / L4 gates）→ `ContextInjector`（装配 KnowledgeContextPackage）。
- **四层供给策略**：Deploy（全量写时：L1 KG 子图 + L2 top-8 + L3 契约 + L4 快照，≤64KB）/ Seed（无运行时态）/ Dispatch（增量：新粒子 + gate-event，≤16KB）/ 运行时按需 MCP（完整四层分页）。
- **设计阶段必留对接契约**：
  1. 每个 L1 知识资产必须是 AGE 可达顶点（`source_ref` + 受控谓词边）——DEAL/ACCOUNT/PRODUCT 均落 AGE 图节点。
  2. 每个 L2 memory 粒子带 `text_content`（ensureEmbedding/ensureTsVector hook 自动向量化 + FTS；**embedding 覆盖率目标 ≥80%**）。
  3. L3 协同契约从蓝图 taskFlow 结构化提取（审批流节点 = HITL 检查点）。
  4. L4 gate-event 粒子驱动（审批闸门禁缓存，实时查询 + `generatedAt`）。
  5. `knowledgeLevel` 驱动注入 L1..Lx 累积层（角色配置决定注入深度：销售=2，经理=3，高管=4）。

## 7. 支撑粒子（机制业务对象化）

| 支撑粒子 | 用途 | 关键结构 |
|---|---|---|
| particle-type / attr 元模型 | 动态对象模型（新对象按配置长出来，非写死 CRUD 表） | §4.1 元模型；粒子作为 `data.particle` type 值 |
| approval-flow / instance / record | HITL 引擎（覆盖报价/合同/发票/订单四大写域） | flow→version→node→approver→condition→link；会签 ALL/或签 ANY/顺序 SEQUENTIAL；兜底 AUTO_PASS；数据回滚补偿 |
| rule 规则引擎 | AI 写操作护栏（状态机合法流转） | scope+operator+condition+auto+enable；「商机阶段只能向前推进」「合同金额修改超 20% 需审批」「赢单不可回退/输单必填原因」 |
| event 事件 | 事件总线持久化 + 审计 | SSE 5 事件域（task/trace/approval/particle/payment） |
| memory 记忆粒子 | 记忆三构件（快照/推理/决策） | memory_log（append-only）+ memory_note（curated）+ gate-event |
| ontology / vector | 写时构建本体 + 向量索引 | `embedding <=> $qvec`（pgvector）+ AGE 图 |

## 8. 交付物（4 件套衔接）

- **衔接 ai-native-action-design**：粒子 → `data.particle` type 值（**绝不为每个粒子开 CRUD**）；受控谓词 → `data.graph.edge` 边类型（**不为每种谓词开 Action**）。CRM 域只开**跨粒子的领域能力 Action**（如 deal-stage-advance / account-customer-360 / funnel-analyze），粒子 CRUD 复用平台 `data.particle.*` substrate。
- 本文档为粒子系统设计；Action 表面设计（02-10 文档中的 ai-native-action-design）以本文档粒子清单为输入。

## 自检清单（对照 SKILL）

- [x] 粒子数 9 ∈ 8-12 区间，全部满足 C0-C4
- [x] 阶段炸开检查：线索/商机/合同/订单合并为 DEAL 状态机；回款计划/记录降为财务状态流；跟进降为事件流；线索池/公海降为组织配置
- [x] 无文档/事件冒充粒子（报价/合同/发票降为状态+证据）
- [x] 每粒子 10 维齐全；AI 属性 2D（轴+来源齐备）
- [x] 属性类型全部选自 19 种有穷集
- [x] AI 属性数 1-5（本设计每粒子 2-3 个）；J_Judge 覆盖所有业务粒子
- [x] 交互粒子带 lastActivityAt/nextActionAt
- [x] 逐属性能力轴映射 + AI 派生表（两张表已交付）
- [x] 核心业务粒子带 why 层载体（transitionedBecause/price_change_reason 等）
- [x] 关联边全受控谓词，关键边带置信度/证据/有效期；时间因果校验明确
- [x] 知识增强层覆盖（非结构化/向量三层/RAG≥5/本体边/推理规则）
- [x] 知识资产标 layer + source + scbjFmocaKind；结构定义与实例数据分流
- [x] 已预留 Universal Context 注入对接（L1 AGE 可达/L2 覆盖率≥80%/L3 蓝图/L4 禁缓存）
- [x] 已确认粒子作为 `data.particle` type 值、谓词作为 `data.graph.edge` 边类型交付

## 9. 实现状态（阶段 1，2026-08-25 补）

> 与总体架构设计 §8 互证。本文档核心主张阶段 1 已落地；§3 粒子域表与阶段 1 实现存在文档内部表述差异（非代码偏差），见下。

- [x] **9 真粒子落地**：`src/particles/particleModel.js:5-55`（`CRM_DEAL`/`CRM_ACCOUNT`/`CRM_CONTACT`/`CRM_PRODUCT`/`CRM_PRICE_LIST`/`CRM_PERSON`/`CRM_ORGANIZATION`/`CRM_KNOWLEDGE`/`CRM_UNSTRUCTURED_ASSET`），与 §1 C0-C4 收敛清单一致。
- [x] **19 属性类型有穷集 + 16 受控谓词**：`particleModel.js:58-69`（拒绝裸外键，与 §4 一致）。
- [x] **why 层硬门槛载体**：`transitionedBecause` 列入受控谓词（`:67`），DEAL 状态机 `why:'stage_change_reason'`（`:10`）——满足 §2.5 门槛。
- [x] **写时三钩子 + 受控边**：`src/ontology/hooks.js`（ensureEmbedding/ensureTsVector/ontologySync）、`src/particles/particleRepo.js` 落 `edges` 表（与 §4/§5 一致）。
- [ ] **§3 粒子域表 vs 阶段 1 实现（文档内部差异，非代码偏差）**：§3 业务粒子表列 lead/opportunity/quotation/contract/payment/order/follow 等 11+；但 §1 自检（line 347）已确认「线索/商机/合同/订单合并为 DEAL 状态机」，代码 9 粒子（`CRM_DEAL` 合并 lead+opportunity）与此一致。§3 应视为阶段 3 完整愿景，阶段 1 仅 9 粒子子集——文档需标注此层级关系，避免读者误以为 lead/opportunity 是独立表。
- [ ] **未落地业务粒子（阶段 3）**：quotation/contract/payment-plan/payment-record/invoice/order/follow 均未建（属 L2C 业务闭环增量）。
- [ ] **偏差⑤ 动态元模型未实现**：§3.2 主张配置驱动元模型（`particle-type`/`attr`）；阶段 1 用 `particleModel.js` 硬编码收敛清单，无配置元模型（C0-C4 收敛合理，阶段 3 再评估升级）。
- [ ] **偏差② Apache AGE 未用**：本体存 `edges` 表 + pgvector，非 AGE 图（`schema.sql` 仅建 pgcrypto+vector）；§1 单库表述待修正（§8.3-②）。
- [ ] **未落地支撑粒子**：approval-flow / memory / ontology 实体（rule 为代码模块、skill/action 为 registry、memory 阶段 2、ontology 由 vocabulary+edges 承载）。