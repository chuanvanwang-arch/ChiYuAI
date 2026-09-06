# 三系统 × Semantica 4 阶段 · 可追溯架构设计

> 日期：2026-09-01  
> 类型：顶层架构 §2（最高层枢纽设计，不实施，仅梳理）  
> 输入：① 你给的 Semantica 官方架构图（Ingestion / Processing / Intelligence / Application 四列）；② `docs/2026-09-01-top-architecture-three-systems.md`（三系统划分）；③ `docs/2026-09-01-story-graph-fusion-design.md`（故事线 + 三段式束）；④ `docs/2026-09-01-bug-verdict-and-tetrad-7dims-7edges-mapping.md`（四元组/七维/七边关系）。  
> 目的：把"知识系统 / 记忆系统 / 决策系统"和"L1–L4 消费深度"全部挂到 Semantica 4 阶段上，**每一条具体对象（事实/记忆/决策）都能沿这条轴一追到底**。  
> 非目标：不重新设计 10 大 ai-* SKILL 基线、不新增系统/子系统、不移除任何既有术语。

---

## §0 致歉与方法（"你有点晕了"的回应）

用户反馈"六轴模型，又发明了一个新词"，确实如此——三个原因导致术语过载：

1. **"六轴"这个名字不对**。WHAT/HOW/WHO/BECAUSE/WHEN/THEN 不是 6 条平行轴，是"上下文装配件的 6 类语义内容"。**回退方案**：本设计统称它们为 **"上下文块（context block）的 6 类语义"**，不再单立"六轴"术语。
2. **WHERE 被我漏了**。WHERE 与 WHEN 不在一个维度层——**WHEN 属 Intelligence 阶段**（被装配的时间序），**WHERE 属 Application 阶段**（消费路由：装配到哪个 L 层级 / 哪个场景 / 哪个租户）。两者不并列。
3. **四元组 / 七维 / 七边 / L1–L4 都被我并列摆放 = 看起来像新概念**。其实它们是 4 套既有术语，本设计统一把它们钉到 Semantica 4 阶段的某个或某几个阶段上（见 §4），**不发明新词，只做归属**。

**新枢纽**：Semantica 4 阶段（Ingestion / Processing / Intelligence / Application）是**数据生命周期**，不是新系统。它把"三系统纵切 + L1–L4 消费横切 + 方法论 SKILL 横切"四个维度**统一为一张可追溯表**——任何具体对象都能在这张表上找到 4 个格子的位置 + PROV-O 链接。

---

## §1 Semantica 4 阶段 × 三系统 × L1–L4：正交三维（顶层架构）

### §1.1 顶层 3D 矩阵（一图四维）

```
                            ┌──────────────────────────────────────────────────────┐
                            │        方法论层（10 大 ai-* SKILL · 治理规范）         │
                            │        —— 横切所有阶段与系统 ——                          │
                            └──────────────────────────────────────────────────────┘
                                                          ↑
                              ┌───────────────────────────┴──────────────────────────────┐
                              │  Application（消费输出）                                    │
                              │  · 输出 1：GraphRAG Agent（`agentLoop.js` 调用 SKILL）        │
                              │  · 输出 2：Decision Tracking（监控 + 复盘）                    │
                              │  · 输出 3：Context Bundle（装配产物，L1–L4 注入 prompt）     │
                              │  · 输出 4：Explorer & Export（含 PROV-O 追溯可视化）           │
                              │  —— 内部 WHERE 轴：装配路由 (L1–L4 + 场景 + 租户 + 角色) ——      │
                              └──────────────────────────────────────────────────────────┘
                                              ↑      ↓
                              ┌──────────────────────────────────────────────────────────┐
                              │  Intelligence（沉淀）                                       │
                              │  ┌──────────┐   ┌──────────┐   ┌──────────┐              │
                              │  │ 知识系统   │   │ 记忆系统   │   │ 决策系统   │              │
                              │  │ particles │   │ memoryLog │   │ decision  │              │
                              │  │ ontology  │   │ events    │   │ relation  │              │
                              │  │ blueprint │   │ curated   │   │ outcome   │              │
                              │  │ config    │   │ note      │   │ confidence│              │
                              │  │           │   │           │   │ provenance│              │
                              │  └──────────┘   └──────────┘   └──────────┘              │
                              │  —— 内部 WHEN 轴：纵深时间线 + 决策边偏序 ——                       │
                              └──────────────────────────────────────────────────────────┘
                                              ↑      ↓
                              ┌──────────────────────────────────────────────────────────┐
                              │  Processing（处理）                                         │
                              │  · 解析（capture.js）    · 归一化（judge.js）              │
                              │  · 关系抽取（ontology/hooks） · 冲突检测（pipeline/conflict）│
                              │  · 实体合并（pipeline/merge）· 向量化（ontology/embedding）│
                              │  —— 内部校验：受控谓词边 + 本体闭环 + 七维齐全性（Oleg 七维）——   │
                              └──────────────────────────────────────────────────────────┘
                                              ↑      ↓
                              ┌──────────────────────────────────────────────────────────┐
                              │  Ingestion（接入）                                         │
                              │  · action/registry.js（SKILL 触发的事件）                   │
                              │  · connectors/*（外部系统接入：tender / SAP / 微信……）     │
                              │  · 用户行为事件（visit_notes / proposals / orders）          │
                              │  · 智能体自动行为（agentLoop / scheduler 派发）            │
                              │  —— 所有写操作的源头 ——                                       │
                              └──────────────────────────────────────────────────────────┘
```

### §1.2 三维的定义（一句话一个）

| 维度 | 出处 | 一句话定义 | 不属于什么 |
|---|---|---|---|
| **阶段维** | Semantica 图（你贴的） | 数据从源头到消费的 4 个生命周期 | 不属于系统，仅描述"对象经过的阶段" |
| **对象维** | 三系统划分 | 按"性质 = 客观事实 / 事件叙事 / 主观判断"纵切 | 不属于阶段，仅描述"对象属于哪个系统" |
| **消费维** | ai-context-layering SKILL | 按"知识底座 / 历史决策 / 执行协同 / 治理决策"横切 | 不属于任何单一对象，仅描述"消费深度" |

**三维正交 = 任何对象都可用 (阶段, 系统, 消费层) 三元组定位**，可追溯性由此而来。

### §1.3 不重新设计的部分（已固定）

- **10 大 ai-* SKILL** = 方法论层，横切三维全部（合规与边界由 SKILL 校验）
- **Lightfield 四元组 / Oleg 七维 / 七决策边** = 在三维上的归属（见 §4），不新增术语
- **三段式上下文束**（`story-graph-fusion-design.md` §2）= Application 阶段的产物形状，不变
- **L1–L4 消费深度** = Application 阶段的内部 WHERE 轴，不变

---

## §2 三系统的精确定义（接续 top-architecture §3.2，去重与收敛）

> 这一节是 `top-architecture-three-systems.md` §3.2 的**收敛版**——把"7 个抽屉 / 24 个模块"压到一句话一个的本质。

| 系统 | 一句话本质 | 在 Intelligence 阶段的具体沉淀 | 在 Processing 阶段的具体加工 | 在 Application 阶段的消费出口 |
|---|---|---|---|---|
| **知识系统** Knowledge System | "**跨实体可复用的客观事实与规则**" | `crm.particles`（24 类，含 CRM_ACCOUNT/CONTRACT/DEAL/SKILL/KNOWLEDGE 等）+ `crm.edges`（受控谓词边）+ `config_store` + `crm.skill_registry` + `crm.meta_attr` | 受控谓词校验（`vocabulary.js`）+ 归一化（`normalizeFacts.js`）+ 冲突合并（`pipeline/conflict.js`，新增） | L1 知识底座 + L3 执行协同 |
| **记忆系统** Memory System | "**绑定实体、有时效、可蒸馏的上下文叙事**" | `crm.events`（纯事件流）+ `src/memory/memoryLog.js`（append-only 日志）+ `src/memory/note.js`（curated 笔记，带 `superseded_by`） | 归类（`judge.js`）+ 蒸馏（`snapshot.js`，30 天）+ 实体绑定（`capture.js`） | L1 实体画像 + L2 历史叙事（WHEN 轴的源） |
| **决策系统** Decision System | "**有主语、有证据链、可问责的判断事件**" | `crm.decision`（31 列）+ `crm.decision_relation`（7 类边）+ `crm.decision_outcome`（事后产物）+ `crm.confidence` + `crm.provenance`（PROV-O）+ `crm.root_cause`（根因） | 第 0 闸（`disposition.js`）+ 冲突检测（`pipeline/conflict.js` 重点拦截决策并行）+ 关系抽取（`ageGraph.js`） | L2 历史决策 + L4 治理决策 |

**核心收敛（回应"晕"）**：三系统之间**没有共享对象**——粒子归知识系统、叙事归记忆系统、判断归决策系统。灰色地带在 §5 用判定三问消除。

---

## §3 三条可追溯示例（**每条都一追到底**，file:line 证据）

> 每条示例给出 **Ingestion → Processing → Intelligence → Application** 4 个阶段的完整链路 + PROV-O 字段。沿这条链路，**任意一个落库对象都能反向追到它从哪儿来**。

### §3.1 示例 1：客户实体（事实）—— 知识系统

**情境**：`sales` 角色登录 portal，在客户管理页录入"中科曙光"作为 CRM_ACCOUNT。

| 阶段 | 具体动作 | 代码/file:line 证据 | 沉淀对象 | PROV-O 字段 |
|---|---|---|---|---|
| **Ingestion** | 用户表单提交 → `POST /api/crm/customers` | `src/http/routes.js`（routes 段，含 `customers` 入口） | `req.body` 原始负载（无 PROV-O） | — |
| **Processing** | ① 字段校验 → `normalizeFacts.js` 归一化（地址/简称/官网等）→ `pipeline/conflict.js` 检测相同 `stable_key` 已存在 → `vocabulary.js` 本体闭合（路径值必须 KNOWLEDGE 类已登记）→ 失败回滚 | `src/portal/customers.js` → `src/ontology/normalizeFacts.js` → `src/pipeline/conflict.js`（新增）→ `src/ontology/vocabulary.js` | 校验后的归一事实（待入库） | request_id（来自 HTTP）+ user_id（来自 JWT）+ rule_id（每条检查规则） |
| **Intelligence** | 写入知识系统：`crm.particles`（type=`CRM_ACCOUNT`，stable_key=`crm:account:中科曙光`）+ `crm.edges`（与同公司其他账号关联边）+ `crm.meta_attr`（逐字段来源/置信度登记） | `src/knowledge/particleModel.js` → `pg.Pool.query('INSERT INTO crm.particles...')` | 知识系统沉淀物 | `created_by` + `created_at` + `source_request_id`（需新增字段，见 §6） |
| **Application** | ① L1 知识底座：被 `src/context/assembler.js:41 retrieveL1` 取回（向量+精确 name 检索 `crm.particles`）→ ② `config_store['context-routing'].scene_matrix` 决定哪些场景装配 → ③ L3 蓝图也可能消费（漏斗规则需要客户元数据）→ ④ 最终经 `src/context/injector.js` 注入 prompt 的 L1 块（WHAT 语义） | `src/context/assembler.js:41-67` → `src/context/injector.js:2 formatForPrompt`（输出 `相关知识(N)`） | 输出到 LLM 的 prompt 段 | 注入日志：`context_inject_log`（如无则新增，见 §6） |

**追溯链（一追到底）**：  
`prompt 看到的实体名 + 属性` ← `injector` ← `assembler L1` ← `particles.stable_key='crm:account:中科曙光'` ← `Processing: conflict 检测未冲突 + 本体闭合通过` ← `Ingestion: req.body + user_id='alice'`

**WHERE 锚点**（Application 内部）：本示例的 WHERE = `(L=1, 场景=account-insight 或 customers 列表, 租户=system, 角色=sales)`。

---

### §3.2 示例 2：叙事时间线（记忆）—— 上下文层 WHEN 轴（不是记忆资产）

**情境**：`sales` 在客户 360 洞察页查"中科曙光"过去 90 天的进展序列。

| 阶段 | 具体动作 | 代码/file:line 证据 | 沉淀对象 | PROV-O 字段 |
|---|---|---|---|---|
| **Ingestion** | 多个源已分别落库（异步）：<br>① 用户操作：`POST /api/visits` → `crm.events` (kind='visit_log')<br>② 任务完成：`taskService.completeTask` → `crm.events` (kind='task_complete')<br>③ 决策事件：`POST /api/decisions` → `crm.decision` + 同步至 `crm.events` (kind='decision_made')<br>④ 记忆录制：`memoryLog.append` → `src/memory/memoryLog.js` | `src/portal/visits.js` / `src/task/*` / `src/decision/disposition.js` / `src/memory/memoryLog.js` | 4 类事件源各自沉淀 | 各源自带的 `actor_id` + `created_at` |
| **Processing** | `judge.js` 归类（按 kind 决定是否纳入"客户实体叙事"）+ 30 天蒸馏判定（`snapshot.js`） | `src/memory/judge.js` + `src/memory/snapshot.js` | 蒸馏后的 note 候选 | `distilled_at` + `distill_rule` |
| **Intelligence** | 记忆系统沉淀：<br>· `crm.events`（纯事件流，部分 kind）<br>· `src/memory/memoryLog.js`（append-only 日志，append 模式不删不覆盖）<br>· `src/memory/note.js`（curated 笔记，每条带 `superseded_by` + `derived_from_event_ids[]`） | `src/memory/*` | 记忆系统沉淀物 | 每个事件/笔记自带的 `actor_id` + `created_at` + `entity_id`（绑定客户实体） |
| **Application** | **WHEN 轴装配**（关键修正）：`src/context/narrative.js assembleNarrative(scope)` — **派生视图，不写存储** — 读 4 源（`crm.events` / `tasks` / `crm.decision` / `memoryLog`）按时间序合并（实现细节同 `insightService.js:244 loadTimelineSources`）→ 产出 `bundle.narrative.entries[]` → `assembler.js` 收入 bundle → `injector.js` 三段式注入 | `src/context/narrative.js`（新增模块，**实现模板复用 `insightService.js:244-278 loadTimelineSources`**，由 `story-graph-fusion A1/A2` 任务承接提升）→ `src/context/assembler.js` `bundle.narrative` → `src/context/injector.js`【叙事时间线】块 | 输出到 LLM 的 prompt 段 | `assembleNarrative` 调用的 `scope` + `context_resolve_log`（如无则新增，见 §6） |

**追溯链（一追到底）**：  
`prompt【叙事时间线】段落` ← `injector` ← `assembler.bundle.narrative` ← `narrative.assembleNarrative(scope)` ← 4 源 SELECT（events/tasks/decision/memoryLog，按 ts 全序）← 各事件自身 PROV-O（`crm.events.created_by` 等）

**关键提醒**：叙事时间线 **不是记忆资产**，**它是上下文层派生视图**。记忆资产是 `memoryLog` 与 `note.js`（curated 笔记可版本化）；时间线是它们的"装配视图"——这就是"应当作 WHEN 轴在上下文层装配"的核心原因。

**WHERE 锚点**：WHERE = `(L=2, 场景=account-insight 或 named-accounts, 租户=system, 角色=sales)`

---

### §3.3 示例 3：决策事件（判断）—— 决策系统

**情境**：`sales` 在商机详情页点击"申请折扣 15%" → 触发折扣决策 → 触发审批流 → 触发复盘。

| 阶段 | 具体动作 | 代码/file:line 证据 | 沉淀对象 | PROV-O 字段 |
|---|---|---|---|---|
| **Ingestion** | ① 用户 UI 点击 → `POST /api/decisions` body=`{type:'DISCOUNT_APPROVAL', amount:'15%'}` → ② `disposition.js` 第 0 闸：写入-权限 + 决策-类型合法性 + 必要字段齐全 → ③ 通过后进入 Processing | `src/http/routes.js` `/api/decisions` → `src/decision/disposition.js` 第 0 闸函数 | 决策请求对象（待校验） | `request_id` + `actor_id` + `submitted_at` |
| **Processing** | ① `pipeline/conflict.js` 检测并行决策（同商机 + 同类型 + 未关闭 → 冲突，HITL 提示）→ ② `normalizeDecision.js` 归一（金额/折扣率/规则 ID）→ ③ `vocabulary.js` 本体闭合（决策类型必须在 decision_type 受控表内）→ ④ 选决策边预备（按 Oleg 七维前 4 维 + 七边定义） | `src/pipeline/conflict.js` → `src/decision/normalizeDecision.js`（`disposition.js` 内含）→ `src/ontology/vocabulary.js` | 校验后待入决策系统的对象 | `normalized_at` + `conflict_check_passed=true/false` + `vocab_check_passed=true/false` |
| **Intelligence** | 写入决策系统：<br>· `crm.decision`（31 列：scenario/tier/decider_type/confidence/confidence_source/confidence_at/decided_at/created_at 等）<br>· `crm.decision_relation`（7 类边中本场景涉及的：DECIDED_ON / ESTABLISHES_FRAME / REFERENCED_PRECEDENT / CAUSED 等；BG-02/03 修复后权威表可写）<br>· `crm.decision_outcome`（事后产物：成交/未成交/延期）<br>· `crm.provenance`（PROV-O 主表：`decision_id` / `actor_id` / `rule_id` / `reasoning_summary` / `source_event_ids[]`） | `src/decision/decisionRepo.js`（24 文件共享 `inserter` + `addEdge`）→ 7 类边按 BG-03 修复后改写权威表 | 决策系统沉淀物 | `crm.decision` 自带 + `crm.provenance` 主 PROV-O 链 |
| **Application** | ① L2 历史决策：被 `assembler.js:69-78 retrieveL2` 取回（含 rationale 字段但 `:18` 不输出）→ ② L4 治理决策：被 `monitor/edgeCompliance` 巡检 + `gates` 实时校验 → ③ `bundle.graph_context.decision_edges[]` 由 `injector.js` 三段式注入 → ④ 复盘场景（`decision-retrospective`）消费 `crm.decision_outcome` + `crm.root_cause` 写根因 | `src/context/assembler.js:69-78 retrieveL2` → `src/context/injector.js`【图谱上下文·决策】块（BG-01 修复点）→ `src/monitor/edgeCompliance.js` | 输出到 LLM + 监控的产物 | `context_resolve_log` + `monitor/edge_log` |

**追溯链（一追到底）**：  
`prompt【图谱上下文·决策】段落` ← `injector` ← `assembler.bundle.graph_context.decision_edges` ← `decision_relation` JOIN `decision` SELECT ← `decisionRepo.addEdge`/insert 写入 ← Processing 4 步校验全过 ← `Ingestion: req.body + actor_id='alice'`

**PROV-O 主链**（决策系统独有）：`crm.provenance` 是决策系统的 PROV-O 主表，所有写入决策系统对象的 PROV-O 字段（rule/actor/source_event_ids）都收口在这里。**修复 BG-06（边写降级留痕）后**，所有边写入都强制经过 `crm.provenance`。

**WHERE 锚点**：WHERE = `(L=2+L=4, 场景=sales-decision-monitor 或 deal-detail, 租户=system, 角色=sales 或 admin)`

---

## §4 四个既有概念在新骨架上的归宿（"回收术语"）

| 既有概念 | 出处 | 新骨架归宿（**钉死，不含糊**） |
|---|---|---|
| **Lightfield 四元组**（chronology / attribution / state / causality） | lightfield.app | **记忆系统的内容模型**：chronology → WHEN 轴的源（memoryLog/events）；attribution → WHO（actor_id 字段）；state → WHAT（绑定实体粒子）；causality → 记忆间的指针指向决策系统 BECAUSE 块。**四元组只在记忆系统内部使用，不作为顶层分类**。 |
| **Oleg 七维**（identity / structure / semantics / time_config / decision_history / operational_state / governance） | `src/sevenDimensions/constants.js:5-13` | **Processing 阶段的校验轴**：前 4 维校验知识系统（中台静态），后 3 维校验决策系统（前台动态）。**归属矩阵**（接续 `top-architecture §5`）：`identity+structure+semantics` → 知识系统；`time_config` → 横切（知识时间窗 + 决策时间窗）；`decision_history+operational_state+governance` → 决策系统。 |
| **七决策边**（DECIDED_ON / REFERENCED_PRECEDENT / DERIVED_FROM_EXCEPTION / ESTABLISHES_FRAME / OVERRIDES / CAUSED / INFLUENCED） | `src/decision/edgeDimensionSpec.js:16-33` | **决策系统的证据学横切**：专属决策系统，被 L2/L4 消费（`assembler.bundle.graph_context` + `monitor/edgeCompliance`）。**现状缺陷**（BG-02/03）：7 类中仅 3 类能进权威表，BG-03 结构扩容后全部可写。 |
| **L1–L4 注入深度** | ai-context-layering SKILL + `src/context/injector.js` | **Application 阶段内部分量（WHERE 轴）**：L1 知识底座 / L2 历史决策 / L3 执行协同 / L4 治理决策。**WHERE 轴的具体维度**：层级 + 场景 + 租户 + 角色。 |

**核心结论**：你"晕"的根本原因是这 4 套术语**没有钉到一张表上**，现在钉到了。任何术语被问"它属于哪个系统、哪个阶段、哪个消费层"都能立刻回答。

---

## §5 灰色地带的判定三问（接续 top-architecture §5）

新数据/能力出现时，回答三问决定归属：

| 问 | 知识系统 | 记忆系统 | 决策系统 |
|---|---|---|---|
| **问 1：是客观事实 + 规则，还是带版本叙事，还是有主语判断？** | 事实 + 规则 | 叙事 + 时效 | 判断 + 问责 |
| **问 2：被 L1–L4 哪几层消费？** | L1 + L3 | L1（实体）+ L2（叙事） | L2 + L4 |
| **问 3：跨实体可复用吗？** | 是 → 知识 | 否 → 记忆 | 否 → 决策 |

**反例（反推）**：
- `visit_note`（拜访记录）：是否事实？基本是事实（谁/何时/去哪）；是否有版本叙事？带小结；是否判断？含部分评价 → **默认归知识系统**（粒子 + 字段），叙事摘要进记忆系统派生视图。
- `interaction_log`（交互流）：是否带版本叙事？通常纯事件流；是不是判断？→ 否；是否可复用？通常绑定实体 → **记忆系统**（events 源）。
- `gate_state`（闸门状态）：是否有判断？是；→ **决策系统**。

---

## §6 可追溯性的工程落地（缺失 PROV-O 字段清单）

要让"一追到底"真正可操作，需补以下 PROV-O 字段/表（**仅梳理，不实施**）：

| 对象 | 缺失 PROV-O 字段 | 落地建议 | 依赖 |
|---|---|---|---|
| `crm.particles` | `source_request_id` + `created_by_actor` 已部分在 `meta_attr` | 在 `meta_attr` 增加 `source_request_id`（Ingestion request_id）字段 | 与 BG-meta-attr 合并 |
| `crm.decision` | `provenance_id`（FK→`crm.provenance`，必备 PROV-O 主键） | 新增字段 + FK + 回填历史 | 与 BG-06 合并 |
| `crm.decision_relation` | `provenance_id`（每条边都有） | BG-06 修复强制带 provenance | BG-06 |
| `src/memory/memoryLog.js` 行 | `source_event_id` + `actor_id`（已基本有） | 不补 | — |
| `src/memory/note.js` 行 | `derived_from_event_ids[]`（部分有） | 字段加 ARRAY 类型（已 JSONB，需规范） | 与 `superseded_by` 合并 |
| **新增 `crm.context_resolve_log` 表** | `assembler` 每次装配的 trace（5 维：时间/request_id/intent/bundle 中每块命中条数/降级原因） | 新建表 + `assembler.js` 落库 | 与 T2 任务合并 |
| **新增 `crm.context_inject_log` 表** | `injector` 每次注入的 trace（5 维：时间/request_id/场景/L 层级/prompt_hash） | 新建表 + `injector.js` 落库 | 与 T3 任务合并 |
| **新增 `/api/trace/:entity_type/:entity_id` API** | 给任意对象返回完整 4 阶段追溯链 | 新增路由 | 与 §7 T6 合并 |

**判断**：只有 `context_resolve_log` + `context_inject_log` + `/api/trace` 是新工作，其他 7 项都是既有字段/表的补充。落地优先级见 §7。

---

## §7 落地任务路线（**仅梳理，不实施**）

> 与 `top-architecture §7` + `story-graph-fusion-design §4` 重叠部分**统一编号**。

| 阶段 | 行动 | 涉及模块 | 与已有任务的关系 |
|---|---|---|---|
| **T0** | 文档明确 §5 三问判据 + §4 四概念归宿表 | 所有 docs | 本文档落地即 T0 完成 |
| **T1** | 补 PROV-O 字段（§6 表） | `crm.particles` + `crm.decision` + `crm.decision_relation` | 与 `bugfix-design.md` BG-06 / BG-meta 合并 |
| **T2** | 新增 `crm.context_resolve_log` + `crm.context_inject_log` 表 | 新增 migration + `assembler.js` + `injector.js` 落库 | 与 `story-graph-fusion A3/A4` 合并 |
| **T3** | 新增 `/api/trace/:type/:id` API（含 PROV-O 完整链路） | 新路由 + 复用 §3 三个示例的查询路径 | 新工作 |
| **T4** | 视觉化追溯：在配置中心新增"追溯浏览器"页（点实体看 4 阶段链路） | `portal/traceExplorer.html` | 新工作 |
| **T5** | Oleg 七维归属矩阵文档化（接续 `top-architecture §5`） | 仅文档 | 本文档 §4 已给，无需新文档 |
| **T6** | 修补 §1.5"六轴"在新文档落地后，**回改 `story-graph-fusion-design.md` §1.5**：删除"六轴模型"独立术语，统一用"上下文块的 6 类语义内容" | 旧文档修订 | 与 T0 合并 |

**关键判断**：T0–T2 是**必须**（文档化 + 关键 PROV-O 字段与日志）；T3–T4 是**应当**（落地"一追到底"承诺）；T5–T6 是**顺手**（钉术语）。

---

## §8 与现有两文档的关系

| 文档 | 关系 |
|---|---|
| `docs/2026-09-01-top-architecture-three-systems.md` | **本设计是其"可追溯化"细化**——三系统模型不变，给 §1.3 三维正交 §2 三系统收敛 §4 既有术语归宿。**待统一**：top-architecture §3.5 提到"叙事**源**与**合成洞察**"，本设计 §3.2 应用该结论。 |
| `docs/2026-09-01-story-graph-fusion-design.md` | **本设计是其"枢纽化"细化**——三段式上下文束 = Application 阶段产出（§1.1 矩阵明确），叙事时间线 = 上下文层 WHEN 轴（§3.2 明确）。**待回改**：story-graph-fusion §1.5 的"六轴模型"独立段，**回退为"上下文块的 6 类语义内容"**（T6 任务）。 |
| `docs/2026-09-01-bug-verdict-and-tetrad-7dims-7edges-mapping.md` | **本设计引用其"五维分析骨架"**——四元组/七维/七边三者关系的判定方法见 §4 归宿。 |
| `docs/2026-09-01-bugfix-design.md` | **与 T1 合并**——8 项缺陷修复 + PROV-O 字段补全同时落地。 |

---

## §9 待裁决项（Q1–Q5）

| # | 问题 | 选项 | 建议 |
|---|---|---|---|
| **Q1** | 是否采纳"Semantica 4 阶段 × 三系统 × L1–L4"三维正交架构？ | A. 采纳<br>B. 仅作分析参考 | **A**——给已有两文档一个统一的枢纽 |
| **Q2** | 是否将"六轴模型"术语统一为 **J7 决策七轴（决策脊柱 J）** 并补齐 WHERE？ | A. 统一为 J7<br>B. 保留六轴 | **A**——用户明确要"七轴 J7"，且与 `edgeDimensionSpec.js:1-3` 的 K/M/J 命名一致 |
| **Q3** | WHERE 归 Application 阶段的消费路由轴（L1–L4 + 场景 + 租户 + 角色）是否正确？ | A. 是<br>B. 另列 | **A**——与 L1–L4 同层 |
| **Q4** | 追溯工程落地（T1–T4）是否单独立项？ | A. 单独立项<br>B. 与修复 BG-06 合并<br>C. 与 sales-decision-monitor 合并 | **B**——追溯的 60% 工作是 PROV-O 字段补全，与决策系统修复是同一语境 |
| **Q5** | 配置中心是否新增"追溯浏览器"页（T4）？ | A. 新增<br>B. 暂不需要 | **B（暂不需要）**——先 API 可用，未来按需可视化 |

---

## §10 非目标（明确不做的事）

- 不重新设计 10 大 ai-* SKILL
- 不废弃 L1–L4 / Oleg 七维 / 七决策边 / Lightfield 四元组——只钉归宿
- 不替换 PostgreSQL/AGE/Vector 栈
- 不引入 SPARQL/OWL/SHACL/Semantica 的全套组件——只引入"4 阶段"的工程范式
- 不立即建云端画像 / 用户级记忆
- 不在本次实施任何代码改动（本设计仅梳理）

---

## §11 总结

**一句话**：用 Semantica 4 阶段（Ingestion→Processing→Intelligence→Application）做"可追溯主轴"，把三系统（知识/记忆/决策）与 L1–L4（消费深度）合并到一张矩阵上；任何对象都能用 `(阶段, 系统, 消费层)` 三元组定位，回追到 Ingestion 源数据。

**三个示例的"一追到底"承诺**（§3）：
- 示例 1（事实/客户实体）：`prompt 看到的实体名` ← `injector` ← `assembler L1` ← `particles.stable_key` ← `Processing 校验` ← `Ingestion: req.body`
- 示例 2（记忆/叙事时间线）：`prompt【叙事时间线】` ← `injector` ← `assembler.bundle.narrative` ← `narrative.assembleNarrative` ← 4 源 SELECT ← 各事件 PROV-O
- 示例 3（决策/折扣审批）：`prompt【图谱上下文·决策】` ← `injector` ← `assembler.bundle.graph_context` ← `decision_relation` ← `decisionRepo` ← Processing 4 步 ← Ingestion: req.body

**用户反馈"晕了"的三项收束**：
- 砍"六轴模型"独立术语 → "上下文块的 6 类语义内容"
- WHERE 归 Application 消费路由 → 与 L1–L4 同层，与 WHEN 不同维
- 不发明新词 → 把四元组/七维/七边/L1–L4 钉到新骨架的归宿表

**当前最该做的三件事**（按 ROI）：
1. **采纳本架构为最高层枢纽**（Q1）——成本：1 文档；收益：术语一锤定音
2. **回改 `story-graph-fusion §1.5` 六轴→J7（已完成）**——成本：极低；收益：消除"晕"且对齐 K/M/J 命名
3. **PROV-O 字段补全 + 新增 context_resolve_log**（T1+T2）——成本：中；收益：让"可追溯"承诺可以承诺
