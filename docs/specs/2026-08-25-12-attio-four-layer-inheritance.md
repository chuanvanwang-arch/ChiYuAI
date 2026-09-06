# AI 原生 CRM · 12 ATTIO 新增字段「四层承接」审计与系统解决方案

- 日期：2026-08-25
- 审计对象：`docs/2026-08-25-11-attio-enrichment-design.md`（A+B+C+D 增量设计）
- 方法论依据：10 大 ai-*（写库即构建 / 上下文分层 L1-L4 / 记忆生命周期 / 决策事件主轴）
- 范围：**代码级取证**（grep + 通读 `src/`），非文档口径。判定标准：字段是否在四层（知识体系 / 记忆系统 / 决策层 / 智能体）被**主动消费**。

## 0. 结论（先讲重点）

ATTIO 新增的 **16 个属性 + 1 个计算指针（interaction_index）** 目前处于 **「Schema 孤岛」** 状态：

- ✅ **全部在 `particleModel.js` 声明**（通过 19 类型集校验闸门）—— 仅满足"能存"。
- ✅ **被动进了 embedding / FTS**（`hooks.js:9` 把整个 `payload` 哈希向量化、`hooks.js:23-26` tsvector 含全 payload）—— 但这是**无差别整包索引**，无字段级语义、无权重、无投影。
- ✅ **唯一主动消费点**：`key_contact` 经 `hooks.js:41` 自动建 `key_contact` 受控边；`interaction_index` 由 `interactionIndex.js` 写时维护。
- ❌ **知识体系（词汇登记）**：`vocabulary.js:4` 的 `ENUM_HINT_FIELDS` 不含任何 ATTIO select 字段（`categories`/`estimated_arr_usd`/`employee_range` 全漏接）。
- ❌ **记忆系统**：`capture.js` 仅订阅事件、整包存 `event.payload`，**不读取任何 ATTIO 属性**；firmographics 是静态属性而非事件，永不被记忆层结构化捕获。
- ❌ **决策层**：`autonomyEngine.js` 只读 `business_tier` / 方法论 conditions / 先例，**完全不读** `champion_strength` / `relationship_strength` / `funding_raised_usd` 等。
- ❌ **智能体上下文层**：`assembler.js` 的 L1-L4 检索**不投影任何 ATTIO 字段**为结构化上下文；`domains` 身份解析（设计文档声称的 auto_weak 边 + relation_confidence）**在 src/ 零实现**（grep `auto_weak|relation_confidence|identity` 零命中）。

> **一句话**：16 个字段"存得进、搜得到（被动整包），但四层都不按字段语义用"——除 `key_contact` 建了边、interaction_index 有维护器外，其余 ~15 个字段在知识/记忆/决策/智能体四层**均零主动承接**。

## 1. 字段清单（来自 11 设计 §3.1/§3.2/§3.4）

**ACCOUNT（桶 A + D 部分，14 项）**：domains / funding_raised_usd / foundation_date / estimated_arr_usd / employee_range / categories / logo_url / linkedin / twitter / facebook / instagram / angellist / champion_strength / key_contact

**CONTACT（桶 B + D，8 项）**：job_title / avatar_url / primary_location / linkedin / twitter / relationship_strength / company / （社媒复用）

**交互（桶 C，1 项）**：interaction_index（payload 计算指针）

> 说明：linkedin/twitter 在两类粒子重复，去重后共 **16 个独立属性 + interaction_index**。

## 2. 四层承接取证（file:line）

### 2.1 知识体系（ontology：embedding + vocabulary + 受控边）
| 机制 | 位置 | 对 ATTIO 字段的态度 |
|---|---|---|
| embedding 哈希 | `hooks.js:8-18`（`ensureEmbedding`，`text = JSON.stringify(payload)`） | **被动整包**：所有字段进向量，无字段级语义 |
| tsvector | `hooks.js:22-31`（`payload.name/title/term + JSON(payload).slice(0,800)`） | **被动整包**：全 payload 进 FTS |
| 词汇登记 | `vocabulary.js:4` `ENUM_HINT_FIELDS=['industry','region','stage','source','category','type']` | **仅单数 `category` 在内；`categories`(复数)/`estimated_arr_usd`/`employee_range` 全部漏接** |
| 受控边 | `hooks.js:37-50`（refs 列表） | **仅 `key_contact` 进自动边**；`company`(record-reference) 未进 refs（设计称"冗余引用便于检索"但无读者） |
| 身份解析 | 设计 §3.1 称 domains→"邮箱域名→公司 auto_weak 边 + relation_confidence" | **src/ 零实现**（grep 无 `auto_weak`/`relation_confidence`/`identity` 消费点） |

### 2.2 记忆系统（memory：capture + judge + note + snapshot）
- `capture.js:7-21`：订阅 `*` 事件，整包存 `event.payload`，**按字段名零读取**。
- ATTIO firmographics / 关系强度是**静态属性**，不触发任何 `events` 事件 → 记忆层永不知其存在。
- `judge.js` / `note.js` / `snapshot.js` / `memoryLog.js` 通读：无 ATTIO 字段引用（grep 确认）。
- **结论**：记忆层零承接（除 interaction 事件若被 emit，其 payload 会被整包存，但 `interaction_index` 无 emit 点被证实）。

### 2.3 决策层（decision：autonomyEngine + decisionRepo）
- `autonomyEngine.js:43-117`：输入仅 `business_tier`（customer×project）、`methodology_conditions`、`precedents`、置信度。
- **不读**任何 ATTIO 字段：`champion_strength`/`relationship_strength`（本可调节自主边界/升级判定）、`funding_raised_usd`/`employee_range`（本可影响 tier）均未接入。
- `decisionRepo.js` 仅把 `trigger_context` 向量化，与 ATTIO 属性无关。
- **结论**：决策层零承接。

### 2.4 智能体上下文层（context：assembler + roleProfiles + scope）
- `assembler.js:22-56`：L1 向量召回（返回 title/payload 整包）、L2 决策、L3 任务、L4 profile/tier。**无按 ATTIO 字段投影的结构化注入**。
- `roleProfiles.js` / `scope.js`：基于 `actor_role` + `business_tier_config`，不涉 ATTIO 字段。
- **结论**：智能体层零结构化承接（字段仅可能经 L1 整包向量"偶然"召回，不可控）。

## 3. 字段级承接矩阵

图例：✅主动消费 / △被动整包（embedding/FTS，无语义）/ —无 / ⚠️设计声称但零实现

| 字段 | 声明 | 知识(词汇) | 记忆 | 决策 | 智能体(结构化) | 备注 |
|---|---|---|---|---|---|---|
| domains | ✅ | — | — | — | — | ⚠️身份解析零实现 |
| funding_raised_usd | ✅ | — | — | — | — | |
| foundation_date | ✅ | — | — | — | — | |
| estimated_arr_usd | ✅ | — | — | — | — | select 漏接词汇 |
| employee_range | ✅ | — | — | — | — | select 漏接词汇 |
| categories | ✅ | — | — | — | — | 复数，漏接（category 单数在内） |
| logo_url | ✅ | — | — | — | — | 纯 UI，无 UI 消费者 |
| linkedin | ✅ | — | — | — | — | |
| twitter | ✅ | — | — | — | — | |
| facebook | ✅ | — | — | — | — | |
| instagram | ✅ | — | — | — | — | |
| angellist | ✅ | — | — | — | — | |
| champion_strength | ✅ | — | — | — | — | 本可调节自主边界 |
| key_contact | ✅ | ✅(受控边) | — | — | — | **唯一主动消费点** |
| job_title | ✅ | — | — | — | — | |
| avatar_url | ✅ | — | — | — | — | 纯 UI |
| primary_location | ✅ | — | — | — | — | 本可进 L1 地理上下文 |
| relationship_strength | ✅ | — | — | — | — | 本可调节升级判定 |
| company | ✅ | — | — | — | — | 冗余引用，无读者 |
| interaction_index | △(maintainer) | — | — | — | — | 有维护器无消费者 |

**统计**：主动承接 1/17（key_contact）；被动整包 17/17（embedding/FTS）；四层结构化承接 0/17（除 key_contact 边属知识层）。

## 4. 根因

1. **11 设计 §4 落地清单只规划了"Schema + 2 机制"**：particleModel 声明、key_contact 钩子、interactionIndex 维护器、schema 注释。**从未定义"字段→四层"的消费契约**。
2. **"写库即构建"被窄化为"整包向量化"**：`hooks.js` 的 embedding/fts 把整个 payload 当黑盒哈希，字段语义在索引阶段即丢失；`vocabulary.js` 又只枚举了 6 个老字段，未随 ATTIO 增量扩表。
3. **四层消费是独立契约，增量设计未补**：知识（词汇登记）、记忆（属性变更事件）、决策（tier/置信度输入）、智能体（实体投影注入）各自需要显式接线，11 设计把它们排除在范围外。
4. **治理缺口**：impl 计划已落地 src/（particleModel/hooks/interactionIndex/tests），但 11 设计仍标"未批准不写实现代码"——实现先行于设计批准，导致承接契约被跳过。

## 5. 系统解决方案（三方案 + 推荐）

### 方案 A — 逐字段显式承接
为每个字段在四层逐一硬编码消费点（如 `champion_strength` 进 autonomyEngine 的 tier 调节、`categories` 加进 ENUM_HINT_FIELDS…）。
- 优点：完整、每个字段有明确归属、易审计。
- 缺点：工作量大；`logo_url`/`avatar_url` 等纯 UI 字段硬塞进决策/记忆是噪声；字段增减需改多文件，违背 ai-* 通用投影思想。

### 方案 B — 分层语义约定 + 通用投影（★推荐）
按语义给每个 ATTIO 字段打 `semanticTag`，由**通用投影器**按 tag 路由到四层，避免逐字段硬编码。
- **字段语义分组**（在 `particleModel.js` 的 `coreAttributes` 上增 `tag`）：
  - `firmographic`：domains / funding_raised_usd / foundation_date / estimated_arr_usd / employee_range / categories
  - `social`：linkedin / twitter / facebook / instagram / angellist / logo_url / avatar_url
  - `relation`：champion_strength / relationship_strength / key_contact / company
  - `interaction`：interaction_index
  - `ui`：logo_url / avatar_url（与 social 交叠，仅 UI 消费）
- **知识层**：`vocabulary.js` 改为按 `tag==='firmographic'` 自动登记词汇（取代硬编码 ENUM_HINT_FIELDS），一次性覆盖 `categories`/`estimated_arr_usd`/`employee_range`；`domains` 实现身份解析（email 域名→account `auto_weak` 边 + `relation_confidence`）。
- **记忆层**：在 `hooks.js` 增 `emitAttributeChange`——重要属性（tag∈firmographic/relation）变更时发 `memory` 域事件，被 `capture.js` 整包承接；firmographics 入"实体快照"记忆。
- **决策层**：**只承接 `relation` 组**——`champion_strength`/`relationship_strength` 映射为自主边界置信度调节因子（关系强→可自主度高、升级阈值放宽），其余字段不进决策避免噪声。
- **智能体层**：`assembler.js` 增 `retrieveEntityProfile(particleId)`，按 tag 投影结构化属性（firmographics + relation + key_contact）注入 L1 上下文；`primary_location` 进 L1 地理维度。
- 优点：符合 ai-* 方法论（写库即构建 / 上下文分层 / 记忆生命周期）；不污染、可扩展、集中在投影器易审计；一次性覆盖 16 字段。
- 缺点：需定义 `semanticTag` 表 + 投影器（一处新增）。

### 方案 C — 保持 Schema-only，仅补关键链路
只补 `key_contact` 已有链路 + `domains` 身份解析（最高 ROI），其余字段保持"声明 + 被动 embedding"，明确标注"UI/阶段 2 承接"。
- 优点：最小改动、最快。
- 缺点：~15 字段长期悬空，记忆/决策/智能体不受益，不符"每个字段都用上"的预期。

### 推荐：方案 B
理由：把"字段→层"映射从硬编码转为语义驱动，契合本项目 10 大 ai-* 的通用投影哲学；四个承接点集中在 `vocabulary.js` / `hooks.js` / `autonomyEngine.js` / `assembler.js` 各加一处投影器，可审计、可扩展、不膨胀。

## 6. 推荐方案 B 落地契约（待批准后细化）

| 层 | 改动文件 | 承接动作 |
|---|---|---|
| 粒子模型 | `particleModel.js` | `coreAttributes` 每项增 `tag`（firmographic/social/relation/interaction/ui） |
| 知识 | `vocabulary.js` | 按 `tag==='firmographic'` 登记词汇；覆盖复数 categories 等 |
| 知识 | `ontology/hooks.js` | 新增 `domains` 身份解析（auto_weak 边 + relation_confidence） |
| 记忆 | `ontology/hooks.js` + `capture.js` | 重要属性变更 emit `memory` 事件 → 整包承接 |
| 决策 | `autonomyEngine.js` | `relation` 组映射为置信度/升级阈值调节因子 |
| 智能体 | `context/assembler.js` | 新增 `retrieveEntityProfile` 按 tag 投影注入 L1 |

## 7. 维度 1/3/2 缺口解决方案（Identity / Semantics / Structure）

基于 §5 推荐方案 B（分层语义约定 + 通用投影），针对审计发现的三个硬缺口给出落地设计契约（仅设计，HARD-GATE 前不写实现）。

### 7.1 维度 1 Identity —— `domains` 身份解析（当前 src/ 零实现）
- **问题**：联系人邮箱域名 → 公司 的跨系统同一对象识别缺失；grep `auto_weak|relation_confidence|identity` 零命中（`particleModel`/`hooks` 无消费点）。
- **承接点**：知识层（ontology 身份解析）+ 粒子图。
- **方案**：
  1. `ontology/hooks.js` 新增 `resolveIdentity(payload)`：从 ACCOUNT `domains` 提取域名，对 CONTACT `email` 后缀匹配，命中对应用 ACCOUNT 时自动建 **`auto_weak` 受控边**（弱关系，区别于人工 `key_contact` 强边）。
  2. 边带 `relation_confidence`（初值 = 域名匹配强度 + `attio_id` 命中），随人工确认升为强边。
  3. `attio_id` 作外部权威键写入粒子 `external_ids` 映射；"两套 attio_id = 一个公司"由 `external_ids` 唯一约束防重复。
- **验收**：① 同域名两 CONTACT 归一到一个 ACCOUNT（存在 auto_weak 边）；② `attio_id` 重复写入被拒；③ 弱边可经人工确认升强。

### 7.2 维度 3 Semantics —— 词汇登记补齐（当前 `categories`/`estimated_arr_usd`/`employee_range` 漏接）
- **问题**：`vocabulary.js:4` `ENUM_HINT_FIELDS` 只含老 6 字段（含单数 `category`），ATTIO 复数 `categories` 与数值枚举 `estimated_arr_usd`/`employee_range` 全漏接 → 语义维度无供给。
- **承接点**：知识层。
- **方案**：
  1. `vocabulary.js` 改为**按 `semanticTag==='firmographic'` 自动登记**（取代硬编码 ENUM_HINT_FIELDS）：firmographic 组的 select/枚举字段，写时自动 `registerVocabulary`（行业/规模/ARR 区间进 L1 KNOWLEDGE）。
  2. `employee_range`/`estimated_arr_usd` 等带量纲字段登记为**有序枚举**（保留大小关系，供语义比较，如"ARR > 阈值"可被决策引用）。
  3. 领域字典校验：`categories`「行业分类」在营销/销售/财务三域含义对齐（呼应 ai-context-layering 七维度 Semantics 补全判据）。
- **验收**：① `categories` 取值进入 L1 词表可被检索；② `employee_range` 作为有序枚举参与条件比较；③ 三域术语一致性校验通过。

### 7.3 维度 2 Structure —— 受控边 + 决策网络（部分就位，补齐关系图谱）
- **问题**：`key_contact` 已建强边（唯一主动消费点），但关系结构不全——决策单元仅 `champion_strength` 一维，`relationship_strength` 未进图；决策网络（REFERENCED_PRECEDENT 多跳）与 ATTIO 实体未打通。
- **承接点**：粒子图（受控边）+ 决策网络。
- **方案**：
  1. `relationship_strength` 与 `champion_strength` 经 `hooks.js` 建**关系强度边**（带 `strength` 属性），构成决策单元子图（champion/用户/阻挡者）。
  2. 在 §6.3 决策网络基础上，ATTIO 实体（ACCOUNT/CONTACT）经 `decided_on`/`references` 边挂接到 DECISION 粒子，使"该客户历史上哪些打法被否决"可多跳回答（补维度 5 的实体侧供给）。
  3. `company`（冗余引用）改造为显式 `belongs_to` 受控边（ACCOUNT←CONTACT），消除"无读者"孤岛。
- **验收**：① 一个 ACCOUNT 的决策单元子图含 champion+用户+阻挡者及其强度；② 从 DECISION 多跳可回溯对应 ACCOUNT/CONTACT；③ CONTACT→ACCOUNT 有 `belongs_to` 边。

## 8. 七维度覆盖模型（CRM 重框版）· 四平面校验标尺

Oleg 七维度（2026-08-16）是**决策上下文"齐全轴"**，与 L1-L4"深度轴"正交（ai-context-layering §4 轮已并入）。经本轮审计与 CRM 语义翻译：**结构 7/7 适用，维度 4/6 需重框为商业语义，不增轴**：

| # | 维度（CRM 重框） | 内容翻译 | 供给源（四平面） | 当前状态 |
|---|---|---|---|---|
| 1 | Identity 身份 | 跨系统同一客户/联系人归一 | 知识层（domains 解析 + auto_weak 边） | ❌ 缺口（§7.1） |
| 2 | Structure 结构 | 账户层级/决策单元关系网 | 粒子图（受控边）+ 决策网络 | △ 部分（§7.3） |
| 3 | Semantics 语义 | MQL/SQL/primary/won 各域含义 | 知识层（词汇登记 + 领域字典） | ❌ 缺口（§7.2） |
| 4 | Time & Lifecycle Stage 时间/生命周期阶段 | 商机阶段(L2C)/单据版本/财期 | 决策事件 effective_from/to + l2c_stage 锚定 | △ 设计就绪 |
| 5 | Decision History 决策历史 | 为何丢单/打折/优先，哪些被否决 | 决策事件主轴（§6.3 REFERENCED_PRECEDENT） | ✅ 已设计 |
| 6 | Operational & Commercial State 运行/商业态 | 健康度/流失/欠款/工单/SLA/折扣空间 | 事件总线 5 域 + crm-risk 常驻 + interaction_index | ✅ 已设计 |
| 7 | Governance 治理 | 折扣授权/合同签署/客户归属/PII 同意 | 自主边界 + RBAC + action-confirm + L4 gates | ✅ 已设计 |

> 把上表作为 `sevenDimensionsCheck()` 跑一遍四平面，会**精确复现本轮审计结论**：ATTIO 16 字段只补维度 1/2/3 的零星供给（且 1/3 还有缺口），**永远过不了维度 5/6/7**——后三者须来自决策事件主轴与事件总线，而非 enrichment 字段。这正是"分层语义投影 + 七维校验"两层模型的正确性证据。

## 9. 七维度在 agent 编排 / SKILL / 闭环 的体现

七维不是存储分区，而是**贯穿编排—技能—闭环的校验标尺**（呼应 ai-context-layering「Context is produced, not retrieved」铁律：缺失维度标 `missing context`，禁止 AI 脑补）。

### 9.1 agent 编排（引擎晶格 §6.13.10）
每个引擎在「产出前」调用 `sevenDimensionsCheck(q)`，按 q 意图路由到对应维度校验；缺失维度触发升级而非幻觉：
- **crm-native（role-engine 唯一常驻）**：持有共享上下文总线，编排起点跑全 7 维预检，把缺失维度注入下游引擎「待补」清单。
- **crm-query（含 linkage/funnel）**：主责维度 1/2/5（Identity 归一、Structure 图可达、Decision History 多跳）。
- **crm-risk（常驻主动探测）**：主责维度 6（Operational & Commercial State），先于提问经 §3.10 SSE 推送。
- **crm-write（action-confirm + HITL）**：主责维度 7（Governance），写前第 0 闸强制 decision_id + 授权校验。
- **输出引擎 FMT**：把 `missing context` 显式呈现（业务语言），不静默降质。

### 9.2 SKILL（CRM 智能体包 §6.13）
七维作为 `crm-*` SKILL 的**共有评估契约**：
- `crm-native/core` 加 `sevenDimensionsCheck` 工具（中性，不绑定具体粒子），各 SKILL 在 `core/evaluate.md` 声明"本技能负责补全哪几维"。
- 方法论 SKILL（`method-bant`/`method-meddicc`…）：在 `rules/` 权重门控引用维度 3（Semantics）领域字典，确保 qualify/win 等术语跨域对齐。
- 与 ai-context-layering 同步：L1-L4 注入深度 + 七维齐全度 **双轴校验**，任一轴缺口进入 `degradedLayers` 供监控消费。

### 9.3 闭环（feedback loop §6.10）
七维覆盖度成为**反馈闭环的北极星指标**：
- 每次决策辅助调用记录 `dimCoverage = {identity, structure, …, governance}`（布尔/置信），喂入反馈回路。
- **缺失维度 → 生成捕获任务**：如维度 5 缺失 → crm-native 触发"挖掘该客户历史互动，补全被否决打法"；维度 6 缺失 → crm-risk 订阅对应事件源。
- 覆盖度 per-tier 进 §6.4「决策质量监控」，与自主率/推翻率并列；长期偏低则收紧该 tier 自主范围（升级 HITL）。
- 与 §6.11 ai-feedback-loop 挂点一致：七维覆盖 = 可观测的"情境完备性"反馈信号。

## 10. 自检与状态
- [x] 每字段承接判定均附 file:line 证据（grep + 通读）
- [x] 区分"被动整包索引"与"主动结构化承接"，不混淆
- [x] 根因指向 11 设计 §4 范围缺口 + 治理缺口（impl 先于批准）
- [x] 三方案含权衡与推荐，推荐方案 B 落地契约可审计
- [x] 维度 1/3/2 缺口已给出方案 B 落地契约（§7）
- [x] 七维覆盖模型已作为四平面校验标尺写入（§8）并嵌入编排/SKILL/闭环（§9）
- [x] 方案 B 已批准；§7/§8/§9 全部落地（writing-plans → Inline Execution，T6-T10 完成）
  - T6 semanticTag 五组 + 词汇按 tag 自动登记（commit 67be6af）
  - T7 domains 身份解析 auto_weak 边 + confirmWeakEdge 升强（commit 67be6af）
  - T8 关系强度边 + firmographic 变更事件（commit 67be6af）
  - T9 决策 relation 组置信度调节（relBoost + 阈值放宽，commit 44f5d12）
  - T10 assembleContext L1 注入 entityProfile 投影（向量传参修正，commit 44f5d12）
  - 测试隔离：attio beforeEach TRUNCATE decision 域（commit 8c8920e），attio-inheritance.test.js 12/12 绿
- [ ] ⚠️ 遗留：`docs/specs/2026-08-25-11-attio-enrichment-design.md` 的多域名跨账户归一（仅单域名匹配）未实现；attio_id 唯一约束依赖 external_ids（T1-T5）
