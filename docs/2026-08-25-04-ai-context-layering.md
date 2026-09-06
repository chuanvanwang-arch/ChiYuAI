# AI 原生 CRM · 04 上下文分层设计（ai-context-layering）

- 日期：2026-08-25
- 方法论依据：`ai-context-layering`（Universal Context L1–L4：四层累积语义 / 逐层通道映射 / 供需一致性 / 降级链 / 七维度齐全轴）
- 业务基线：`2026-08-24-ai-native-sales-crm-design.md` §5ter（19 业务域全景）+ §5ter-quater（Q.19 理念差异 / Q.20 能力×业务设计输入）
- 前置架构：`2026-08-25-ai-native-crm-overall-design.md` §1（四平面）/ §2（context=阶段 2，L4 呈现平面挂点）/ §4（读写双通道）

---

## 0. 核心立场：上下文分层 = 累积注入，角色 = L4 实例

> **上下文分层 = 给一个任务/智能体会话，按它需要的知识深度，注入 L1 知识底座 → L2 历史决策 → L3 执行协同 → L4 治理决策的累积上下文包。核心不是「多」，而是每一层该不该注入、由哪个通道组装、检索失败怎么降级、供需是否对齐都能被解释与观测。**

CRM 销售域关键判别（呼应 §5ter-quater 差异点）：

- **角色不是 profile 文件**（D7 角色分层化）：五种角色的「数据范围/关注重点/主动预警/输出风格/权限边界」是 L4 治理决策层的一个**实例**（七要素 = 注入配置），不是 Java/MySQL 外层封装的角色段。
- **视图、@提及、区域、360 全部是 L1–L4 的检索/注入通道**（D2 语义层 + D12 原生化）：它们统一被门户平面与智能体平面消费，与粒子/事件/记忆同一底座长出来，不是叠在旧系统上的技能。
- **上下文注入本身不走 LLM**（方法论铁律）：每个通道是确定性规则（图遍历/向量+FTS/蓝图函数/闸门查询），LLM 只在 Agent Loop 中消费注入好的上下文做推理。

---

## 1. 方法论依据（提炼 SKILL 核心法则）

### 1.1 三条铁则（跨域通用，不写别项目专有名词）

| # | 铁则 | 含义 |
|---|---|---|
| ① | **与 Action 表面设计正交** | 本能力答「运行时注入多深的知识、怎么组装」；`ai-native-action-design` 答「平台该有几个 Action」。唯一接口 = Action 上的 1 行字段 `contextInjection: L1\|L2\|L3\|L4`。交叉引用，不共享方法论 |
| ② | **命名去歧** | 本文「L1–L4」= Universal Context（任务知识深度），**非**设计流水线阶段、亦**非**架构步骤编号。设计前先确认对方说的 L1 是哪一个 |
| ③ | **Context is produced, not retrieved** | 连接器/知识图谱/检索引擎只提供**原料**；真正的「情境」必须由有权限的主体（人/Agent）拼装（resolve identity / select config / decide authority / follow relations / 缺失维度→标 `missing context`，禁止 AI 自行脑补） |

### 1.2 四层累积模型（逐层累加，失败韧性各异）

| 层 | 语义 | 通道 | 数据源/组装 | 失败韧性 |
|---|---|---|---|---|
| **L1 知识底座** | 实体/关系/本体/数据字典 | `graph` | 图遍历 + 实体向量（三路种子 RRF 融合 + 1 跳关系扩展）；受控谓词边为主 | 失败仅丢信号，不报错 |
| **L2 历史决策** | 历史案例/决策/经验 | `vector+fts` | FTS 预过滤收敛候选池 → 池内向量语义排序；状态机字段做精确过滤不参与语义检索 | 三级降级链（§1.5） |
| **L3 执行协同** | HITL 检查点/交接契约/审批流 | `blueprint` | 蓝图 taskFlow + 协作契约（无检索、纯函数） | 无 I/O、无失败面 |
| **L4 治理决策** | 闸门状态/风险分级/审计轨迹 | `governance` | gates 实时查询 + gate-event 粒子（不可变审计） | gates 禁止缓存，每次重查 |

> 累积语义：`knowledgeLevel = x` 注入 L1..Lx 全部层；`null`（纯人工任务）不参与分层，仅做协作摘要。

### 1.3 第三正交轴：三层情境意识（作用域切，与深度轴/齐全轴正交）

| 层级 | 作用域 | 回答的问题 | 谁拥有 |
|---|---|---|---|
| System Context | 一个应用已知 | 「这个客户号是什么」 | 各业务系统 |
| Domain Context | 一个职能已知 | 「某职能域批了哪些对象」 | 各职能域（销售/商务/财务…） |
| Product Decision Context | 跨系统跨职能为决策组装 | 「这笔交易能不能推进」 | 统一上下文层（多系统联合） |

### 1.4 需求侧编码（不可自由文本）与供给侧组装

- **KnowledgeNeeds 编码**：`dataSupport`（`来源系统(字段)[TYPE]`）+ `semanticSupport`（`EnglishName(中文名)`）；解析产出 `semanticEntities`(≤24) / `dataSources`(≤16) / `requiredFields`(≤40) / `queryTerms`(≤20，且不含 snake_case 字段名)。
- **组装路径**：`KnowledgeProfile.tasks[] → buildKnowledgeNeeds → task-assembler → KnowledgeContextPackage`（写时注入）。
- **体积/新鲜度约束**：`KNOWLEDGE_CONTEXT_BYTE_LIMIT = 64KB`；默认上限 `l1Entities 12 / l1Neighbors 8 / l2Cases 8 / l4Gates 10`；超出截断标 `truncated` 并计入 `degradedLayers`。

### 1.5 供需一致性判据 + 降级链

| 层 | 触发 | 缺口类型 | 判据 |
|---|---|---|---|
| L1 | level≥1 | `MISSING_ENTITY` | 每个 businessObject 在 KG 至少 1 关联实体 |
| L2 | level≥2 | `INSUFFICIENT_EXPERIENCE` / `LOW_COVERAGE` / `MISSING_DATA` | 历史案例≥3 / embedding 覆盖率≥80% / 源至少 1 行 |
| L3 | level≥3 | `MISSING_HITL` | hitlCheckpoints 非空 |
| L4 | level≥4 | `MISSING_GATE` | gates 状态存在；`pendingGates=0` 才可执行 |
| 全部 | — | `STALE_CONTEXT` / `BLUEPRINT_SYNC` | generatedAt 超 24h / 组装失败 |

**降级链（写死顺序，fail-open）**：
1. **L2 三级**：① FTS 预筛 + 池内向量排序（理想）→ ② 纯向量（FTS 0 命中放宽）→ ③ 纯 FTS `ts_rank`。
2. **L1**：`edges` 表为主路（一次 SQL 拿带标签双向邻居），图引擎为补充路（失败标 `degraded`）。
3. **L4**：gates 实时可变状态**禁止长期缓存**；写时注入快照必须带 `generatedAt`。
4. **通用 RRF**：向量余弦距离阈值 `0.7` 截断噪声（`1 - (a <=> b) < 0.3` 才保留）。

### 1.6 七维度齐全轴（与深度轴正交，任一缺失即 AI 自信答错）

Identity（跨系统同一对象）/ Structure（关系可达）/ Semantics（术语跨域对齐）/ Time&Config（当前生效修订）/ Decision History（历史否决）/ Operational State（实时运行态）/ Governance（谁可批/谁来审）。两轴须并列校验。

### 1.7 复用配比与边界

- **7:2:1**：auto(L1/L2 自动注入 70%) / human_gate(L3 人工补充 20%) / governance-gate(L4 强管控 10%)。
- **边界**：仅并列 `ai-native-action-design`（唯一交叉点 = `contextInjection` 字段）；不覆盖粒子建模、Action 基数收敛、具体 LLM prompt 编排。

---

## 2. 业务设计输入（Q.20 + §5ter/§6.2 必须覆盖的 CRM 能力点）

### 2.1 五角色七要素 = L4 配置实例（§5ter.16 / §6.2）

| 角色 | 核心关注 | 数据范围 | 主动预警 | 输出风格 | L4 注入维度 |
|---|---|---|---|---|---|
| 销售 | 我接下来该做什么 | 我的客户/线索/商机 | 超期未跟进、商机卡顿 | 优先级行动清单 | 数据范围=本人 org 子树叶子；关注/预警/输出=注入 |
| 经理 | 谁需要我关注 | 全部门+子团队 | 跟进率低、转化骤降 | 团队看板→下钻个人 | 数据范围=部门 org 子树；团队聚合注入 |
| 高管 | 目标达成如何 | 全公司 | 目标缺口、部门偏离 | 趋势/对比/预测 | 数据范围=全公司；经营分析注入 |
| 商务 | 合同签对了吗 | 合同+审批流 | 到期未续、审批卡顿 | 合同状态+到期预警 | 数据范围=合同域+审批；合同健康注入 |
| 财务 | 钱到哪里了 | 合同→回款→发票 | 逾期、未开票、链路断裂 | 应收全景→催收排序 | 数据范围=财务链路；回款对账注入 |

**七要素完整承载**（§6.2 profiles 实证）：核心关注 / 默认查询偏好 / L2C 典型工作流 / KPI 基准线(正常·警戒·严重三级) / 跨角色协作 / 权限边界 / 角色内子类型。七要素 = L4 实例的配置字段全集。

### 2.2 四个检索/注入通道（Q.20 明确列出）

1. **视图 = 检索条件物化**（Q.14）：`sys_user_view` + `ViewCondition` → 视图 Schema = 粒子查询条件持久化，角色/记忆可复用，AI 可调同一视图作为上下文检索通道。
2. **@提及 → 上下文注入**（Q.10）：评论 `@提及` = 协作提醒事件源 → 事件总线 → 被提及角色下次对话自动带上下文（跨角色协作原生）。
3. **区域 = 组织层级注入**（Q.15-12）：`organization_id` + `parent_id` 层级树 → 区域/子团队中间层 = 上下文分层的**标准维度**（数据范围 = org 子树）。
4. **跨模块 360 上下文**（Q.15-3/10）：客户 360 / L2C 链路追踪 = 本体受控谓词边聚合（ACCOUNT↔DEAL↔CONTACT↔ASSET），一次检索跨模块组装。

**落地阶段**：阶段 2（认知+智能体层），与记忆/Action/门户/反馈同批接线。

### 2.3 §5quater 领域输入补充（B2B 角色地图 + 5 类输入，2026-08-26）

> 来源：`doc/` 两份文档（§5quater Q.21 / 5quater.3 / 5quater.4）。本能力的行业/方法论强化输入：
- **B2B 角色地图 L4 上下文**（§5quater.2 阶段二 / 5quater.3）：在五角色七要素之上，叠加「客户内部决策角色」上下文——Coach(内线)/支持者/反对者/中立/Gatekeeper(把关人)/经济决策者；区分「建议权 vs 拍板权/否决点」。这是 L4 治理决策层的**销售方法论实例化**（E4）。
- **竞品 / 价值 / KPI / 内部红线 / 产能 五类上下文**（5quater.3）：竞品粒子→竞品上下文；客户角色 KPI→价值主张上下文（技术讲指标/业务讲产出/高层讲 ROI）；我方价格政策/毛利/法务→内部红线上下文（L4 注入，写操作前重查）；产能→交期承诺上下文（P4）。
- **5 类高频输入 → L1-L4 注入映射**（5quater.3 表）：客户业务信息→L1+L4视图；组织决策信息→L4角色地图；竞争情报→L1竞品+L4竞品；我方内部→L4红线；风险→L1风险+L2预警。
- **事实 vs 话术**（5quater.4 方法论）：多方信息交叉验证，Coach 真实情报优先于对接人一面之词 → 与记忆层（ai-memory）协同注入。

---

## 3. 落地设计

### 3.1 L1–L4 分层定义与注入时机（对齐 CRM 粒子底座）

| 层 | CRM 承载 | 物理来源 | 注入时机 |
|---|---|---|---|
| L1 知识底座 | 粒子 Schema/受控谓词/业务术语词表（线索/商机/赢率/公海…）；客户 360 关系图 | AGE 图 `edges` 主路 + KNOWLEDGE 粒子 | 读通道（角色+RBAC 数据范围过滤）；Agent Loop 每步前 |
| L2 历史决策 | 历史案例（赢单/丢单/跟进复盘）；AI 派生属性（win_probability/customer_health…） | memory 粒子 + 实体向量 | 同上；deal-coach/lead-miner 推理前 |
| L3 执行协同 | 审批流 HITL 检查点/交接契约（报价/合同/发票/订单四大写域） | blueprint collaboration（纯函数） | 写通道过闸前；blocked(approval) 等待 |
| L4 治理决策 | 角色七要素配置；闸门状态/风险分级；池规则（线索池/公海领取回收） | role_profile + gates + organization.pool_config | 写通道（角色权限边界：能做/不能做）；每次实时重查 |

### 3.2 角色 = 上下文分层 L4 实例：七要素映射

| 七要素 | L4 配置字段（role_profile 粒子） | 注入动作 |
|---|---|---|
| 核心关注 | `focus_query` | 注入默认检索种子（语义实体） |
| 默认查询偏好 | `default_view`（→ ViewCondition） | 视图=检索条件物化（§3.3） |
| L2C 典型工作流 | `workflow_bindings` | 注入阶段化上下文包序列 |
| KPI 基准线 | `kpi_thresholds`（三级） | 注入预警判据（A_Alert 闸门） |
| 跨角色协作 | `collab_triggers` | @提及/状态变更→事件→对端注入 |
| 权限边界 | `rbac_scope`（org 子树 + Action 白名单） | 数据范围过滤 + 写闸字段级权限 |
| 角色内子类型 | `subtype_profiles` | ROLE_MAP 派生独立 profile |

> 三层绑定（D7）：角色驱动 **① 上下文注入（L4）② Action 可见范围（RBAC）③ 智能体绑定（编排）**——同一 role_profile 同时是三者的配置源。

### 3.3 视图 = 检索条件物化（数据/接口草图）

```
user_view 粒子: { view_id, owner_role, view_name,
  conditions: ViewCondition(JSONB)   // 字段/算子/值 + organization_id 范围
}
→ buildKnowledgeNeeds(view) 产出:
   dataSources   ← view.conditions 来源粒子 (≤16)
   queryTerms    ← 语义化条件 (≤20, 不含 snake_case)
   semanticEntities ← 涉及业务对象 (≤24)
→ task-assembler 组装为 L1/L2 检索约束，复用同一通道（非独立查询引擎）
```

### 3.4 @提及 → 上下文注入（事件流草图）

```
follow 评论树 parentId + @提及(被提及人 PERSON)
  → 写时触发 协作提醒事件(事件平面 SSE)
  → 事件总线广播:
       ① 通知被提及人（门户红点）
       ② 标 registered: 被提及人下次会话 ContextPackage 自动带
          source_ref = 该 follow/DEAL/ACCOUNT 上下文（跨角色协作原生）
```

### 3.5 区域 = 组织层级注入

- `CRM_ORGANIZATION` 带 `parent_id` 层级树；角色 `rbac_scope` = 以本人 org 为根的**子树**。
- 数据范围过滤在 L1 图遍历与 L2 向量检索的 `dataSources` 阶段生效（organization_id RBAC 贯穿，呼应总体架构 §4 读通道）。
- 区域复盘（Q.15-12）= 沿 org 树向上聚合的 L2/L4 注入。

### 3.6 跨模块 360 上下文（客户 360 聚合）

```
ACCOUNT
  ├─(owns)→ DEAL[]         （L1 belongs_to/owned_by 边）
  ├─(has_employee)→ CONTACT[]
  └─(evidenced_by)→ UNSTRUCTURED_ASSET[]（工商证照/合同附件）
→ KnowledgeContextPackage.l1Entities 跨模块展开（≤12），
  l1Neighbors 1 跳关系扩展（≤8）；缺失维度标 missing context
```

### 3.7 KnowledgeContextPackage 草图

```json
{
  "knowledgeLevel": 3,
  "l1Entities": [{"id":"CRM_DEAL:...", "neighbors":8}],
  "l2Cases": [{"type":"win_case","score":0.82}],
  "l3Contract": {"hitlCheckpoints":["quote_approve"]},
  "l4Gates": [{"subject":"CRM_CONTRACT:...","risk_level":"LOW","pendingGates":0}],
  "generatedAt": "2026-08-25T10:00:00Z",
  "degradedLayers": ["L2"],
  "retrieval": {"vectorUsed":true,"ftsPrefiltered":true,"embeddingCoverage":0.83,"notes":"L2 fallback to pure-FTS"}
}
```

> **建议**：role_profile 与 user_view 作为支撑粒子挂 L1 粒子平面（阶段 2 设计态落库，运行时由 task-assembler 消费），与 organization 边协同实现「角色=L4 实例」。

---

## 4. 与其他能力 / 四平面的接口

| 方向 | 对接能力/平面 | 接口形态 |
|---|---|---|
| **依赖** | 粒子平面 L1 | L1 图（`edges` 主路）、L2 向量/FTS、KNOWLEDGE 词表、role_profile/user_view 支撑粒子为事实源 |
| **依赖** | 事件平面 L2 | @提及协作提醒事件、审批 gate-event、粒子写事件驱动 L2/L4 实时刷新 |
| **依赖** | 记忆能力 | L2 历史案例/AI 派生属性来自 memory 粒子（写时向量化，覆盖率≥80%） |
| **被消费** | 门户平面 L4 | NL→Action→上下文注入→渲染；每个 Agent 工作台的上下文源（assembleTaskContext 在 dispatch 链调用） |
| **被消费** | 智能体平面 L3 | agentLoop 每步前注入；角色→Agent 绑定（role_profile 同时驱动上下文+Action+编排） |
| **联动** | `ai-native-action-design` | 唯一交叉点 = Action 的 `contextInjection` 字段（声明该 Action 写/读哪层）；角色→Action 可见范围 = RBAC 注入；写闸字段级权限 = L4 权限边界落点 |
| **联动** | `ai-portal-page-generation` | 视图=检索条件物化（§3.3）直接成为门户生成页的查询契约（NL→Schema→渲染器同源） |

---

## 5. 验收判据（来自 §5ter 覆盖 + D7/D2 差异点，可验证）

1. **D7 角色分层化**：五角色七要素全部作为 L4 实例注入生效（数据范围/关注/预警/输出/权限边界切换可观测）；角色驱动上下文+Action+智能体三层绑定闭环验证。
2. **D2 语义层**：L2 向量+FTS 检索可达（embedding 覆盖率≥80%），状态机字段只做精确过滤不参与语义检索。
3. **视图物化**：`user_view` 经 `buildKnowledgeNeeds` 转为检索约束，AI 可调同一视图作为上下文通道；视图复用不重复建查询引擎。
4. **@提及注入**：评论 @提及触发事件→被提及人下次会话自动带上下文（跨角色协作原生，非 CommentMention 表）。
5. **区域层级**：`organization_id` parent_id 树正确展开为数据范围（区域复盘沿树聚合无误）。
6. **360 上下文**：客户 360 跨模块聚合（ACCOUNT+CONTACT+DEAL+ASSET）一次检索成型，缺失维度标 `missing context` 不脑补。
7. **供需一致性**：L2 案例≥3、`LOW_COVERAGE` 告警联动、L4 `pendingGates=0` 才可执行；降级链 fail-open（L2 三级、L1 edges 主路、L4 禁缓存带 generatedAt）。
8. **体积约束**：注入包≤64KB，超出标 `truncated` 计入 `degradedLayers` 供监控消费；检索质量自证（mode/vectorUsed/ftsPrefiltered/embeddingCoverage/notes）可审计。

---

## 6. 不做的事（YAGNI + 不借鉴外层封装）

- **不建独立「角色系统」微服务**：角色是 L4 治理决策层的一个实例（organization 边 + role_profile 支撑粒子配置），不是独立服务，避免与粒子体系游离（呼应总体架构三条不变量 3）。
- **不借鉴 CordysCRM 外层封装实现**：其角色只是 `profiles/*.md` 的 profile 文件、加载进技能段；我们角色是平台上下文分层配置（与检索通道/降级链/记忆统一），不搬 Java/MySQL 外层封装形态。
- **上下文注入不走 LLM**：四层通道全为确定性规则（图遍历/向量+FTS/蓝图函数/闸门查询），LLM 只消费注入结果；不因「智能」而把检索判断塞进 prompt（方法论铁律）。
- **不混用 `ContextLayer` 与 `particles.layer`**：两个正交概念，禁止互相赋值（四值 Observation/Inference/Opinion/Decision ≠ 知识深度 L1–L4）。
- **不做自由文本 KnowledgeNeeds**：需求侧必须 `dataSupport`/`semanticSupport` 编码后由 `buildKnowledgeNeeds` 解析，不整串糊进 query。
- **不缓存 L4 gates**：闸门实时可变状态每次重查，写时快照必须带 `generatedAt`，防止过期治理态导致越权执行。
- **不脑补缺失上下文**：七维度任一缺失→标 `missing context`，禁止 AI 自行拼装未授权/未检索到的实体关系。

---

*（本文档为阶段 2 上下文分层（L1–L4 注入 + 五角色七要素 L4 实例 + 视图/@提及/区域/360 四通道）的设计输入，沿用 ai-context-layering 方法论并实例化到 CRM 销售域。待用户评审后进入 writing-plans。）*
