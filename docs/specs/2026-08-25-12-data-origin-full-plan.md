# AI 原生 CRM · 数据产生全景方案（Data Origin Full Plan）

- 日期：2026-08-25
- 触发：用户问「这些数据是如何进行产生的，请逐一进行分析，哪些是前台填写、哪些是 AI 自动产生、如何产生 → 给出全面完整解决方案」
- 范围：以本平台 9 粒子 + 决策事件主轴为对象，逐一给出每类数据的**来源分类（人工/AI/规则/外部）**、**产生路径**、**落库机制**与**责任边界**。
- 设计基线：总体设计 §4（读写双通道+写通道三闸+第0闸）、01 粒子设计 §2.3（AI 属性 2D 模型）、记忆三构件（capture/memoryLog）、ATTIO 11 增量。
- 状态：**设计文档（待实现部分在 §6 标注，未批准不写实现代码）**

---

## 0. 核心立场（数据产生四分类）

> **一切数据都必须回答「谁产生的 + 怎么产生的 + 为什么写」。**

数据产生路径只有 4 类，任何粒子属性必归其一：

| 分类 | 含义 | 写入者 | 是否过闸 |
|---|---|---|---|
| **① 人工填写（前台）** | 由人在前台页面/对话中显式输入或选择 | 人（sales/manager/…） | 是（写通道三闸） |
| **② AI 自动产生** | 由智能体/AI 引擎从既有数据**推导/综合/预测**新值 | AI（deal-coach/lead-miner/crm-risk…） | 是（第0闸 + autoDecision 拍板） |
| **③ 规则/派生** | 由确定性规则/公式/对账从既有数据**计算**出来，非 AI | 规则引擎/钩子（写时三钩子、distill、对账） | 第0闸按需 |
| **④ 外部/自动采集** | 由外部数据源（标讯/企查查/ATTIO 型 enrichment/邮件日历同步）导入 | 连接器/采集管道 | 是（auto_weak 边 + review；写通道净化） |

> 铁律：**①③④ 是事实源（ground truth），② 永远挂 AI 属性（带轴+置信度+理由）不冒充事实**。AI 生成内容落 `payload.ai.*` 或 `confidence` 标注区，不得覆盖人工事实字段。

---

## 1. 九粒子的数据产生逐一分析

### 1.1 CRM_DEAL（交易）
| 属性 | 分类 | 产生路径 |
|---|---|---|
| name / source / owner_id / expected_amount / expected_close_date | ① 人工 | 前台新建商机表单 → NL 一句话写入（crm-write 两阶段）→ 写通道第0闸（autoDecision: crm-deal-create）→ createParticle |
| stage（lead→…→paid/lost） | ① 人工（跟进推动）**或** ② AI（经 autoDecision） | 人工：前台"推进阶段"按钮 → crm-deal-advance（规则校验只进不退 + 输单必填原因）；AI：deal-coach 经 autotomyEngine 判定低风险+先例充足 → autoDecision mint → 写 |
| stage_change_reason / transitionedBecause | ① 人工（必填，why 载体） | 输单/赢单必须填原因，写通道拦截缺 reason 的流转 |
| probability / win_probability_adjusted | ① 人工初值 + ② AI 修正 | AI 从历史同 scenario 赢率 + 阶段停留 + 跟进频率 综合 → 标 AI 属性（J_Judge, 置信度） |
| revenue_forecast / age_in_stage / stuck_warning / engagement_trend / funnel_velocity | ② AI | dealer-coach / crm-risk 定时或事件触发 → 从 stage/expected_amount/last_interaction/历史先例 推导 → 落 `payload.ai.*`（轴+置信度+理由） |
| expected_amount 校验 / stage 只进不退 | ③ 规则 | ruleEngine（§4 规则层）写前校验，非数据产生但拦截非法写入 |
| actual_close_date / closed_reason | ① 人工 | 前台赢单/输单登记（输单必填原因） |
| 关联边 belongs_to / owned_by / part_of | ③ 规则 | ontologySync 钩子从 account_id/owner_id/org_id 自动建受控边（edge_source=auto） |

### 1.2 CRM_ACCOUNT（客户）
| 属性 | 分类 | 产生路径 |
|---|---|---|
| name / industry / region / source / size / business_title / domains / 社媒 | ① 人工 **或** ④ 外部采集 | 人工：前台新增客户表单 / NL 一句话；外部：企查查工商数据源（business_title 校验）、ATTIO 型 enrichment（domains/employee_range/funding…）经连接器导入 → auto_weak 边 + relation_confidence，低置信需 review |
| 工商统一信用代码 / 注册地址 / 法人 | ④ 外部（企查查/工商） | 采集管道 → 写通道净化 → business_verified(规则+AI 确认) |
| customer_health_score / churn_risk / account_segment / business_verified | ② AI（或 ③+② 混合） | crm-risk / deal-coach 从 deals(owned)+follow+last_interaction+工商校验结果 推导 → AI 属性（J_Judge/C_Classify 带置信度） |
| 生命周期 dormant/lost | ① 人工（dormant_reason 必填） | 前台标记休眠/流失 → 写通道第0闸 → 记录 dormant_reason（why 载体） |
| champion_strength / key_contact | ① 人工 | 前台勾选关键决策人 → key_contact 自动建受控边（hooks） |
| 社媒 follower 数（twitter_follower_count） | ④ 外部 | 连接器定时拉取 → 写时校验 |

### 1.3 CRM_CONTACT（联系人）
| 属性 | 分类 | 产生路径 |
|---|---|---|
| name / email / phone / title / department / decision_power / job_title / primary_location / company | ① 人工 **或** ④ 外部（名片/邮箱签名/ATTIO enrichment） | 人工：前台新增联系人；外部：名片扫描、邮箱签名解析、ATTIO 型 enrichment → auto_weak 边需 review |
| relationship_strength（ATTIO D 桶） | ① 人工标定 | 前台 select 选择（人标事实） |
| relationship_heatmap / stakeholder_influence | ② AI | deal-coach 从交互记录/邮件往来/角色标签 综合 → AI 属性（B_Brief/J_Judge） |
| last_contacted_at / 交互 first/last/next（interaction_index） | ③ 规则（事件驱动） | recordInteraction（ATTIO C 桶）从跟进/邮件/会议事件写时维护 |
| works_at / has_employee 边 | ③ 规则 | ontologySync 自动建边 |

### 1.4 CRM_PRODUCT（产品）
| 属性 | 分类 | 产生路径 |
|---|---|---|
| name / category / base_price / unit / price_change_reason | ① 人工 | 前台产品/价格变更表单（价格变更理由必填，why 载体） |
| price_trend / demand_forecast | ② AI | 从历史价格/报价引用次数 推导 → AI 属性 |
| 价格变更日志 | ③ 规则 | 价格变更写时审计 → 事件流 + price_change_log |
| priced_by / referenced_in 边 | ③ 规则 | ontologySync / 报价明细引用自动建边 |

### 1.5 CRM_PRICE_LIST（价格表）
| 属性 | 分类 | 产生路径 |
|---|---|---|
| name / currency / valid_from / valid_until / permission / price_rules | ① 人工 | 前台价格表设计 |
| price_fairness | ② AI | 从价格区间/客户等级/历史成交价 推导 |
| 状态 draft→active→expired | ③ 规则（时间驱动） | valid_until 过期自动转 expired（定时任务）|

### 1.6 CRM_PERSON（员工/操作人）
| 属性 | 分类 | 产生路径 |
|---|---|---|
| name / email / role_tags / org_id / region | ① 人工（管理员/HR） | 组织管理后台（种子 seed.sql 预置 6 角色） |
| activity_level / workload_estimate | ② AI | 从任务/跟进/操作审计事件 统计推导 |
| 操作审计（谁做了什么） | ③ 规则（事件驱动） | 一切写操作 → events 表 → 审计 |
| last_active_at | ③ 规则 | 登录/操作事件写时更新 |

### 1.7 CRM_ORGANIZATION（组织）
| 属性 | 分类 | 产生路径 |
|---|---|---|
| name / parent_id / pool_config / capacity / pool_rule_reason | ① 人工（管理员） | 组织管理后台（池规则配置，reason 必填） |
| region_performance / team_health | ② AI | 从组织下 DEAL/ACCOUNT 聚合推导（+人工确认） |
| governs 数据范围 | ③ 规则 | role_context_profile 绑定（阶段2） |

### 1.8 CRM_KNOWLEDGE（知识/词表）
| 属性 | 分类 | 产生路径 |
|---|---|---|
| term / type / layer / semanticEntities | ① 人工（本体管理员） **或** ③ 规则（写时词汇登记） | 人工：词表管理；规则：ontologySync 的 registerVocabulary 从枚举属性自动登记 |
| knowledge_coverage_map | ② AI | 属性覆盖率扫描 → 派生 |
| derivedFrom 进化 | ③ 规则/AI | 事件驱动进化（ai-event-driven-evolution，阶段2） |

### 1.9 CRM_UNSTRUCTURED_ASSET（非结构化证据）
| 属性 | 分类 | 产生路径 |
|---|---|---|
| type / file_name / mime / owner / source_ref | ① 人工（上传） | 前台上传附件 → 写通道 → 分块管道 |
| doc_summary / doc_class | ② AI | 上传后异步 AI 处理（B_Brief 摘要 / C_Classify 分类）→ AI 属性 |
| 分块/向量状态 | ③ 规则 | 文档→分块→向量三层管道（写时构建，ensureEmbedding/ensureTsVector） |

---

## 2. 决策事件主轴：数据产生的治理闸门

**每一条写数据都必须走决策事件主轴**（§6 顶层逻辑）：

```
人/AI/外部 产生数据
   → 识别决策场景（decision_scenario：stage + trigger + methodology + eval_dimensions）
   → 写通道第0闸：本次写必须关联决策（无决策不写）
       ├─ 低风险 + 高置信先例 → decision_autonomous（AI 拍板, 记 decision_id + precedents + rationale）
       ├─ 中风险 → HITL（人确认, decider 记录）
       └─ 高风险 → 强制升级（上级 role 背书 + 审计高亮 + EXCEPTION）
   → 决策落 `decision` 表（不可变）→ memory_log 沉淀
   → 业务粒子写入（事务）→ 三钩子（embedding/fts/ontologySync）
```

- **人工填写** = 人在前台提交 → 前端调写通道 → 第0闸 autoDecision mint（低风险）/ HITL（中风险）
- **AI 自动产生** = 智能体调用 Action → 第0闸（autoDecisionAction 自行 mint 或关联决策）→ 写
- **外部采集** = 连接器 → 净化 + 第0闸（配 autoDecision 或 HITL review）→ 写

---

## 3. AI 自动产生机制详解（② 的完整链路）

AI 产生 = **"从既有事实推导新知识"**，五步：

| 步 | 机制 | 实现 |
|---|---|---|
| 1 触发 | 事件触发（粒子写后订阅）或定时（nightly distill / 每 30 分钟 crm-risk 扫描） | src/events/bus.js on('*') |
| 2 输入组装 | 上下文分层注入（L1 粒子图 + L2 记忆 + L4 闸门状态） | context-layering（已设计） |
| 3 推理 | LLM（SiliconFlow DeepSeek-V4-Flash）或确定性算法（hashVector 等测试降级） | src/llm.js / src/agent/agentLoop.js |
| 4 校验 | 决策第0闸 + action-confirm + 规则校验（不得覆盖人工事实字段） | src/action/executor.js:14 |
| 5 落库 | 写 `payload.ai.*`（轴 + confidence + rationale）——**AI 属性区**，不混入人工事实区 | particles.payload JSONB |

**AI 属性 2D 模型**（01 设计 §2.3）：每 AI 属性 必须带「能力轴」（S_Sight 看见/C_Classify 分类/J_Judge 判断/F_Forecast 预测/A_Alert 预警/B_Brief 简报/C_Compliance 合规）+「来源轴」（AI 生成/规则+AI 确认/AI 度量）+ 置信度。
- 置信度 < 0.6 → 默认 needsReview，不自动影响业务流程
- AI 生成内容标 `aiGenerated:true` → 下游软降权（防自强化漂移）

**记忆捕获**：AI 每次产出 → 事件总线广播 → captureMemory 自动沉淀 memory_log（topic=`event:<domain>:<type>`，30 天 TTL，append-only）。

---

## 4. 外部/自动采集（④）机制

| 源 | 数据类型 | 产生路径 | 信任 |
|---|---|---|---|
| 标讯源 | DEAL 线索 | 连接器定时拉取 → 净化 → 第0闸 → autoDecision（crm-deal-create）→ 写 | auto_weak + review |
| 企查查/工商 | ACCOUNT business_title/统一代码 | 校验管道 → business_verified(规则+AI) | 权威源直接采信 |
| ATTIO 型 enrichment | domains/funding/foundation/社媒/employee_range | 连接器 → 写时校验 → auto_weak 边低置信需 review | auto_weak |
| 邮件/日历/会议 | 交互事件（channel=email/calendar/meeting） | 同步管道 → recordInteraction（ATTIO C 桶）→ interaction_index 写时维护 | 事件事实 |

**红线**：外部数据一律净化 + SQL 参数化 + 绝对禁删（§5bis G/C 实证）；低置信自动关联（auto_weak）不直接入图，需人工 review 后转 auto。

---

## 5. 前台人工填写（①）清单（按角色）

| 角色 | 可填写的粒子/属性 | 前台入口 |
|---|---|---|
| sales | DEAL(name/source/owner/expected_amount/close_date/reason)、ACCOUNT(基础+domains+社媒)、CONTACT(基础+decision_power+relationship_strength)、跟进记录、上传资产 | 对话式工作台（crm-write 两阶段）+ 表单页 |
| manager | DEAL 阶段推进确认、ACCOUNT dormant_reason、团队 DEAL 备注 | 审批/闸门页 + 看板 |
| finance | 回款计划/实回（financial_state）、发票上传 | 财务工作台 |
| presales / contract_admin | 技术方案（CRM_TECHNICAL_PROPOSAL）、合同条款 | 售前/商务工作台（rbac 硬闸） |
| admin/HR | ORGANIZATION(pool_config)、PERSON(role_tags)、PRICE_LIST、PRODUCT | 管理后台 |

---

## 6. 已落地 vs 待实现（诚实标注）

| 机制 | 状态 | 代码锚点 |
|---|---|---|
| 人/AI/外部 统一走写通道 + 第0闸 | ✅ 已落地 | src/action/executor.js:14 decision-gate |
| 三钩子（embedding/fts/ontologySync 自动边） | ✅ 已落地 | src/ontology/hooks.js |
| recordInteraction / interaction_index（ATTIO C 桶） | ✅ 已落地 | src/particles/interactionIndex.js |
| key_contact 自动边、coreAttributes 声明 | ✅ 已落地 | particleModel.js / hooks.js |
| 记忆捕获（capture→memory_log） | ✅ 已落地 | src/memory/capture.js + routes.js:18 |
| AI 属性落 `payload.ai.*` 带轴/置信度 | ✅ 已落地（2026-08-25） | src/aiAttributes/evaluator.js + particleRepo 写后触发（commit 046849b） |
| 决策场景自动识别（trigger 匹配） | 🔶 决策表/引擎已建、自动识别待阶段2 | decision_scenario + autonomyEngine |
| 外部连接器（标讯/企查查/ATTIO enrichment 管道） | ✅ P0 已落地（2026-08-25） | src/connectors/connectorActions.js（conn-attio-enrich-account + conn-zhizao-verify-account，autoDecision 过第0闸 + sourcedFrom auto_weak 边，commit 875d2df） |
| HITL 审批流第三闸（approval-flow 四写域） | ⬜ 阶段3 | §8.3-③ |
| nightly distill / 定时 AI 扫描 | ✅ 已落地（2026-08-25） | src/scheduler/timers.js（nightly 蒸馏 24h + crm-risk 扫描 30min，幂等单例；routes 接线 3e8db8c；commit da78bad） |

> **结论**：平台的数据产生**骨架子系统已全部就位**（写通道+第0闸+三钩子+记忆捕获+ATTIO 属性声明）；缺失的是「AI 属性落地评估器（阶段2）」「外部连接器（阶段3）」「HITL 第三闸（阶段3）」，其余已可为任一粒子属性标注"谁产生/怎么产生"。

---

## 7. 建议下一步（按优先级）

1. ~~AI 属性评估器（阶段2）~~ **✅ 已完成**（2026-08-25，commit 046849b）：`src/aiAttributes/evaluator.js` 把 §2.3 的 2D 模型做成可执行 `evaluateAiAttributesFor(entity)` —— 每 AI 属性带轴/置信度/理由落 `payload.ai.*`；写事件触发（particleRepo create/update 后自动评估）+ LLM 可注入（无 LLM 走确定性兜底）
2. ~~前端"数据来源"展示~~ **✅ 已完成（2026-08-25）**：`src/web/particle-detail.html`（路由 `GET /particle-detail.html`）+ `GET /api/particles/:id` 详情 API（`src/http/particleDetail.js` 纯组装：particle + sourcedFrom 出边 + 关联实体名）+ `src/web/sourceClassify.js` 属性来源四查纯函数（页面与测试共用，杜绝口径漂移）—— 每属性显示 ①/②/③/④ 来源徽标 + AI 能力轴/置信度/理由；②待生成标 needsReview；④透传 relation_confidence 与 confirmed/待review。**阶段 3 前台页面开发直接复用此详情境为字段采集查证锚点**（总体设计 §8.7 字段采集四查）
3. ~~定时器接线~~ **✅ 已完成**（2026-08-25，commit da78bad + routes 接线 3e8db8c）：`src/scheduler/timers.js` nightly distill 24h + crm-risk 30min 扫描，幂等单例防双实例
4. ~~外部连接器 P0~~ **✅ 已完成**（2026-08-25，commit 875d2df）：`src/connectors/connectorActions.js` 两 Action（ATTIO enrichment + 工商校验），autoDecision 过第 0 闸 + sourcedFrom auto_weak 边带 relation_confidence —— 让 ④ 产生真实数据
5. HITL 审批流第三闸（approval-flow 四写域）：**阶段 3**（§8.3-③）

> **更新（2026-08-26 收口）**：1/2/3/4 全部落地（前端展示见上第 2 条，测试 `test/data-origin.test.js` 10/10）。剩余 = HITL 第三闸（阶段 3）。阶段 3 前台页面开发时必须执行总体设计 §8.7 的「字段采集四查」，确保所有字段有产生通道（①人工输入控件 / ②AI 评估器只读展示 / ③规则定时器 / ④连接器 + review 入口），无孤儿字段 —— 详情页 `particle-detail.html` 已成四查的肉眼查证工具。