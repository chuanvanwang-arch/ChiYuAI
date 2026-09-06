# Lightfield 与 Semantica：智能体触发 / 决策联动 / 记忆知识调用 对比分析与借鉴方案

> 分析对象：Lightfield（https://lightfield.app/blog，AI-Native CRM）× Semantica（D:\system\reference\semantica-main，图原生决策智能基础设施）
> 目标：厘清两家「Agent 如何触发、如何与决策联动、何时调记忆/知识」，并给出对 CRM-ai-native 的可落地借鉴方案。
> 状态：纯分析与设计（设计先行 HARD-GATE，未写实现代码）。
> **姊妹篇（决策专题）**：`docs/2026-09-03-lightfield-semantica-decision-analysis.md` —— 聚焦「决策如何实现 / 准确性如何保障 / 决策如何跟踪」三问。本文覆盖触发与记忆知识，决策本体见姊妹篇。
>
> **⚠️ 已合并升级**：两份分析文档的可借鉴部分已去重合并为**设计方案** `docs/2026-09-03-cognitive-decision-loop-design.md`（9 组件 C1–C9 + 目标架构 + 实施路线）。**后续实施以该方案为准**，本文与姊妹篇退居为分析取证材料。合并时经代码级取证**推翻三项前序归因**（哈希链已建未通电 / policy_version 零写入 / 先例检索系算法结构性恒空而非数据真空），详见方案 §2。

---

## 0. 结论先行

| 维度 | Lightfield | Semantica |
|---|---|---|
| **触发模型** | **事件驱动自主**：CRM 对象 create/update 触发 Skill/任务 | **无自主触发器**：纯被调用 API（开发者/agent 主动调） |
| **Agent 自主度** | 高：自主执行 Skill、自动管理任务、后台任务 | 低：确定性基础设施，LLM 不参与图谱/推理/溯源 |
| **记忆模型** | **故事叙事**：live-updating 编年史关系故事，模型动态重加权 | **层级记忆**：短缓冲 + 长时向量 + KG，write-through，保留期 |
| **知识模型** | 结构化上下文层（ICP/竞品/异议/买家语言），Skill 运行时引用 | KG + 向量，GraphRAG 混合检索 |
| **决策联动** | 隐含在 Skill 内（如 Qualify 打 MEDDPICC 分），不可独立审计 | **显式**：record_decision + find_precedents_hybrid + causal_chain，强可溯源 |
| **记忆 vs 知识调用时机** | Knowledge=静态上下文；Memory=会话/历史 | retrieve() 自动路由：短缓冲→向量→KG 多跳扩展 |
| **可解释性** | 低（产品叙事） | 高（provenance + 因果链 + 审计） |

**对 CRM-ai-native 的核心借鉴（按 ROI）：**
1. **补事件触发层**（借 Lightfield）—— CRM 当前只有「被调用」路径（requireDecision fire-forget），缺「活」的编排层（领域对象事件→agent）。
2. **补决策先例混合检索 + 因果链**（借 Semantica）—— 正好闭合上轮发现的 `decision_relation` 未真写缺口。
3. **引入故事化记忆**（借 Lightfield）—— 供 account-insight 客户 360 视图。
4. **层级记忆 + 混合检索权重化**（借 Semantica）—— 质量增强，阈值配置化。

---

## 1. Lightfield 机制详解（含证据）

### 1.1 触发机制：事件驱动
- 博客 *Dark mode, workflow triggers, task management*（2026-01-30）：
  > "Workflows can now be triggered by creation or updates to objects in the CRM like meetings, tasks, and notes."
  > 例："when a meeting is scheduled, you can trigger the creation of an opportunity with 'stage' = 'intro meeting set'."
- *Task management*：AI 按可编辑指令自动创建/管理任务；Up next 可按 opportunity、deal amount 查看。
- *Lists, Background agent tasks*（2026-03-13）：后台 agent 任务。
- **本质**：领域对象事件 → 触发 Skill/工作流。这是「活」的编排层，区别于「被调用」基础设施。

### 1.2 决策联动：隐含在 Skill 内
- *It's time to put your CRM to work for you*（2026-04-08）预置 Skills 库：Build pipeline / Qualify Deal / Map Buying Committee / Find Next Best Action / Prep for Meeting / Draft Proposal / Draft Case Study。
- 决策是 Skill 的**输出**而非独立可审计实体：
  - **Qualify Deal**：按 MEDDPICC 或自定义框架打分 → gaps / risk flags / next steps。
  - **Find Next Best Action**：扫全 pipeline → 每单最高优先级动作 + 草稿消息。
- 无独立的决策溯源/先例/因果结构。

### 1.3 记忆与知识调用
- *How to use Skills & Knowledge*（2026-04-14）明确分离：
  - **Skill** = 执行（repeatable workflow，一致性）。三作用域：Workspace（Admin 共享）/ User（个人）/ System（平台维护）。
  - **Knowledge** = 结构化上下文层（ICP 定义、竞品定位、异议处理、买家语言、资格标准），**Skill 运行时引用**。
  - 判别测试：「给新人讲过 3 次的指令 = Skill；每次重复解释的公司背景 = Knowledge」。
- **记忆 = 故事叙事**（*LLMs also prefer stories to graphs and databases*，2026-02-20）：
  > "we dumped the classical graph and started building our data model of people and companies around stories."
  > "write live-updating chronological stories about people and your relationship with them, feeding them to models alongside all the structured and unstructured data."
  - 关键洞察：刚性图「把边抱太死」，无法表达人优先级/心态的**可塑性**；故事让模型动态重加权细节重要性（如 CISO 原说预算固定，被说服后改变）。用于 enterprise sales 的 50+ 关系导航。
- **复利效应**（*Building the CRM that works for you*）："The context graph gets better over time. Every captured interaction — email, meeting, transcript — sharpens Lightfield's understanding… Skills run better on month-three data than day-one data."

---

## 2. Semantica 机制详解（代码级证据）

### 2.1 触发机制：无自主触发器
- `agent_context.py` / `orchestrator.py` 全是被调用 API：`store()` / `retrieve()` / `record_decision()` / `find_precedents()` / `run_pipeline()`。
- 仓库内 `trigger|webhook|schedul|event_loop|on_create|subscribe|background_task` 命中项**全是数据摄取层**：`semantic_extract/event_detector.py`、`ingest/stream_ingestor.py`、`ingest/feed_ingestor.py` —— 喂 KG，**不是** agent 调度。
- 定位（README）："sits underneath your LLM… as a deterministic infrastructure layer: no LLM required for graph construction, reasoning, or provenance."

### 2.2 决策联动：显式 + 可溯源
- `record_decision(category, scenario, reasoning, outcome, confidence, entities, decision_maker)` → graph_store 或 context_graph 后端落库（`agent_context.py:1648`）。
- 决策连实体 + 跨系统上下文：`capture_cross_system_context`（`agent_context.py:1707`）。
- 先例混合检索：`find_precedents_hybrid` 语义+结构+向量，category 过滤，max_hops 多跳（`decision_methods.py:87` / `context_retriever.py:2241`）。
- 权重化先例：`retrieve_decision_precedents` 用 `semantic_weight=0.7 + structural_weight=0.3`（`context_retriever.py:1830`）。
- 因果链：`get_causal_chain` 上游(causes)/下游(effects)（`CausalChainAnalyzer`）。
- Provenance：`decision_recorder` 捕获完整上下文 + 跨系统上下文，每决策可审计。

### 2.3 记忆与知识调用
- **层级记忆**（`agent_memory.py`）：
  - Short-term buffer：最近 N 项，按 count（默认 10）+ token 裁剪（`_prune_short_term_memory`）。
  - Long-term vector store：持久语义。
  - Knowledge Graph：结构化（entities/relationships 写回）。
  - 三层 **write-through**（`store()` 顺序写短→长→图）；`retention_policy` 默认 30 天；Markdown 导出。
- **检索自动路由**（`agent_context.py:499 retrieve()`）：
  - 有 KG → **GraphRAG 混合**（graph expansion，`max_expansion_hops`）；否则 → 纯向量 RAG。`hybrid_alpha` 平衡向量(0)/图(1)。
- **邻近度加权**（`_apply_proximity_metadata`）：anchor node 距离 → `proximity_score = 1/hop`；`combined_score = (1-w)*score + w*proximity`。
- `AgentMemory.retrieve` 三段兜底：short_term → vector → keyword（`agent_memory.py:457`）。

---

## 3. 对比矩阵（速查）

| 维度 | Lightfield | Semantica | CRM-ai-native 现状 |
|---|---|---|---|
| 触发 | 领域事件（对象 create/update） | 无（被调用） | 仅被调用（requireDecision fire-forget）+ 定时泵 |
| 决策实体 | 无（Skill 输出） | 显式 Decision + provenance | 有（decision 表 + decision_id 主轴） |
| 先例检索 | 无 | hybrid 0.7/0.3 + 多跳 | 概念有 decision_relation，未真写 |
| 因果链 | 无 | get_causal_chain | 无 |
| 记忆 | 故事叙事 | 短/长/KG 层级 | memory_log 三层（L-User/Org/Workspace） |
| 知识 | 静态上下文层（Skill 引用） | KG + 向量 | 散落于 skill 描述/seed |
| 检索 | 未公开 | GraphRAG + 邻近加权 | assembleContextV2 7 源并行 |
| 可审计 | 低 | 高 | 中（决策有，先例/因果缺） |

---

## 4. 对 CRM-ai-native 的详细借鉴方案

### 4.0 现状对齐（已具备，可复用）
- 粒子图（entities/relationships）、决策系统（`requireDecision` / `decision_relation` / `memory_log`）。
- 编排层（`scheduler.routeThroughIntake` / `decision-agent` / `method-decision-enrich|execute`，上轮方案C 已落地）。
- 上下文装配（`assembleContextV2` 7 源并行）、记忆写回（`appendMemory` 分层+蒸馏）、`crm-memory-upsert` action。
- 事件总线雏形（`monitor_event` 已有 task/trace/approval/particle/payment 域）。

### 4.1 A. 事件触发层（借 Lightfield，补最大缺口）— 优先级最高
- **做法**：`routeThroughIntake` 增加 `event-*` intents；领域对象 create/update（meeting 排期 / deal stage 变更 / task 创建）→ 经 intake-router → 路由到 agent/Skill。
- **复用**：现有 `fire-forget dispatch` + `pumpReadyTasks` + `ensureTimers`；新增 `domain` 事件域到 `monitor_event`。
- **闭环价值**：把上轮「让编排层跑起来」从「决策触发」扩展到「领域事件触发」，形成真正活的编排。
- **铁律**：事件触发的 agent 同样过**第 0 闸**（写操作须 `decision_id`）。

### 4.2 B. 决策先例混合检索 + 因果链（借 Semantica，闭合 decision_relation 缺口）— ROI 最高
- **做法**：
  - `method-decision-enrich`（决策前）调用先例混合检索：`semantic 0.7 + structural 0.3 + max_hops 3`（映射 `retrieve_decision_precedents`）。
  - `method-decision-execute`（决策后）**真写** `decision_relation`（封装 `relation.js:48 linkDecisions`），并连 `causal_chain`。
- **阈值配置化**：混合权重/跳数走 `config_store['decision-precedent']`（遵守阈值配置化铁律）。
- **正好闭合**：上轮 `decision_relation` 描述诚实化后留下的真实闭环缺口。

### 4.3 C. 层级记忆 + 保留期（借 Semantica `agent_memory`）
- **做法**：新增 short-term buffer（recent N 交互，token 裁剪）作为 `appendMemory` 热层，再蒸馏进 L-User/L-Org/L-Workspace 长期层。
- **复用**：`crm-memory-upsert` 已有 `ttlDays` → 映射 `retention_policy`。强化 `appendMemory` 已有蒸馏逻辑。

### 4.4 D. 混合检索 + 图扩展（借 Semantica `retrieve`）
- **做法**：`assembleContextV2` 7 源并行 → 加 `hybrid_alpha`（向量 vs 图权重）+ `max_expansion_hops`（多跳图扩展）+ anchor-node 邻近加权。
- **阈值配置化**：权重走 `config_store`。
- **对症**：解决「S2 先例检索 0 hit」类供给缺口的检索侧。

### 4.5 E. 故事化记忆（借 Lightfield）
- **做法**：`account-insight.html`（已在进行）以「编年史关系故事」为主视图：live-updating 客户/商机关系叙事 + 结构化粒子作支撑，模型动态重加权。
- **技术**：从 `memory_log` + `particles` 合成 narrative（j_judge 或模板），非刚性图遍历。

### 4.6 F. 知识 / 记忆清晰分离（借 Lightfield Skills/Knowledge）
- **做法**：定义 **Knowledge 层**（静态上下文：ICP/资格标准/异议库/行业 know-how，3-scope workspace/user/system），method-* skill 引用；**Memory 层**（动态交互）由 `appendMemory` 写回。
- **对症**：当前 CRM 知识散落于 skill 描述/seed，借 Lightfield 模式归并治理。

### 4.7 G. 复利效应（两者共有）
- **做法**：每次交互 → write-through `memory_log` + 决策先例 → 喂养 enrich 步 → 越用越准。
- **指标**：`auditability_pct`（21% 真空已通过 `crm-memory-upsert` 闭合）；新增「先例命中率 / 因果链密度」。

---

## 5. 实施路线（分阶，遵守 HARD-GATE：设计先行，未批准不写实现）

- **阶段 0（设计）**：本分析 → 细化设计文档 → 用户批准。
- **阶段 1（A 事件触发层）**：最小可行，接住「活编排」，ROI 最高。
- **阶段 2（B 决策先例 + 因果链）**：闭合 `decision_relation`，强可审计。
- **阶段 3（C 层级记忆 + D 混合检索）**：记忆/检索质量。
- **阶段 4（E 故事化 + F 知识分离）**：UX 与治理。
- 每 Task 一 commit；**AI 不代 commit**（沙箱无私有库凭证）。

## 6. 风险提示
- 写操作必经**第 0 闸**（`decision_id`）；事件触发层派发的 agent 同样过闸。
- **绝对禁 DELETE**；知识/记忆追加走 merge/append/软合并。
- 阈值**配置化**，禁硬编码。
- Lightfield/Semantica 作**中性跨域方法论示例**，不写入 10 大 `ai-*` SKILL（避免领域污染）；本分析落项目 docs。
