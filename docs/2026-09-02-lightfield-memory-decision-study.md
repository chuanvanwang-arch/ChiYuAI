# Lightfield 记忆与决策机制研究 + 客户故事线落地方案

> 日期：2026-09-02
> 来源：lightfield.app/blog 原文 8 篇（非转载，逐字引用）
> 关联（2026-09-02 更新）：
> - **`docs/2026-09-02-cognitive-decision-unified-design.md`** —— 本文 C1–C5 已作为重评输入并入该统一设计（五文档合并版 v3），落地顺序以该文档 §11 路线图为准
> - `docs/archive/2026-09-02-kmd-integration-detailed-spec.md`（K-M-D 三层贯通规格，**已归档**）
> 状态：**研究已完成；阶段 A（A1–A4）代码已实施并全量回归通过（344 files / 2424 tests 全绿），但生产库尚未生效**（2026-09-02 复测：`crm.events` 仍 0 行，`crm.memory_log` 无 `entity_id` 列 ⇒ A2 迁移未跑，属生产写操作待授权）；阶段 B/C 为设计，未实施。

---

## §0 执行摘要 — 五条硬结论

| # | 结论 | 对我们的直接判定 |
|---|---|---|
| **C1** | **数据流方向是反的**：raw 轨迹先落 → schema 后贴 → story 派生。不是"先建 schema 再填"。 | 我们的 `meta_attr` 写时自适应登记是**半成品**：能后贴 schema，但**没有 backfill**，而回填的前提是 raw 层一直存在。events 表 **0 行** → 回填能力归零。 |
| **C2** | **图没被弃用，只是换了角色**：图做**寻址**（找到谁对谁说过什么），故事做**推理**（这意味着什么）。 | `edges` 保留；但 `relationship_strength`/`champion_strength` 这类**会变的判断不该用边承载**（见 §2.3 判据表）。 |
| **C3** | **Knowledge / Skill 是可分离的两件**，判据是"给新人讲过三遍 = Skill；每次都要重复讲的公司背景 = Knowledge"。 | 阈值（BANTCC 达标线/21 条合格线）= **Knowledge**（已有载体 `config_store['sales-thresholds']` + `methodology_dimension` 34 行）；决策推进/复盘流程 = **Skill**。两者当前**都未注入决策前链路**。 |
| **C4** | **决策质量靠确定性而非 LLM 自觉**：LLM-only 有三局限（Scale / Determinism / Output fidelity）。 | 我之前判定"九尺子 8 项可零 token 确定性评分"与 C4 同构，**方向正确，必须走代码判定不走 LLM 判定**。 |
| **C5** | **复合效应是可测量的**："Skills run better on month-three data than day-one data." | 这是现成的**反假绿指标**：同一 Skill 在第 1 天与第 3 个月的输出质量差 = 记忆是否真在复合。我们目前无法测量（events 0 行）。 |

**一句话**：Lightfield 的记忆不是"更好的字段"，是把**真相源下沉到原始轨迹**，字段/摘要/看板全部降级为派生视图；决策不是"AI 帮你填表"，是**Knowledge 注入 Skill 后由 Agent 在完整客户记忆上执行**。

---

## §1 记忆：三层结构与"反向数据流"

### 1.1 L0 原始轨迹是唯一真相源

> "Lightfield captures and preserves the raw traces of customer interactions—every email, every call, every meeting—and organizes them into a living system..."
> — *Why we built Lightfield*, Nov 13 2025

> "We deliberately avoid premature abstraction. Summaries, fields, and dashboards are *derived views*—not the source of truth. **Reality comes first. Everything else is computed from it.**"
> — *Why we built Lightfield*, Nov 13 2025

> "The data LLMs need isn't usually captured by traditional systems of record. Schema-first CRMs track what you tell them to track, in the format you specified, at the moment you specified it. They don't capture why a deal moved, what language a champion used to describe their pain, how sentiment shifted over a sequence of conversations..."
> — *Code execution in Lightfield*, Feb 16 2026

**判定**：这是与传统 CRM（含我们项目）最根本的分野。我们 `particles` 71 行、`decision` 12 行，全是**结论型数据**（谁、什么阶段、什么金额），没有一条"客户原话"。按 Lightfield 标准，我们目前是 **Type 2（AI 自动补全但无世界模型）**，甚至 L0 层为空，连 Type 2 都不完整。

### 1.2 L1 schema-less：schema 后贴，且可回填

> "This starts with our 'schema-less' approach, where **ground truth = raw, unstructured customer conversations** that can be accessed via the relationship graph. **The CRM data model with objects and fields is layered on top of that**, making it possible to arbitrarily generate values for it any time. This is particularly useful when you decide you want to start capturing a certain field. **If you've spoken about it in your conversations, it's easy enough to backfill.**"
> — *Code execution in Lightfield*, Feb 16 2026

**这条对我们是当头一棒。** 我们的 `meta_attr` 写时自适应登记（`ensureAdaptiveRegistration`）在形态上就是"schema 后贴"——但缺了后半句：

| 能力 | Lightfield | CRM-ai-native |
|---|---|---|
| 后贴 schema | ✅ | ✅ `ensureAdaptiveRegistration` |
| **回填历史（backfill）** | ✅ 从 raw 轨迹重算 | ❌ **无**。raw 层（events）0 行，无从回填 |
| 前提：raw 常驻 | ✅ 自动捕获全部交互 | ❌ 全仓仅 2 处写 events |

**结论**：我们的"后验本体"是**断根的**——只登记了类型约束，没保留可供回填的原料。一旦登记晚于数据产生，历史永远补不回来。这正是"identity 指纹漂移"类缺陷的深层根因。

### 1.3 L2 故事：派生视图，喂给模型

> "This approach enables Lightfield to present an agent with a **'story' for each relationship, with characters, dynamics, and a trajectory**—derived from events connected across a timeline between entities. It provides a view into how conversations developed across emails and calls, how sentiment may have shifted, who deferred to whom, what promises were made, if they were kept."
> — *Code execution in Lightfield*, Feb 16 2026

**关键形态差异**：故事有**三个构件**——`characters`（人物）/ `dynamics`（互动动态）/ `trajectory`（轨迹）。

对照我们的 `src/context/timelineSource.js` `buildTimelineRows()` 输出：`{ts, type, title, source, actor, entity, summary}` —— 这是**流水账**，不是故事。它有时间线，但没有 characters（谁是谁、什么角色）、没有 dynamics（谁听谁的、承诺是否兑现）、没有 trajectory（方向是变好还是变差）。

### 1.4 四要素（Chronology / Attribution / Causality / State）

> "**Chronology** — what happened and in what order. The full timeline, not a snapshot.
> **Attribution** — who said what, when, and in response to what. The actual words, not someone's summary of them.
> **Causality** — what actions led to which outcomes. The thread that connects a conversation six months ago to a decision today.
> **State** — trust, risk, momentum, intent, and how they change over time. Not just where a relationship is, but how it got there and where it's heading."
> — *Why we built Lightfield*, Nov 13 2025

Attribution 的后半句必须单独强调：**"The actual words, not someone's summary of them."** —— 归因的原料是**原话**，不是摘要。我们的 `memory_log` 38 行全是 `event:*` / `decision:*` 的摘要型条目，**没有一条客户原话**。

State 的后半句同样关键：**"Not just where a relationship is, but how it got there and where it's heading."** —— 这要求**字段值历史**。Lightfield 直到 2026-07-10 才上线：

> "Fields now display historical values in a detail view. This can be accessed from the activity log referencing changes to that field."
> — *Field value history*, Jul 10 2026

我们 `particles.payload` 是 JSONB 覆盖写（`payload || $1::jsonb`，见 `src/particles/interactionIndex.js:38`），**无版本历史**。State 可存不可演化。

---

## §2 为什么故事优于图：可塑性论证

### 2.1 原文论证（三段 verbatim）

> "When we used LLMs with structured graphs, the models **treated the relationships too rigidly**. They'd hold the edges too firmly and lacked understanding of *why* concepts were connected or what the overarching theme was across the data. They were missing the forest for the trees."
> — *LLMs also prefer stories to graphs and databases*, Feb 20 2026

> "Modeling human relationships requires **changing the weights of details to fit the dominant narrative**. Maybe the CISO you were trying to sell to said he had a fixed budget and no time for you, but then you explained you could solve a bigger problem, and his view on budget and urgency changed. **Graphs really got in the way of modeling the malleability of humans.**"
> — 同上

> "In contrast, if you write up all the details about a person and your relationship with them as a story, the best models (e.g., Opus) can **re-weight the importance of details dynamically**. This is true of humans too. Give them the chronology and the narrative and they'll find the global optimum instead of getting stuck in the details."
> — 同上

**核心词是 malleability（可塑性）**：人的立场会变。图里存一条"预算固定"的边，要改它得显式操作；故事里"他说预算固定 → 我们讲了更大的问题 → 他改口了"是自然叙述，模型自己会重加权。

### 2.2 但图没被弃用 —— 两处表述的精确比较

| 出处 | 表述 | 时间 |
|---|---|---|
| *Code execution* | "Lightfield organizes customer data as a **semi-structured business graph**. It's a primitive world model representing a network of people, who work at companies, that have said things to each other across different conversational mediums." | Feb 16 2026 |
| *LLMs prefer stories* | "So last year, we **dumped the classical graph** and started building our data model of people and companies around stories." | Feb 20 2026 |
| *Code execution*（未来约束） | "models will be constrained by two things: (1) efficient and flexible-enough access to sufficient context, and (2) **graph edges and descriptions of relationships that put tables of CRM data in real world terms**." | Feb 16 2026 |

**判定（这是转载普遍漏掉的）**：弃的是 **classical / semantic knowledge graph**（概念间语义关系图），保留的是 **semi-structured business graph**（实体间寻址图）。二者的分工是：

- **图 = 寻址结构（retrieval）**：回答"这些人之间说过什么、在哪说"。
- **故事 = 推理结构（reasoning）**：回答"这意味着什么、接下来该做什么"。

> "when the agent writes code, it operates on Lightfield's full context—the narrative history of each account, extracted structured data, and company knowledge... When a query requires context that hasn't been extracted into structured fields, the agent dispatches sub-agents to query individual accounts, read conversation histories, and interpret tone and intent."
> — *Code execution*, Feb 16 2026

### 2.3 对我们的 `edges` 处置判据（可落地）

现有 `CONTROLLED_PREDICATES` 18 个（`src/particles/particleModel.js:278-287`），生产库 `edges` 20 行分布：`referenced_in` 14 / `belongs_to` 4 / `key_contact` 1 / `has_technical_proposal` 1。

| 谓词 | 性质 | 处置 | 依据 |
|---|---|---|---|
| `belongs_to` / `owned_by` / `part_of` / `member_of` | 结构性、不变 | **保留为边**（寻址） | 关系不会"半信半疑" |
| `referenced_in` / `evidenced_by` / `sourcedFrom` | 引用证据 | **保留为边**（寻址） | 直接服务于"找到原话" |
| `instanceOf` / `governs` | 元模型 | 保留 | — |
| `has_technical_proposal` / `priced_by` / `used_in` | 制品归属 | 保留 | — |
| **`relationship_strength`** | **会变的判断** | **⚠️ 不应作为边承载** | malleability：强度随叙事重加权 |
| **`champion_strength`** | **会变的判断** | **⚠️ 不应作为边承载** | 同上 |
| **`key_contact`** | 半结构半判断 | **降级**：结构归属留边，强度部分进故事 | 现仅 1 行 |
| `temporallyFollows` | 时序 | **由 Chronology 取代** | 时间线是故事的一等公民 |
| `transitionedBecause` | 因果 | **由 Causality 取代** | 因果应进故事叙述 |
| `explains` | 语义 | ⚠️ 这正是"classical graph"被弃的用法 | 并入故事 |

**铁律**：**边只承载"不会随叙事改变"的关系；凡是"可能改口"的判断，一律进故事，由模型动态加权。** 判据一句话——*如果这条边的值会因为一次对话而改变，它就不该是边。*

---

## §3 决策：Knowledge / Skill 双件

### 3.1 定义与判据

> "A Skill is a repeatable workflow you define once and invoke on demand. You describe the task, the steps, and the constraints. The agent handles execution, consistently, every time."
>
> "Knowledge is the structured context layer that Skills draw on when they run. It includes things like your ICP definition, competitive positioning, objection handling, buyer language, and qualification criteria."
>
> "**Skills are for execution.** Use them when the task is repeatable, consistency matters, and you've done it manually enough times to know what good looks like.
> **Knowledge is for context that doesn't change.** Use it when the agent keeps needing the same background, or when output quality depends on company-specific details."
>
> "**A useful test: if you've given the same instructions to a new hire three times, that's a Skill. If you keep re-explaining the same company context before each task, that's Knowledge.**"
> — *How to use Skills & Knowledge*, Apr 14 2026

**这条判据直接解决我们悬而未决的"阈值归属"问题**：

| 我们争论的东西 | 按判据归类 | 现有载体 | 状态 |
|---|---|---|---|
| BANTCC 达标线 / 接触窗口 / 21 条合格线 / TAORAN 分界 | **Knowledge** | `config_store['sales-thresholds']` | ✅ 有，❌ 未注入决策前 |
| `methodology_dimension` 34 行（含 weight + required） | **Knowledge** | `crm.methodology_dimension` | ✅ 有，❌ **零调用点** |
| 7 大决策的推进动作、复盘流程 | **Skill** | `decision_scenario` 12 行 + method-* SKILL | ⚠️ 有场景定义，❌ 未接 Knowledge |
| 销售阶段推进判定 | **Skill**（执行）+ **Knowledge**（判据） | `method-stage-progression` | ⚠️ 阈值硬编码风险 |

### 3.2 三层作用域 —— 我们缺的能力

> "Skills live in three scopes:
> **Workspace skills** are managed by Admins and shared across your team.
> **User skills** are personal to the user who creates them. These are useful for testing or customizing before rolling something out more broadly.
> **System skills** are platform-wide, maintained by Lightfield, and not editable by users."
> — *How to use Skills & Knowledge*, Apr 14 2026

**我们只有一层**（全局 SKILL 注册表）。缺的是 **User → Workspace 的推广路径**：个人先试跑、跑顺了再推到团队。这对"阈值配置化"尤其重要——现在改一个阈值是全局生效，风险集中。

### 3.3 复合效应（可测量）

> "The context graph gets better over time. Every captured interaction — email, meeting, transcript — sharpens Lightfield's understanding of every relationship. **Skills run better on month-three data than day-one data.** The system compounds."
> — *It's time to put your CRM to work for you*, Apr 8 2026

**这是现成的反假绿指标**：定义 `Q(Skill, T)` = 该 Skill 在时刻 T 的输出质量分。**若 Q(T+90d) 不显著优于 Q(T0)，则记忆没有在复合，系统名义上存在、实际空转。** 我们目前无法计算（events 0 行，无轨迹增量）。

---

## §4 决策质量：code execution 补 LLM 三局限

> "Even with deep contextual understanding, LLM-only agents hit inherent limitations:
> **Scale:** Questions that require analysis across hundreds of accounts or thousands of interactions exceed context limits or degrade precision.
> **Determinism:** If you want the same analytical operation to run the same way every week, LLM-only approaches produce slightly different structures and interpretations each time.
> **Output fidelity:** LLMs produce text and simple tables. They don't produce visualizations, structured reports, or finished artifacts you'd put in front of your board."
> — *Code execution*, Feb 16 2026

**映射到我们的九尺子（九大衡量标准）**：

| 尺子 | 判定方式 | 是否需 LLM | 说明 |
|---|---|---|---|
| 准确性 | 代码：假设 evidence_ref 是否命中故事线条目 | ❌ | grounded / contradicted / unsupported 三态确定性判定 |
| 精确性 | 代码：字段是否有量化值 + 单位 + 时点 | ❌ | 正则/类型校验 |
| 相关性 | 代码：`methodology_dimension.required` 覆盖度 | ❌ | 34 行已有 required 标记 |
| 重要性 | 代码：`methodology_dimension.weight` 加权命中 | ❌ | **34 行已带 weight，现成量化信号** |
| 深度 | 代码：`supplied_dims` 命中数 / 7 | ❌ | 现 26 条快照无一达 5/7 |
| 广度 | 代码：七维覆盖数 | ❌ | 同上 |
| 逻辑性 | 代码：八要素依赖图是否有环/断链 | ❌ | 结构校验 |
| 公平性 | 代码：反向证据是否被引用 | ❌ | 检测 contradicted 条目是否进入 rationale |
| 清晰性 | **LLM** | ✅ | 唯一需要语义理解的一项 |

**判定**：九尺子里 **8 项可零 token 确定性评分**，与我上一轮结论一致，且与 Lightfield 的 Determinism 论证同源。**这 8 项必须走代码判定，不能交给 LLM 自觉**——否则同一决策每周跑出不同分，无法做趋势对比，复合效应也就无从测量。

---

## §5 验收清单：五测试

> "**Test 1: The capture test** — How much of what happens with my customers does this system actually know about? ... *Failure mode: A system that knows a call happened for 47 minutes but doesn't know what was discussed.*
> **Test 2: The synthesis test** — Can this system help me understand patterns across my entire customer base? ... *Failure mode: A system that summarizes individual calls brilliantly but can't tell you what customers have been saying about pricing over the last six months.*
> **Test 3: The 'why' test** — When something happens—a deal is won, a customer churns—can this system tell me why? ... *Failure mode: A system where 'Close Reason' is a field a rep fills in from memory a week later.*
> **Test 4: The query test** — Can I ask this system anything, in plain language, and get a useful answer? ... *Failure mode: 'AI search' that's really just better Ctrl+F.*
> **Test 5: The action test** — When this system understands something, can it do something about it? ... *Failure mode: A system that surfaces great insights, then requires you to manually act on them in three other tools.*"
> — *The founder's guide to evaluating an AI CRM*, Jan 23 2026

**我们对着跑一遍（生产库 crm_native 实测，2026-09-02）**：

| 测试 | 判定 | 证据 |
|---|---|---|
| T1 捕获 | ❌ **挂** | `events` 0 行、`tasks` 0 行；全仓仅 `src/ontology/hooks.js:117`、`src/particles/interactionIndex.js:44` 两处写 events |
| T2 综合 | ❌ **挂** | 无 raw 轨迹可综合；`CRM_ACCOUNT` 仅 1 个、`CRM_CONTACT` 仅 1 个，无跨客户模式可言 |
| T3 为何 | ⚠️ **空壳** | `decision.root_cause` 列已加但 0 条数据；`decision_retro_report` 0 行；Close Reason 型字段依赖人工填 |
| T4 查询 | ⚠️ **降级** | `hashVector`（`src/ontology/embedding.js`）是字符指纹非语义向量 → rrfSearch dense 路与 sparse 路信息同源，实质是"更好的 Ctrl+F"（F3） |
| T5 行动 | ⚠️ **部分** | 有 Action 白名单与第 0 闸，但决策前未接 Knowledge/Skill（F1/F4） |

**总分 0.5 / 5。按 Lightfield 自己的三型分类，我们目前是 Type 2 且 L0 为空。**

---

## §6 映射到 CRM-ai-native：现状 × 缺口

### 6.1 实测基线（生产库 `crm_native`，2026-09-02）

| 表 | 行数 | 对应 Lightfield 层 | 判定 |
|---|---|---|---|
| `events` | **0** | L0 raw | ❌ 空 |
| `tasks` | **0** | L0 raw | ❌ 空 |
| `particles` | 71 | L1 结构化层 | ⚠️ 审批域占 45 行；业务实体仅 ACCOUNT 1 / CONTACT 1 / DEAL 5 |
| `edges` | 20 | L1 寻址图 | ⚠️ `referenced_in` 14 条占 70%，结构边合理；强度类谓词 0 条 |
| `memory_log` | 38 | L1/L2 之间 | ⚠️ `topic` 前缀仅 `event:`(32) / `decision:`(6)，**无客户锚点**；layer 全 `L-Workspace` |
| `decision` | 12 | 决策层 | ⚠️ 33 列齐全但 `root_cause`/`feedback`/`outcome_verified` 无数据 |
| `decision_scenario` | 12 | Skill 定义 | ✅ 有 |
| `methodology_template` | 11 | Knowledge | ✅ 有，❌ 零调用点 |
| `methodology_dimension` | **34** | Knowledge（含 weight+required） | ✅ 有，❌ **零调用点**（F2） |
| `decision_rule` / `policy_version` / `assertions` / `calibration_patch` / `decision_retro_report` | **0** | 治理层 | ❌ 全空 |

### 6.2 逐层映射

| Lightfield | CRM-ai-native 现状 | 缺口 |
|---|---|---|
| L0 原始轨迹自动捕获 | events 0 / tasks 0 | **P0 捕获层不存在** |
| L1 schema-less + backfill | `meta_attr` 写时自适应登记（有）/ backfill（无） | **P0 断根** |
| L1 半结构化商业图 | particles 71 + edges 20 | ⚠️ 业务实体过少（ACCOUNT 1） |
| L2 故事 characters/dynamics/trajectory | `timelineSource.buildTimelineRows`（流水账，四源三空） | **P0 缺三构件** |
| Chronology | `timelineSource`（空转） | 需激活 |
| Attribution | `computeAttribution`（退化为 2 类） | 需修；且缺"原话"原料 |
| Causality | `edges` 七类只落 3 类 | 需补；且按 §2.3 应迁出边 |
| State 字段值历史 | `particles.payload` JSONB 覆盖写，**无版本** | **P1 加版本化** |
| Knowledge | `methodology_dimension` 34 行 | **P0 补注入通道** |
| Skill | `decision_scenario` 12 + method-* SKILL | ⚠️ 缺三层作用域 |
| Code execution | 无 | P2 |
| Compounding 测量 | 无 | P1 |

---

## §7 落地方案

> **前提纪律**：以下均为设计，**未写一行实现代码**。按项目铁律，实施需你显式批准。

### 7.1 排序原则：先补原料，再建派生

Lightfield 的全部能力建立在 **L0 raw 常驻** 之上。**顺序反了必然返工**——先做故事渲染，故事里也是空的。

```
阶段 A（补原料）  →  阶段 B（建派生）  →  阶段 C（闭环）
 L0 捕获层激活        L2 故事三构件        Knowledge 注入 + 复合测量
 backfill 通道        Chronology/Attr/Causality 激活
```

### 7.2 阶段 A：L0 捕获层激活（P0）

| # | 动作 | 位置 | 说明 |
|---|---|---|---|
| **A1** | 交互类写操作统一落 `events` | 新增统一写入函数 `recordInteractionEvent()`，收敛现有 2 处（`hooks.js:117`、`interactionIndex.js:44`） | 建立 `domain/type/payload` 三元组规范，payload 必须含 `account_id` + `raw_text` |
| **A2** | 客户锚点标准化 | `src/memory/memoryLog.js` `appendMemory()` | 增加 `entity_id` 列（**走 `db/migrate.js` 独立 ALTER 段，禁止写进 `schema.sql` 的 CREATE TABLE 段**），topic 同时写 `account:<id>` |
| **A3** | 修 `retrieveTimeline` memory 源恒空 | `src/context/timelineSource.js:95` | 现查 `topic='account:<id>'`，库里 topic 全为 `event:*`/`decision:*` → 恒空。改为按 `entity_id` 查询 |
| **A4** | backfill 通道 | 新增 `backfillAttribute({attrKey, since})` | 遍历 `events` raw 文本重算属性值并登记 `meta_attr`。**这是从 Lightfield 学到的新能力，我们目前完全缺失** |

**A1 的验收硬指标**：连续 1 周，每次拜访/电话/会议/报价/合同推进后 `events` 有对应行，`raw_text` 非空。做不到就是假绿。

### 7.3 阶段 B：故事三构件（P0）

`buildTimelineRows()` 输出从流水账升级为故事：

| 构件 | 含义 | 实现 |
|---|---|---|
| **characters** | 谁是谁、什么角色、决策影响力 | 从 `CRM_CONTACT` + `decision_power` + `key_contact` 边聚合 |
| **dynamics** | 谁听谁的、承诺是否兑现、情绪如何变化 | 从 Attribution 原话 + 承诺条目聚合 |
| **trajectory** | 方向（变好/变差/停滞）+ 速率 | 从 State 字段值历史差分 |

每行输出增加 `element_ref`（对应八要素哪一项）与 `dim_ref`（对应 7×7 哪一维），**把流水账变成证据链**——这是上一轮 M3 的内容，在此与三构件合并落地。

### 7.4 阶段 C：Knowledge 注入与复合测量

| # | 动作 | 位置 | 说明 |
|---|---|---|---|
| **C1** | `methodology_dimension` 34 行注入决策前 | 新增注入点，接进 `assembleContextV2({phase:'pre'})` | 与上一轮 F1/F4 修复（消除双轨）**合并做**，顺序：先消除双轨，再注入，否则依据与留痕仍不同源 |
| **C2** | 九尺子确定性评分 | 新增 `rulerScore.js` | 按 §4 表，8 项代码判定、1 项 LLM。结果落 `decision` 新列 |
| **C3** | Skill 三层作用域 | SKILL 注册表加 `scope: system\|workspace\|user` | 支持个人试跑 → 推团队 |
| **C4** | 复合效应测量 | 新增 `Q(Skill, T)` 采样 | 反假绿：90 天窗口内质量分不提升即判空转 |

### 7.5 与上一轮 M1–M5 的关系

| 上一轮 | 本方案 | 变化 |
|---|---|---|
| M1 memory_log 加 entity_id | A2 | 同 |
| M2 写记忆带客户锚点 | A2 | 同 |
| M3 输出 element_ref + dim_ref | B（三构件内） | 合并，并补 characters/dynamics/trajectory |
| M4 assumptions[].evidence_ref | B | 依赖 A3（原话可得） |
| M5 S5 时间线前置到 Pre/In | C1（与消除双轨合并） | 同 |
| — | **A1 捕获层激活** | **新增，且是全部前提** |
| — | **A4 backfill** | **新增，本期从 Lightfield 学到的关键缺口** |

---

## §8 待决问题

| # | 问题 | 我的倾向 |
|---|---|---|
| 1 | 阶段 A 是否先于一切？（我判断是——没原料做不出故事） | **是**，建议照此排 |
| 2 | `relationship_strength` / `champion_strength` 是否按 §2.3 从边迁出到故事？ | **是**，迁出；边只留结构/引用类 |
| 3 | `temporallyFollows` / `transitionedBecause` / `explains` 三个谓词是否废弃？ | 废弃前两个（由 Chronology/Causality 取代），`explains` 观察一期 |
| 4 | `particles.payload` 版本化（State 演化）放 P1 还是 P0？ | **P1**。L0 没补前，版本化只在少量字段上有意义 |
| 5 | backfill（A4）是否本期做？ | **做**，但先只支持 1–2 个关键属性做样本验证 |
| 6 | 上一轮遗留 4 项仍待拍板（7 大决策 focus 初值 / LOSS_REVIEW 是否拆 / 语义 embedding 切换时点 / 后见之明不覆盖原始记忆） | 未变 |

---

## §9 实施记录：阶段 A（2026-09-02 完成）

> 用户批准后实施。全量回归 **344 files / 2424 tests 全绿**（较基线 340/2400 +4 文件 +24 用例，即本轮新增四组测试）。

### 9.1 交付清单

| 动作 | 交付物 | 测试 | 状态 |
|---|---|---|---|
| **A1** | `src/events/recordEvent.js`（新建）：`recordEvent()` + 纯函数 `buildEventPayload`/`isAnchoredPayload` | `test/events-recordEvent.test.js` 7/7 | ✅ |
| **A2** | `memory_log.entity_id` 列 + 索引（schema.sql / migrate.js / seed-test-config 三处同步）；`memoryLog.js` appendMemory + rrfSearch | `test/memory-entity-anchor.test.js` 4/4 | ✅ |
| **A3** | `timelineSource.js` events/tasks/memory 三源锚点修复 + 全局排序内聚 | `test/timeline-anchor.test.js` 6/6 | ✅ |
| **A4** | `src/ontology/backfill.js`（新建）：`mineBackfillCandidates` + `backfillAttribute` | `test/backfill-attribute.test.js` 7/7 | ✅ |

### 9.2 实施中查出的三个连带缺陷（均非原设计已识别）

1. **写入侧与读取侧 payload 形态不一致**：A1 的 `recordEvent` 写 `payload.entity_id`，而 `timelineSource` 的 events 源查 `payload->>'account_id'` → 写入的数据读不到。**教训：锚点键的改造必须写入侧与读取侧在同一次改动内完成，否则等于没改。**
2. **`retrieveTimeline` 只拼接不排序**：返回的是「先 events 再 tasks 再 decision 再 memory」的分组序列，跨源时序乱序。契约不一致导致 `assembler.js:103` 补了 `buildTimelineRows`、`insightService.js:237` 直接用返回值 → **账户洞察页故事线时序错乱**。已把排序内聚进 `retrieveTimeline`（`buildTimelineRows` 幂等）。
3. **假绿测试 `test/memory/rrf.test.js`**：用 `topic='entity:'||id` 建数据验证「按锚点召回」——而生产数据 topic 全为 `event:*`/`decision:*`。**这是"用假约定验证假路径"：在测试库绿、在生产恒空。** 已改为按真实形态建数据，并补「无锚点行不得串入」断言。

### 9.3 反假绿护栏（新增）

- 无锚点事件显式标 `unanchored:true`（不静默丢弃，也不伪造锚点）。
- 保留键（`entity_id`/`raw_text`/`tenant_id` 等）不接受 `extra` 覆盖，防锚点被伪造。
- 回填抽不到值 → **不写 payload，但必须留痕 `skipped`**（否则"回填没生效"与"回填没跑"无法区分）。
- 同一客户同秒多条记忆不得被去重吞掉（去重键须为记录 id，不是客户 id）。
- 落库失败才广播；`recordEvent` 内「先落库成功、后 emit」杜绝幽灵事件。

### 9.4 全链路实证（`tmp/_storyline_e2e.mjs`，测试库真跑）

```
[1] 轨迹落库: ok ok | anchored: true true
[2] 记忆落库: ok | entity_id 已锚定
[3] 故事线取到 3 条  →  2026-09-02 03:06 event｜alice｜客户电话：安全优先
                        2026-09-02 03:06 event｜bob｜复盘会：先做 POC
                        2026-09-02 03:06 记忆｜system｜客户安全诉求优先于预算
[4] 回填: applied=1，粒子 payload.champion = 王总
    留痕: {"result":"applied","attr_key":"champion",
           "evidence":"复盘会：客户同意先做 POC，决策权仍归王总","from_event_id":"2d…"}
```

四步真串通（非各自单测绿）：`recordEvent` → `appendMemory` → `retrieveTimeline` → `backfillAttribute`。

### 9.5 待用户处置（AI 未擅自执行）

| # | 事项 | 说明 |
|---|---|---|
| 1 | **生产库补列** | `PGDATABASE=crm_native node db/migrate.js`（幂等，`ADD COLUMN IF NOT EXISTS` 安全，但属生产写操作，需你授权） |
| 2 | **重启生产服务** | 3000 端口跑的是旧代码，不重启则 A1 的 events 写入在生产不产生数据（`crm.events` 仍将保持 0 行） |
| 3 | **本地提交** | 沙箱无私有库凭证，需你按功能线提交（勿 `git add -A`） |

### 9.6 下一步（阶段 B / C，未实施）

- **B**：故事三构件 `characters` / `dynamics` / `trajectory` + `element_ref` / `dim_ref`（合并原 M3）。
- **C**：Knowledge 注入（**须与消除双轨 F4 合并做**）+ 九尺子确定性评分 + Skill 三层作用域 + `Q(Skill,T)` 复合测量。

---

## §10 实施记录：F4 消除双轨（2026-09-02 完成）

> 阶段 A 之后用户「继续」。选 F4 优先于阶段 B 的理由：**它是唯一不依赖数据补齐就能证明"记忆+知识真在驱动决策"的改动**；B 依赖 A 的原料积累。

### 10.1 缺陷精确描述（file:line 证据）

`autonomyEngine.js` 与 `decisionRepo.js` 各跑一套先例检索，三处参数全不同源：

| | 引擎侧（事前） | 快照侧（事后） |
|---|---|---|
| 位置 | `autonomyEngine.js:86` | `assembleContextV2.js` S2（经 `decisionRepo.js` 旧 :107 调用） |
| 时机 | 决策落库**之前** | `INSERT INTO decision` **之后**（旧 `decisionRepo.js:107`） |
| k | `opts.k \|\| 5` | `3` |
| minSimilarity | `0` | `0.6` |
| 查询向量 | `hashVector({scenario_id, ctx(去 relations), cond})` | `buildDecisionEmbedding({cond: []})` ← **conditions 恒空** |

后果链：引擎用 A 批先例算置信度并决定自主/升级；落库快照归档的是 B 批。
→ **快照是"事后解释"，不是"事前驱动"**。
→ 更糟的是 Q1/Q4 判据（`auditability.computeAudit4q`）读的就是这份快照，等于**问责建立在另一批证据上**。
→ 与 Lightfield C1（"Reality comes first. Everything else is computed from it."）直接冲突：我们的 reality（引擎实际看到的上下文）没有成为唯一事实源。

实测双轨漂移（新增测试红灯时的输出）：同一决策，事前装配 `supplied_dims=3`、事后装配 `supplied_dims=4`——**两条链路给出的供给结论都不一样**。

### 10.2 改法：不是把 Post 挪到 Pre，而是拆成「装配 / 冻结」两阶段

关键设计（易踩错，若只把 Post 挪到 Pre，会留下"决策落库失败但快照已写"的孤儿快照）：

```
① 装配（persist:false）  ← INSERT 之前，decision_id 尚不存在，不落库、不写 PROV-O
② INSERT INTO decision
③ 冻结（freeze）          ← 落快照（带真 decision_id）+ 回指 + S7 操作级 PROV-O
```

`assembleContextV2` 新增四个**可选**输入契约（存量调用方零修改）：

| 参数 | 语义 |
|---|---|
| `persist:false` | 只装配不落库；返回完整装配结果，落库与 PROV-O 延后到冻结 |
| `pre_context` | 冻结模式：**逐字复用**事前装配的 ops/dim_coverage/prompt_block/prompt_hash，**不执行任何 retriever** |
| `phase` | `'pre'`（默认，事前驱动）/ `'post'`（事前装配失败退回时**诚实标注**，绝不冒充） |
| `precedents` | 引擎事前算出的先例集合；S2 检测到即直接复用，**不再二次检索**（双轨根治点） |

`createDecision` 三条路径：

1. 传入 `pre_context`（引擎路径）→ 只冻结，零检索；
2. 未传（存量调用方）→ 在 INSERT **之前**自动补跑 `assembleContextV2({phase:'pre', persist:false})`，INSERT 后冻结；
3. 事前装配抛错 → 退回事后装配，但 `phase` 标 `'post'`（否则"事后解释"会被当成"事前驱动"——那正是本轮要根治的假象）。

失败一律 `fail-open + emit trace + recordFailure`（不静默、不阻断决策本身）。

### 10.3 交付清单

| 交付物 | 改动 | 测试 |
|---|---|---|
| `src/context/assembleContextV2.js` | 新增 `freezePreContext()` 导出 + `persist`/`pre_context`/`phase`/`precedents` 四契约；S2 支持先例复用（补 `decision_id` + `source`） | `test/context/assembleContextV2.test.js` 17/17 保持绿 |
| `src/decision/decisionRepo.js` | `pre_context` 入参；装配前移到 INSERT 之前；落库段语义改为冻结 | — |
| `src/decision/autonomyEngine.js` | ③b 事前装配，**把同一批 `precedents` 注入 S2**；自主/升级两条分支均传 `pre_context` | — |
| `db/schema.sql` / `db/migrate.js` / `scripts/seed-test-config.mjs` | `decision_context_snapshot.phase` 列（三处同步，独立 ALTER 段） | 幂等 |
| `src/context/snapshotStore.js` | `getDecisionContextSnapshot` SELECT 补 `phase` | — |
| **新增测试** | `test/decision/single-track-context.test.js`（7）、`test/decision/pre-assembly-order.test.js`（3） | 10/10 |

### 10.4 测试设计要点（三条红线，回潮即红）

1. **恒等断言**：快照 S2 的 `items[].decision_id` 集合 ≡ `requireDecision` 返回的 `precedents[].decision_id` 集合 ≡ 决策行 `referenced_precedents[].precedent_id` 集合。双轨时三处必不等。
2. **调用序断言**（`pre-assembly-order.test.js`，用 `vi.mock` 包裹真实实现记录调用序列）：`createDecision` 的**第一次**装配调用 `input.decision_id` 必为空 —— 这是"装配真的发生在 INSERT 之前"的唯一决定性证据；若有人把装配退回 INSERT 之后，该断言立刻红。
3. **不漂移断言**：冻结快照的 `assembly_id` / `prompt_hash` / `supplied_dims` 必须与事前装配逐字一致（重检索必漂移，实测 4 vs 3）。

### 10.5 真接线实证与全量回归

**实证**（`tmp/_f4_single_track_probe.mjs`，测试库真跑 `requireDecision` 全链路，非 mock）：

```
场景: LEAD_FOLLOW_UP
[1] 引擎判定: escalated | 置信度 0.154 | tier LEAD
[2] 引擎算置信度用的先例: 2 条 [05241826-…, e1111111-…]
[3] 决策行 referenced_precedents: 2 条 [05241826-…, e1111111-…]
[4] 快照: phase=pre | supplied_dims=3 | assembly_id=d37ab9f9-…
    快照 S2 归档先例: 2 条 [05241826-…, e1111111-…]
    回指 context_snapshot_id: ✓ 一致
[5] 恒等判定（双轨时必不等）:
    引擎 ≡ 快照 : ✓
    引擎 ≡ 决策行: ✓
    phase=pre   : ✓ 事前驱动
```

这是「记忆真在驱动决策」的决定性证据：**引擎拿来算 0.154 置信度的那 2 条先例，和归档进快照供事后问责的那 2 条先例，是同一批**。改造前这两批不同源（k=5/minSim=0 vs k=3/minSim=0.6，实测 `supplied_dims` 4 vs 3）。

**回归**：

| 轮次 | 结果 | 处置 |
|---|---|---|
| 第 1 轮 | `346 files / 2434 tests`，**1 失败**：`test/decision-gate.test.js > autoDecision Action（crm-deal-advance）自动 mint decision` | 见下方排查链 |
| 单独复跑该文件 | `4/4 全绿` | 命中「单独跑绿、批量跑红」形态 |
| 第 2 轮（复位后重跑全量） | **`346 files / 2434 tests` 全绿** | 未复现 → 判定偶发残留态串扰，非 F4 真回归 |

基线对比：F4 前 `344 files / 2424 tests` → F4 后 `346 / 2434`（+2 文件 +10 用例，与新增测试数吻合）。

**排查链（未直接归为串扰，逐一排除后才下判定）**——这条用例正落在 F4 改动路径上（`crm-deal-advance` 是 `autoDecision` → `requireDecision` → `createDecision`），所以不能默认无罪：

| 假设 | 验证 | 结论 |
|---|---|---|
| 闸阈值被污染（`gate.s1_s2_min_need_facts` 被改大） | 查 `config_store['sales-thresholds']` = `2`，用例给足 3 项 needs；且路由层 `max:1..3` 封顶 | ✗ 排除 |
| 元模型污染（`needs` 被登记成 `text` → 对象归一成字符串 → 闸判 `filled=0`） | 查 `crm.meta_attr`：`CRM_DEAL` 仅 7 键、`required=true` 只有 `name`，`needs` 未登记 | ✗ 排除 |
| 我新增的两个测试文件污染了 `decision_scenario` / 守卫配置 | 两文件对 `decision_scenario` **只读**（`SELECT ... LIMIT 1`），无任何 INSERT/UPDATE | ✗ 排除 |
| F4 增加了装配成本 → 连接池耗尽 | retriever 调用次数**未变**（原 post 装配 1 次 → 现 pre 装配 1 次；freeze 不跑 retriever），落库次数亦未变 | ✗ 排除 |
| 偶发残留态串扰（`intercept.blocked` 抛 missing_context 经 `executor.js:167` catch-all 转 `ok:false`） | 复位后重跑全量未复现 | ✓ 判定 |

**顺手修掉的可诊断性缺陷**：原断言是裸 `expect(r.ok).toBe(true)`，而 `dispatch` 有 **8 个闸失败出口**（`executor.js:30/42/54/65/73/80/87/104`）+ **1 个 catch-all**（`:167`），失败时只报 `expected false to be true`，**无法区分"哪道闸拦的"与"异常抛的"**——这正是让串扰难以定位的直接原因。已改为把 `gate` / `error` 打进断言消息：

```js
expect(r.ok, `dispatch 失败 → gate=${r.gate || '(无，即 catch-all 异常)'} error=${r.error || ''}`).toBe(true);
```

> **可复用判据（已并入项目铁律）**：断言一个"多出口函数"的成功态时，必须把出口标识（gate/code/error）带进断言消息。否则偶发失败只留下一个布尔值，排查成本从「读一行日志」升级为「逐个假设验证」——本次为此花了 5 次查库。

### 10.6 待用户处置（AI 未擅自执行）

| # | 事项 | 说明 |
|---|---|---|
| 1 | **生产库补列** | `PGDATABASE=crm_native node db/migrate.js`（新增 `decision_context_snapshot.phase`，幂等；连同 §9.5 的 `memory_log.entity_id` 一并补） |
| 2 | **重启生产服务** | 3000 端口跑旧代码，不重启则 F4 与 A1 在生产均不生效 |
| 3 | **本地提交** | 建议功能线：① A1–A4（阶段 A）② F4 消除双轨。勿 `git add -A` |

### 10.7 下一步（阶段 C 剩余，未实施）

- **Knowledge 注入**：`methodology_dimension`（34 行、已带 weight）接进 Pre 装配——**现在 F4 打通后才有意义的落点**（此前注入到事后快照等于没注入）。
- **九尺子确定性评分**：8 项走代码判定（零 token），仅「清晰性」需 LLM；「重要性」可直吃 `methodology_dimension.weight`。
- **Skill 三层作用域** System / Workspace / User + `Q(Skill,T)` 复合测量（90 天窗口不提升即判空转）。

---

## §11 阶段 C 前置发现：F5 方法论证据双端悬空（P0，待拍板）

> **前提修正**：上一轮把这条缺陷记作 F2「`methodology_dimension` 34 行零调用点」。**该论断方向错了。**
> `autonomyEngine.js:38` 的 `buildConditions` **一直在读**这张表（`SELECT * FROM methodology_dimension WHERE methodology_id=$1`）。
> 真实缺陷比「零调用点」严重得多，且性质相反 —— **不是没接线，是接了线但两端都悬空，导致方法论从"加分项"变成"恒定惩罚项"。**

### 11.1 缺陷精确描述（file:line 证据）

**① 输入端悬空** —— `buildConditions` 从 `trigger_context.conditions` 取业务值（`autonomyEngine.js:41`）：

```js
const supplied = (scenario.trigger_context || {}).conditions || {};
return dims.map((d) => {
  const met = supplied[d.dim_key];
  return { cond: d.dim_key, label: d.label, weight: d.weight, met: met == null ? null : Boolean(met), value: met ?? null };
});
```

而**全部 7 个业务调用点没有一个传 `conditions`**：

| 调用点 | 场景 | 传入的 trigger_context 键 | 含 conditions？ |
|---|---|---|---|
| `seed-actions.js:560` | `STAGE_SCENARIO[to_stage]` | customer/project/stage/deal_id | ✗ |
| `seed-actions.js:647` | `LEAD_FOLLOW_UP` | action/deal_id/owner_id/pool | ✗ |
| `seed-actions.js:686` | `LEAD_FOLLOW_UP` | action/deal_id/reason | ✗ |
| `seed-actions.js:733` | `OPP_QUALIFY` | customer/project/artifact/deal_id | ✗ |
| `seed-actions.js:1038` | `LOSS_REVIEW` | action/deal_id/from/to/reason | ✗ |
| `connectorActions.js:28` / `:62` | connector 写通道 | — | ✗ |

**② 数据端无源** —— 即便调用方想传，系统里**没有任何字段承载方法论维度**：

- 生产库 `CRM_DEAL` payload 实际只有 8 键：`name / stage / expected_amount / probability / account_id / owner / stage_changed_at / ai`
- 生产库 `crm.meta_attr` **0 行**（无任何属性登记）
- 而场景绑定的方法论共 **14 维**（`LEAD_FOLLOW_UP` = BANT 4 + MEDDICC 7 + OPP_MATRIX 3），维度键如 `A/B/N/T`（权限/预算/需求/时间线）、`M/E/D1/D2/I/C1/C2`（指标/经济买家/决策标准/决策流程/识破痛苦/冠军/竞争）**全部无字段对应**

**③ 后果：方法论 = 恒定惩罚 → 自主路径结构性锁死**

`met` 全 null 时（`autonomyEngine.js:48-53`、`:84`）：

```js
const earned = conditions.reduce((s, c) => s + (c.weight || 1) * (c.met ? 1 : 0), 0);  // met=null → 恒 0
const allMet = conditions.length ? conditions.every((c) => c.met) : true;              // null 不为真 → 恒 false
```

→ `methodScore = 0`、`allMet = false` → 置信度只剩 similarity + coverage 两项：

```
conf ≤ w.similarity + w.coverage = 0.4 + 0.3 = 0.70  <  threshold（出厂 0.8 / 测试库校准 0.91）
```

**倒挂结论：绑了方法论的场景，天花板 0.70 永远够不到阈值 → 100% 升级人工；反而"未绑方法论"的场景（conditions=[] → methodScore 走 `return 1.0` 短路）能拿满分自主。** 越有方法论支撑越不可自主。

### 11.2 A/B 真接线实证（`tmp/_probe_conditions_gate.mjs`，测试库 `crm_native_test`）

```
引擎配置: threshold=0.91 weights={"similarity":0.4,"coverage":0.3,"method":0.5,"allMet":0.1}
场景 LEAD_FOLLOW_UP 绑定方法论: [BANT, MEDDICC, OPP_MATRIX] 共 14 维

[A 组｜现状 = 不传 conditions]
  mode=escalated | confidence=0.140 | tier=LEAD | 先例 2 条
  conditions: 14 维, met=null 14 维 (100%)

[B 组｜填满 conditions = met 全 true]
  mode=escalated | confidence=0.736 | tier=LEAD | 先例 2 条
  conditions: 14 维, met=true 14 维, met=null 0 维

[判定]
  Δconfidence = 0.596（B - A）
  A 组理论天花板 = w.similarity + w.coverage = 0.70（method/allMet 两项恒 0）
  阈值 = 0.91 → A 组天花板 < 阈值：结构性永不自主 ✗
  A 组 conditions 全 null: 是 ✗（输入端悬空已确认）
  假设 H 成立 —— 绑方法论的场景被恒定扣 0.60 分，天花板 0.70 < 阈值 0.91
```

**衍生危害（不止于"不能自主"）**：`conditions_evaluated` 落库的是 14 条 `met:null` 的**假评估记录**，而 `calibration/replay.js:18-21` 会把它当真样本重放算 `methodScore/allMet` → 决策质量校准的输入本身是污染的。

### 11.3 待拍板：两个强耦合决策

#### Q1 — 方法论证据从哪来？（数据端）

| 方案 | 做法 | 权衡 |
|---|---|---|
| **A. 粒子字段扩展** | 给 `CRM_DEAL` 加 14 个维度字段 | 直接，但 payload 膨胀；换方法论就要改 schema；违反「方法论可配置」 |
| **B. 独立证据粒子** | 新增 `CRM_METHODOLOGY_EVIDENCE`，一行一维证据，带 `dim_key/met/value/source/evidence_ref/asserted_at` | 方法论增删不动 schema；天然可审计（"为什么判 B 达标"有出处）；零 DELETE 友好（新版本追加） |
| **C. 记忆层语义提取** | 跟进记录/纪要/邮件 → 抽取维度证据，不落结构化 | 无需新表；但每次决策都要重算，且无法人工纠偏 |
| **D. B + C 组合（推荐）** | B 承载结构化落地与人工纠偏，C 作自动填充器写入 B | 采集自动化 + 可纠偏 + 可审计；代价是两个模块 |

#### Q2 — 证据缺失（`met=null`）怎么算分？（语义端）

| 选项 | 语义 | 后果 |
|---|---|---|
| **① 现状** | null 计 0，与"采集到但不达标"同罚 | 惩罚未知 → 天花板 0.70，锁死（当前缺陷态） |
| **② 覆盖率/达标率分离（推荐）** | 分母只含已采集维度算**达标率**；另设**证据覆盖率**独立进置信度 | "未知"与"不达标"解耦；覆盖率低仍会升级（不会瞎自主），但采集齐全后能真自主 |
| **③ 保持惩罚 + 诚实升级** | null 仍计 0，但把"证据缺齐"写成显式 HITL 理由 | 最保守；引擎照旧不能自主，只是理由变诚实 |
| **④ 判为特性不修** | 认定"绑方法论的场景本就该人工把关" | 若采纳，F5 不是缺陷，阶段 C 方向须整体重定 |

**AI 推荐：Q1=D、Q2=②。** 理由：② 正是九尺子里「完整性」与「达标/重要性」分离的思想 —— 让引擎诚实地说"我只看到 3 维证据、其中 3 维达标、覆盖率 21%"，而不是谎报"14 维里 3 维达标"。覆盖率独立进权重，保证"证据没采齐 → 照旧升级"，不会引入瞎自主。

### 11.4 未拍板前不动的边界

- 未改任何 `src/` 实现代码（HARD-GATE：架构级语义变更须批准）
- 已产出物仅：本节文档 + 两个只读/测试库探针（`tmp/_probe_cond_ceiling.mjs`、`tmp/_probe_conditions_gate.mjs`）
- 探针在测试库产生的 2 条决策行已打标 `feedback.probe='cond-gate'`（零 DELETE 铁律，未物理删）

---

## 附：本轮引用的原文清单

| 标题 | 日期 | 主要贡献 |
|---|---|---|
| Why we built Lightfield | 2025-11-13 | 四要素定义；derived views 铁律；三阶段批判 |
| LLMs also prefer stories to graphs and databases | 2026-02-20 | malleability 论证；弃 classical graph |
| Code execution in Lightfield | 2026-02-16 | schema-less + backfill；故事三构件；LLM 三局限 |
| The founder's guide to evaluating an AI CRM | 2026-01-23 | 三型分类；五测试验收清单 |
| How to use Skills & Knowledge | 2026-04-14 | Skill/Knowledge 判据；三层作用域 |
| It's time to put your CRM to work for you | 2026-04-08 | Skill 库形态；复合效应 |
| Field value history | 2026-07-10 | 字段值历史（State 演化） |
| The dissolution of integrations and data moats | 2026-01-28 | MCP 化；迁移成本归零 |
