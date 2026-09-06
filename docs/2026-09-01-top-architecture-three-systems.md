# 顶层架构梳理 · 三系统划分 + 横切 L1–L4 + Semantica 风格写入层

> 日期：2026-09-01  
> 类型：顶层架构设计（不实施，仅梳理与设计）  
> 输入：① 4 篇 Lightfield 文章 + lightfield.app；② 你的 3 个连续追问（四元组 / 故事 vs 图 / 7×7 vs 七维）；③ 修复设计文档（7 项缺陷 + BG-08）；④ Semantica 微信文章；⑤ 你提供的官方架构图；⑥ 本平台现有 `src/`、`docs/`、10 大 ai-* SKILL。  
> 目的：把"知识系统 / 记忆系统 / 决策系统"和"L1–L4"摆到正确的位置，给后续系统打磨一张可裁决的顶层地图。

---

## §0 为什么要做这件事

现状：本平台经过数轮能力沉淀，**方法论层**已成型（10 大 ai-* SKILL + 七维 + 七边 + 四元组 + Lightfield 评估），但**对象层**命名混乱——`src/memory/` `src/decision/` `src/ontology/` `src/context/` 四个目录的边界是按"SKILL 群"切分的，不是按"对象性质"切分的。每新增一个能力就要决定"它属于哪"，跨目录依赖频繁、复用与边界难以一眼看清。

你提出的"知识系统 / 记忆系统 / 决策系统"三系统划分，**正中靶心**——这是按数据对象的性质纵切，再叠加横切 L1–L4（运行时注入深度）、齐全轴 Oleg 七维、证据学七边，最后引入 Semantica 风格的写入流水线作为第四个轴。**这才是本平台真正缺的顶层地图**。

---

## §1 现状盘点：现有 src/ 在三系统视角下的归属

把现有模块按"它服务的对象性质"重新分类（不是按文件名）：

| 系统 | src/ 现有模块 | 性质 |
|---|---|---|
| **知识** | `ontology/{vocabulary, hooks, ageSync}`、`account/insightService`（指标口径）、`agent/agentSpec`（SKILL 注册）、`sales/{funnelQuality, visitNote}`（业务规则） | 共享的、可复用的、跨实体的客观事实与规则 |
| **记忆** | `memory/{capture, judge, memoryLog, note, snapshot}`、`account/insightService`（叙事装配部分） | 绑定实体、有时效、带版本叙事的上下文 |
| **决策** | `decision/`（24 个文件：relation, decisionRepo, retro, confidence, conflict, rootCauseClassifier, traceRootCause, contextGuard, closure, ageGraph, auditability, auditabilitySla, autonomyEngine, interception, outcome, outcomeIngester, provenance, disposition, feedback, graphAnalytics, decisionTrace, edgeDimensionSpec） | 可问责、有主语、有因果证据链的判断事件 |
| **横切/消费侧** | `context/{injector, assembler, roleProfiles, scope}`、`portal/sevenDimRender`、`monitor/attribution`（边合规计算）、`monitor/edgeCompliance`（巡检） | 跨系统被消费，不属于任何单一系统 |
| **横切/动作** | `action/registry`、`agent/agentLoop`、`agent/scheduler`、`eventBus/*` | 跨系统执行通道 |

**关键观察**：
1. **现有命名是按 SKILL 群切的，不是按对象性质切的**——所以"ontology"目录其实装着记忆/决策的钩子（`ontology/hooks.js`），"monitor"目录同时含横切（边合规计算）和决策系统（attribution 评估）。
2. **跨目录复用密集**——`account/insightService` 同时承担知识（指标口径）和记忆（叙事装配），必须在文档里说明。
3. **缺"写入流水线"层**——Semantica 风格的"读入 → 实体抽取 → 冲突检测 → 合并 → 入图 → PROV-O 留痕"在本平台是散落在 capture/hooks/judge 里的，没有统一的契约。

---

## §2 三层对位：你的问题 → 本平台既有定义 → Semantica 启发

### §2.1 "知识系统（4 维？还是以前的 L1–L4？）」—— 它们根本不在同一层

| 候选 | 出处 | 真正含义 | 与三系统的关系 |
|---|---|---|---|
| **L1–L4** | `ai-context-layering` SKILL + `context/injector.js` | **消费侧横切**——一个任务该注入多深的知识，按累积语义（知识底座 / 历史决策 / 执行协同 / 治理决策） | 不属于任何单一系统——横切所有三系统 |
| **Oleg 七维（7 个抽屉）** | `sevenDimensions/constants.js` + `edgeDimensionSpec.js:7` | **齐全性横切**——任一维缺失即导致 AI 自信答错 | 不属于任何单一系统——校验三系统共同满足 |
| **七决策边** | `edgeDimensionSpec.js:16-33` | **证据学横切**——拿什么边作为决策合规证据 | **专属于决策系统**，但被 L2/L4 注入消费 |
| **Lightfield 四元组** | lightfield.app + 我们之前的对齐 | **记忆系统的内容学**（chronology/attribution/state/causality） | 记忆系统的内容规范 |
| **Semantica 4 层**（你贴图） | 微信文章《9.6K Star》 | **写入流水线**——Ingestion/Processing/Intelligence/Application 是数据从原始到决策的过程阶段 | 与三系统正交，跨三系统 |
| **10 大 ai-* SKILL** | 固定基线 | **方法论层**——SKILL 是治理规范，不是系统划分 | 横切所有系统 |

**因此你的疑问"4 维 vs L1–L4"其实不存在"哪个更好"**：
- L1–L4 是**消费侧**的注入深度轴（已有 SKILL：ai-context-layering）
- 知识系统内部**没有 4 维**——如果你想引入 4 维，可能是把 Oleg 七维**前 4 维**作为知识系统的"内容骨架"，因为后 3 维（decision_history / operational_state / governance）属于决策系统。
- 这意味着"知识系统的内容" ≠ "知识系统的全部维度"——内容在知识系统，校验在横切。

### §2.2 Semantica 启发：四层流水 vs 三系统纵切

Semantica 官方图把数据生命周期分成 4 层（Ingestion / Processing / Intelligence / Application），每层有明确职责：
- **Ingestion**：Files / Web / Databases / Streams / Parquet 五类连接器接入
- **Processing**：Parse → Normalize → NER → Build Graph → QA & Dedup（**冲突检测、合并重复实体**是这一层的关键）
- **Intelligence**：Knowledge Graph（NetworkX/Neo4j/AGE）+ Vector Store（FAISS/Pinecone/Qdrant）+ Ontology（OWL/SHACL/SKOS）+ Triplet Store（SPARQL/Blazegraph/Jena）+ Embeddings
- **Application**：GraphRAG Agents + Decision Tracking（causal chains + audit）+ Reasoning（forward chain + Datalog）+ Explorer + Export（PROV-O）

**核心洞察（必须正面承认）**：本平台**没有显式的写入流水线**。现状是：
- Ingestion 散落在 `action/registry.js` + `connectors/tenderConnector.js`
- Processing 散落在 `capture.js` 的 LLM 调用 + `judge.js` 的归类 + `vocabulary.js` 的本体校验，**冲突检测**有但不全
- Intelligence 等价于"三系统" + AGE/PostgreSQL（已有 Vector 但只哈希）
- Application 等价于 `agent/agentLoop` + `context/injector` + `monitor/*`

**Semantica 与本平台的真正差异**：
1. Semantica 把"决策"作为 Intelligence 层的**一等公民**（Decision Tracking 模块独立、决策边与因果边同源入图）——本平台已做到（`decision/` 24 文件）
2. Semantica 显式建模"处理阶段"（conflict detector + merge）——**本平台缺失**，导致同一客户实体可能被两次抽取为不同记录（写时校验有但写入后未治理）
3. Semantica 显式建 Triplet Store + SPARQL 查询层——本平台 AGE 是图但缺 SPARQL 语义
4. **Semantica 不写 L1–L4 注入分层**——它假设"查询时由 GraphRAG 自动组织上下文"，本平台显式分 L1–L4 是为了可观测与降级链

**结论**：Semantica 4 层是**写入流水线**（纵切三系统都走它），L1–L4 是**消费横切**（消费三系统的产物）——两者正交，不是竞争关系。

---

## §3 推荐划分：纵切三系统 + 横切 L1–L4 + 横切 Semantica 写入流水线

### §3.1 顶层架构图

```
┌─────────────────────────────────────────────────────────────────────┐
│                          消费侧（运行时注入）                          │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ L1 知识底座    ← knowledge.system.graph / ontology / 七维前 4  │   │
│  │ L2 历史决策    ← decision.system.timeline + 七边              │   │
│  │ L3 执行协同    ← knowledge.system.blueprint                  │   │
│  │ L4 治理决策    ← decision.system.gates + decision.system     │   │
│  └──────────────────────────────────────────────────────────────┘   │
│       ↑                                                              │
│       │ 消费（横切）                                                 │
│       │                                                              │
│  ┌────────────────────────────────────────────────────────────┐     │
│  │                    三系统（纵切·对象性质）                    │     │
│  │  ┌──────────┐   ┌──────────┐   ┌──────────┐                │     │
│  │  │  知识系统 │   │  记忆系统 │   │  决策系统 │                │     │
│  │  │ particle │   │ chronology│   │ 决策事件  │                │     │
│  │  │ ontology │   │ versioned │   │ 决策边    │                │     │
│  │  │ 受控谓词 │   │ distill   │   │ 复盘根因  │                │     │
│  │  │ 蓝图规则 │   │ memoryLog │   │ 治理闸门  │                │     │
│  │  └──────────┘   └──────────┘   └──────────┘                │     │
│  └────────────────────────────────────────────────────────────┘     │
│       ↑                                                              │
│       │ 写入（横切）                                                 │
│       │                                                              │
│  ┌────────────────────────────────────────────────────────────┐     │
│  │             Semantica 风格写入流水线（横切）                  │     │
│  │  Ingestion → Processing (冲突/合并) → Intelligence → PROV-O │     │
│  └────────────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────────┘
                              ↑
                  方法论层（10 大 ai-* SKILL · 横切所有）
```

### §3.2 三个纵切系统：定义与内涵

| 系统 | 定义 | 内容（暂定） | 写入路径 | 治理 | 检索出口 |
|---|---|---|---|---|---|
| **知识系统** Knowledge System | 共享的、可复用的、跨实体的客观事实与规则 | • 粒子图（crm.edges 受控谓词边）<br>• 本体/词汇（KNOWLEDGE 粒子 + vocabulary）<br>• 业务规则蓝图（funnelQuality / 七维矩阵）<br>• Agent / SKILL 注册（agentSpec）<br>• 配置中心（config_store） | Semantica Ingestion → Processing → Intelligence | 受控谓词边、写时校验、本体闭环 | **L1 知识底座** + L3 蓝图 |
| **记忆系统** Memory System | 绑定实体、有时效、带版本叙事的上下文 | • 双轨结构（append-only memoryLog + curated note）<br>• 三层（云端画像 / 用户级 / 工作区级）<br>• 30 天蒸馏 + TTL<br>• 叙事**源**（memory_log/events）+ **合成洞察**（curated note，带 superseded_by；原始时间线条目是派生视图，不加版本化）<br>• 实体级 context（`capture.js` 派生字段）<br>• Oleg 七维后 4 维（time_config / operational_state 部分 + decision_history 部分） | Ingestion → Processing（合并去重）→ snapshot 蒸馏 | 三层生命周期 + 蒸馏规则 | **L1**（实体画像） + **L2**（历史叙事） |
| **决策系统** Decision System | 可问责、有主语、有因果证据链的判断事件 | • 决策事件（crm.decision + scenario/tier/decider_type）<br>• 决策边（7 类：CAUSED/INFLUENCED/ESTABLISHES_FRAME/OVERRIDES/DECIDED_ON/REFERENCED_PRECEDENT/DERIVED_FROM_EXCEPTION）<br>• 治理闸门（gates + audit trail）<br>• 复盘根因（rootCauseClassifier + retro + trace）<br>• 置信度/置信来源（confidence + confidence_at）<br>• Oleg 七维的 decision_history + governance（专属于决策系统） | Ingestion → Processing（**冲突检测核心**：disposition/disposition conflict/parallel decision 合并）→ Intelligence | **PROV-O / Auditability / 第 0 闸 / 决策第 0 闸** | **L2 历史决策** + **L4 治理决策** |

### §3.3 横切一：L1–L4 注入深度（消费侧）

| 层 | 跨三系统来源 | 通道 | 校验 | 降级 |
|---|---|---|---|---|
| **L1 知识底座** | 知识系统：粒子图 + 本体 + 业务规则<br>记忆系统：实体级画像 | AGE 图遍历 + 实体向量 | Oleg 七维前 4 维 | graph fail → vector → 空降级（无报错） |
| **L2 历史决策** | 决策系统：决策事件 + 决策边<br>记忆系统：叙事时间线 | FTS 预筛 → 池内向量排序 | Oleg 七维的 decision_history | 三级降级链（FTS+Vec → 纯Vec → 纯FTS） |
| **L3 执行协同** | 知识系统：蓝图规则<br>决策系统：HITL 检查点契约 | 蓝图 taskFlow（无检索，纯函数） | blueprint 含该 taskId | 无 I/O，无失败面 |
| **L4 治理决策** | 决策系统：闸门 + 审计 + 复盘 | gates 实时查询 + gate-event 粒子 | Oleg 七维的 governance | **gates 禁缓存**，每次重查 |

**L1–L4 不是第四个系统，是三系统的消费路径**。这个判断是顶层地图的支柱——L1–L4 必须继续存在且强化，但不能与三系统并列成第四个系统（否则会重蹈"按方法论切目录"的旧问题）。

### §3.4 横切二：Semantica 风格写入流水线（新增）

把现在散落在 capture/judge/hooks/vocabulary 的写入路径**收敛成一个显式的四阶段契约**：

| 阶段 | 本平台现状 | 改造建议 | 落地形态 |
|---|---|---|---|
| **Ingestion**（接入） | `action/registry.js` + `connectors/tenderConnector.js` + 用户行为（visit_notes / decisions） | 维持现状，统一接入协议（已有 `contextInjection: L1\|L2\|L3\|L4`） | **不重构**，加文档与契约测试 |
| **Processing**（处理） | `capture.js` 抽事件 + `judge.js` 归类 + `vocabulary.js` 本体校验 | **新增：冲突检测 + 实体合并**——同一客户/商机/决策被两次写入时识别并去重（Semantica QA & Dedup） | 新模块 `pipeline/conflict.js` + `pipeline/merge.js` |
| **Intelligence**（入图） | AGE 镜像 + PostgreSQL 权威表 + Vector（哈希） | **改造：embedding 换 SiliconFlow 真向量**（独立任务 BG-07）+ 决策边统一入口（BG-02/03 修复） | 跟修复设计文档合并执行 |
| **PROV-O / Audit**（溯源） | `decision/provenance.js` 已存在 | **强化：所有写操作必经 PROV-O 落库**（目前仅决策系统有） | 与 BG-06（边写降级留痕）合并 |

### §3.5 横切三：方法论层（10 大 ai-* SKILL）

10 大 ai-* SKILL 是方法论层，**横切所有三系统 + 两个横切**。SKILL 不属于任何单一系统，它是**治理规范**而非"数据对象"。

---

## §4 三系统内部组成（精确到文件级别）

### §4.1 知识系统 Knowledge System

| 范畴 | 模块 | 当前状态 |
|---|---|---|
| 粒子图 | `crm.edges`（受控谓词边）+ `particles/*` 业务对象 | ✅ 已落地 24 类粒子（Sales 主体 + 决策 + 记忆 + 元配置） |
| 本体 / 词汇 | `src/ontology/vocabulary.js` + `crm.skill_registry` (KNOWLEDGE 类) | ✅ 已落地，但词汇表未自动维护 |
| 业务规则蓝图 | `src/sales/funnelQuality.js` + `src/sales/visitNote.js` + `src/portal/sevenDimRender.js` | ✅ 已落地，配置化 |
| Agent 注册 | `src/agent/agentSpec.js` + `src/action/registry.js` | ✅ 已落地 |
| 配置中心 | `config_store` + `src/portal/configCenter.js` (id 11–32) | ✅ 已落地 |

**核心指标**（硬目标）：配置化率 100%（阈值/规则全部经 `readThreshold()` 等入口），本体闭环率 ≥95%（写时校验通过率），agent 注册 100% 经 `agentSpec`。

### §4.2 记忆系统 Memory System

| 范畴 | 模块 | 当前状态 |
|---|---|---|
| 双轨结构 | `src/memory/memoryLog.js`（append-only 日志）+ `src/memory/note.js`（curated 笔记） | ✅ 结构完整 |
| 蒸馏 / 快照 | `src/memory/snapshot.js` + `src/memory/judge.js` | ✅ 已落地；30 天蒸馏规则待文档化 |
| 捕获 / 归类 | `src/memory/capture.js`（事件捕获）+ `src/memory/judge.js`（归类决策） | ✅ 已落地；**缺冲突检测**（BG-NEW-09） |
| 实体级上下文 | `src/account/insightService.js`（叙事装配部分）+ `buildTimelineRows` | ✅ 装配器已写；**未进注入层**（BG-01 真 BUG） |
| 三层结构 | 云端画像 / 用户级 / 工作区级 | ⚠️ 仅有工作区级落地（`src/.workbuddy/memory/`），云端/用户级未建 |
| 版本化叙事 | `decision/decisionTrace.js`（事件追溯）+ 叙事 `superseded_by` 字段 | ⚠️ 框架有，叙事条目版本化未落实 |
| Oleg 七维后 4 维 | `time_config`（行内 `effective_from/to` + 边 CAUSED/INFLUENCED）+ `decision_history`（边 REFERENCED_PRECEDENT/OVERRIDES）+ `operational_state`（边 DERIVED_FROM_EXCEPTION）+ 部分 `governance` | ⚠️ 七维后 4 维跨越知识/记忆/决策三系统，需"按场景归属" |

**核心指标**（硬目标）：蒸馏覆盖率 100%（超 30 天的日志全蒸馏/归档/遗忘），叙事条目带 `superseded_by` 100%，云端画像 P0 不建（YAGNI），但工作区级 30 天蒸馏 P1。

### §4.3 决策系统 Decision System

| 范畴 | 模块 | 当前状态 |
|---|---|---|
| 决策事件 | `decision/decisionRepo.js` + `db.crm.decision`（31 列） | ✅ 已落地 |
| 决策边（7 类） | `decision/relation.js`（统一入口）+ `db.crm.decision_relation` | ⚠️ **7 类只落 3 类权威表**（BG-02/03/05 待修） |
| 复盘根因 | `decision/retro.js` + `decision/rootCauseClassifier.js`（7 类）+ `decision/traceRootCause.js` | ✅ 已落地 |
| 置信度 | `decision/confidence.js` + `db.crm.confidence/confidence_at/confidence_source` | ✅ 已落地 |
| 治理闸门 | `decision/ageGraph.js` + `decision/closure.js`（三图闭包）+ `decision/auditability*.js` | ✅ 已落地 |
| 第 0 闸 + PROV-O | `decision/provenance.js` + 决策第 0 闸 | ✅ 已落地 |
| Oleg 七维的 governance | 闸门 / 审计 / 蓝线 / 红线 | ✅ 已落地，决策系统专属 |

**核心指标**（硬目标）：7 类边全部进权威表（修复 BG-02/03 后），EDGE_MISSING 误报清零（修复 BG-05 后），auditability SLA 100% 达成。

---

## §5 三系统与 L1–L4 / Oleg 七维 / 七边的对位矩阵

这是顶层地图的核心交叉表，给"任何模块/数据都该放在哪里"提供唯一判据：

| 数据/能力 | 知识系统 | 记忆系统 | 决策系统 | L1–L4 注入 | Oleg 七维校验 | 七边证据 |
|---|---|---|---|---|---|---|
| 客户实体 | ✅ 粒子 | ✅ 实体画像 + 叙事 | — | L1（实体） | identity + structure + semantics | — |
| 商机 | ✅ 粒子 + 规则 | ✅ 进展叙事 | — | L1 + L2（历史） | structure + time_config | DECIDED_ON（针对商机粒子的决策） |
| 合同 | ✅ 粒子 + L2C 蓝图 | ✅ 履约叙事 | — | L1 + L3（执行） | structure + operational_state | DECIDED_ON |
| 决策事件 | — | — | ✅ 一等公民 | **L2** | decision_history + governance | 全部 7 类 |
| 决策边 | — | — | ✅ 因果证据 | **L2**（纳入叙事）+ L4（治理） | time_config + governance | 自身 |
| 复盘记录 | — | — | ✅ 根因分类 | L4 | decision_history | REFERENCED_PRECEDENT |
| visit_note | ✅ 字段定义 | ✅ 实体叙事 | — | L1 + L2 | operational_state | — |
| interaction_log | — | ✅ 事件流 | — | L2 | time_config | — |
| 闸门状态 | — | — | ✅ 治理 | **L4** | governance | 自身 |
| 蓝图规则 | ✅ | — | — | **L3** | semantics | — |
| 阈值/配置 | ✅ | — | — | L1 + L3 | semantics + structure | — |
| 派生字段（AI 计算） | — | ✅（归属实体） | — | L1（按实体挂载） | operational_state | — |
| skill_registry | ✅ | — | — | L1（方法论底座） | semantics | — |

**结论**：任何新数据/新能力的归属，先回答三问——
1. **它是客观事实与规则，还是带版本叙事的上下文，还是有主语的判断事件？**→ 三选一纵切
2. **它在消费时被注入到哪一层？**→ 横切层
3. **它携带的齐全性与证据性如何校验？**→ 七维 + 七边

---

## §6 候选划分方案对比（哪个更好？）

| 方案 | 划分轴 | 优点 | 缺点 | 何时用 |
|---|---|---|---|---|
| **A. 三系统 + 横切 L1–L4 + Semantica 写入流水线**（推荐） | 纵切三系统 + 横切两轴 | 对象性质清晰、消费路径清晰、写入契约清晰；与现有 10 大 SKILL 群正交不冲突；与修复设计文档无缝衔接 | 三系统边界仍存在灰色地带（如 Oleg 七维跨越三系统）；需要文档明确归属 | **推荐**：本平台阶段 2+ 的主线 |
| B. Semantica 4 层流程 | 写入生命周期 4 阶段 | 显式建模冲突/合并/PROV-O；社区成熟 | 与消费侧 L1–L4 不直接对应；隐含"GraphRAG 自动组织上下文"，与本平台显式降级链冲突 | 可作为 A 的写入横切子项 |
| C. 按 10 大 ai-* SKILL 切 | 方法论 10 大能力 | 名称即系统 | 10 SKILL 是规范不是对象；会导致"知识图谱算 ai-ontology-vector-build 还是 ai-particle-system-design"式争议 | **不推荐**——与 10 大能力铁律冲突 |
| D. 简单按数据表切 | 表级（如 crm.edges 一系统） | 最直接 | 跨表关系（如 decision_relation ↔ decision）无法表达；缺方法论语义 | 不推荐 |
| E. Oleg 七维切系统 | 七维各成系统 | 校验维度清晰 | 七维是**校验轴**不是对象；后 4 维跨越多系统；同样陷入 C 的问题 | 不推荐 |
| F. Lightfield 四元组切 | 四元组各成系统 | 客户实体视角清晰 | 只适合记忆系统一个系统的内部划分；与决策/知识无关 | 不推荐作为顶层 |

**为什么 A 最好**：
- **纵切对应数据性质**——可测试、可迁移（任何 CRM/PLM 都可套用，不绑定本平台）
- **横切对应消费与治理**——与现有 SKILL 群正交，可独立演进
- **Semantica 写入横切** 显式建模"为什么没冲突检测会引发 BG-04 假绿"——根因解答了修复文档里的疑问
- **L1–L4 保持横切** 不被破坏——避免推翻 ai-context-layering SKILL

---

## §7 推荐方案的改造路线（**仅梳理，不实施**）

| 阶段 | 行动 | 涉及模块 | 与已有任务的关系 |
|---|---|---|---|
| **T0** | 文档明确三系统边界（含灰色地带的归属判据） | 所有 `docs/` 文档 + `src/` 目录 README | **本设计文档落地即 T0 完成** |
| **T1** | 代码层目录按三系统重组（可选） | `src/knowledge/` `src/memory/` `src/decision/` 三个一级目录 + `src/context/` `src/pipeline/` 横切 | **风险**：跨目录 import 重排；建议**先文档后代码**，或保留旧目录加 README 标注 |
| **T2** | 修复 BG-01–08（决策系统最大缺陷） | 决策系统全栈 | 复用 2026-09-01-bugfix-design.md |
| **T3** | 引入 Semantica 写入横切：冲突检测 + 实体合并 | `src/pipeline/conflict.js` + `src/pipeline/merge.js` | **新工作**：不在已有修复文档里 |
| **T4** | 记忆系统 30 天蒸馏规则文档化 + **合成叙事洞察** `superseded_by`（原始时间线条目是派生视图，不加版本化） | `src/memory/` | **新工作** |
| **T5** | L1–L4 强化（注入叙事时间线 + 换真向量） | `src/context/injector.js` + `src/ontology/embedding.js` | 与 BG-01b + BG-07 合并 |
| **T6** | 决策第 0 闸扩展到知识系统（写配置必走决策） | `src/decision/disposition.js` | **新工作**：讨论项 |

**关键判断**：T0–T2 是**必须**的（文档化 + 决策系统修缺）；T3 是**应当**的（解决 BG-04 根因）；T4–T6 是**可后续**的。

---

## §8 待裁决项

| # | 问题 | 选项 | 建议 |
|---|---|---|---|
| **Q1** | 三系统是否作为正式架构分类 | A. 采纳为正式顶层架构，文档化为 2026-09-01-top-architecture-v1<br>B. 仅作分析参考，不改代码结构 | **A**——给后续工作一张可裁决地图 |
| **Q2** | 代码目录是否重组为 `src/knowledge/` `src/memory/` `src/decision/` | A. 完全重组（破坏性）<br>B. 保留旧目录，加 README 标注归属<br>C. 仅新建横切目录 `src/pipeline/` `src/context/`，三系统维持现状 | **B + C 折中**——目录演化分两步，先横切目录到位，三系统目录跟随 BG-02/03/05 修复时自然重组 |
| **Q3** | Semantica 写入横切是否作为独立子系统建设 | A. 完整建 `src/pipeline/` 4 阶段<br>B. 只补 Processing 阶段的冲突检测与合并<br>C. 不建，沿用散落实现 | **B**——最小化引入，最大化收益（解决 BG-04 根因） |
| **Q4** | L1–L4 是否升级为"消费侧横切"而非独立子系统 | A. 强化为显式消费横切（保留 SKILL 不变，文档新增定位）<br>B. 维持现状 | **A**——文档化定位即可，SKILL 保持不变 |
| **Q5** | Oleg 七维的归属是否文档化"按场景归属三系统" | A. 文档明确归属矩阵（本设计 §5）<br>B. 维持"七维独立"现状 | **A**——本设计已给矩阵 |
| **Q6** | 是否在阶段 1（修复 BG-01–08 之前）就锁定三系统定位 | A. 锁定后再修缺<br>B. 修缺与架构梳理并行 | **B**——修复是局部点，三系统是顶层图，可并行；但 Q1 必须先确认 |

---

## §9 非目标（明确不做的事）

- **不重新设计 10 大 ai-* SKILL**——10 大能力是固定基线（用户铁律 2026-08-24）
- **不废弃 L1–L4**——保留为消费侧横切
- **不废弃 Oleg 七维**——保留为齐全性横切
- **不废弃七决策边**——保留为证据学横切
- **不在本次实施任何代码改动**——本设计文档仅作为后续工作的"地图"
- **不替换 PostgreSQL/AGE/Vector 栈**——沿用现有
- **不引入 SPARQL/OWL/SHACL**——Semantica 风格的 Triplet Store 是建议项，本设计不要求实现
- **不立即建云端画像 / 用户级记忆**——YAGNI，工作区级已落地足够

---

## §10 总结

**顶层地图一句话**：
> **三系统（纵切·对象性质）+ L1–L4（横切·消费深度）+ Semantica 写入流水线（横切·写入契约）+ 方法论层（10 大 SKILL·治理规范），四层正交。**

**当前最该做的三件事**（按 ROI）：
1. **采纳本设计为正式顶层架构**（Q1 裁决）——成本：写一文档；收益：后续所有工作有地图
2. **修复 BG-01–08 决策系统 8 项缺陷**（已有设计文档）——成本：中等；收益：决策系统从"假绿"回到"真问责"
3. **补 Semantica 写入横切的冲突检测**（最小化引入）——成本：低；收益：根除 BG-04 类假绿

**不建议做的三件事**：
1. 大规模重组 `src/` 目录（破坏性大、收益小）
2. 引入完整 SPARQL/OWL/SHACL 栈（重量级、未对齐场景）
3. 推翻 L1–L4 或 Oleg 七维（与 SKILL 基线冲突）

本设计文档待你裁决 Q1–Q6 后进入实施阶段（且实施时**仍需单任务单设计**走 writing-plans）。