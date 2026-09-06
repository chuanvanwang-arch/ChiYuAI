# Lightfield × Semantica 决策专题：决策如何实现 · 准确性如何保障 · 决策如何跟踪

> 本文是《2026-09-03-lightfield-semantica-trigger-analysis.md》（触发/联动/记忆）的**决策专题补充篇**，三问：
> **① 决策如何实现 ② 决策准确性如何保障 ③ 决策如何被跟踪**。
> 信息源：Lightfield 官方博客（在线，含日期）+ Semantica 源码 `D:\system\reference\semantica-main`（file:line 级证据）。
> 状态：纯设计分析（HARD-GATE 设计先行，未写实现代码）。
>
> **⚠️ 已合并升级**：本文与触发篇的可借鉴部分已去重合并为**设计方案** `docs/2026-09-03-cognitive-decision-loop-design.md`（9 组件 C1–C9）。**后续实施以该方案为准**，本文退居为分析取证材料。
> 合并时经代码级取证**推翻三项前序归因**，本文 H1–H3 的性质因此改变：
> - **H1 哈希链** → C2：代码已完备（`provenance.js:37/44/61`），但 `ensureProvenanceSchema()` 生产 0 调用、DDL 未入 `schema.sql` → 9 处 `trackEntry` **恒抛 relation does not exist**；`verifyChain` **0 调用**。是**通电**而非新建。
> - **H2 版本固化** → C3：`policy_version` 表(`schema.sql:139`)+列(`:156`)+索引(`:232`) **全在**，但写入点 **0**，`requireDecision` 取 `opts.policy_version||null`，18 处生产调用无一传 → **恒 null**。是**接线**而非新建。
> - **H3 先例检索** → C4：`hashVector` 系 SHA-256→384 桶哈希签名（非语义向量），实验 cos 逐字 1.0 / 仅 id 与金额不同 **0.1146** / 200 次微变采样过 0.6 闸 **1/200**（且与自身比）。**推翻本文"S2 0 hit = 数据真空"归因**——即便灌满 L0 原料仍恒空，须**先换算法再灌数据**；权重亦不可照抄 Semantica 向量 0.7。

---

## 0. 三问结论先行

| 问题 | Lightfield（产品级 AI CRM） | Semantica（图原生决策基础设施） |
|---|---|---|
| **① 决策如何实现** | **决策 = Skill 的输出**。无独立决策实体：Qualify Deal 打 MEDDPICC 分、Find Next Best Action 出推荐动作。决策链靠 **Skill 串联**（前一步输出 = 后一步输入） | **决策 = 一等公民实体**。`Decision` dataclass（category/scenario/reasoning/outcome/confidence/decision_maker）+ 落图一条流水线：record → link_entities → apply_policies → exception → approval → precedents → provenance |
| **② 准确性如何保障** | **四道**：Knowledge 前置定义 → 输出契约约束（逐字引用+阈值）→ HITL（Suggested Updates / For review 队列）→ 确定性兜底（"running code when a task needs to be exact"） | **五道**：confidence 强校验(0–1) → 先例四分量加权检索 → **策略版本固化** → 上下文冻结快照 → 确定性基础设施（no LLM for graph/reasoning/provenance） |
| **③ 决策如何跟踪** | **字段级**：field value history + activity log + Dashboards(可下钻)。**无决策级审计链、无置信度追踪** | **决策级四层**：哈希链不可变事件（SHA-256 串联）→ provenance checksum 链 → trace_decision_path 可解释路径 → get_decision_statistics 指标 |
| **共同缺口** | 两家都**没有「决策结果回填 → 校准」闭环**（Semantica `calibration/actual_outcome/feedback` 在 context 目录 0 命中） | 同左 |

**对 CRM-ai-native 的判断（反直觉但重要）**：
- **跟踪层**：Semantica 远强于我们（哈希链 + 防篡改），CRM 目前决策表有 `decision_id` 主轴但**无可验证的不可变审计链** → **最大借鉴点**。
- **准确性层**：CRM 的 `src/calibration/*`（knobs/autoSuggest/replayDims/sampleLoader）**反而比两家都完整**——两家都无校准回路，我们有。短板是「先例检索 0 hit」（S2）与「策略版本未固化」。
- **HITL 层**：Lightfield 的 **For review 队列 + 内联显示来源**是我们缺的产品形态（我们有第 0 闸，但缺"草稿 → 人审 → 编辑/发送/驳回"的表面）。

---

# 第一部分 · Semantica：决策如何实现

## 1.1 决策数据模型（六张牌，缺一不可）

`semantica/context/decision_models.py` 定义了决策域的完整数据模型，这是整个决策系统的骨架：

| 模型 | 位置 | 关键字段 | 设计意图 |
|---|---|---|---|
| **Decision** | :87-136 | `category` / `scenario` / `reasoning` / `outcome` / **`confidence`** / `decision_maker` / `reasoning_embedding` + **`node2vec_embedding`** / `valid_from`~`valid_until` | 语义嵌入 + **结构嵌入**双轨；时间有效性（决策会过期） |
| **DecisionContext** | :140-171 | `entity_snapshots` / **`risk_factors`** / `cross_system_inputs` | **决策时刻上下文冻结**（防事后漂移） |
| **Policy** | :175-215 | `rules` / `category` / **`version`** / `created_at` / `updated_at` | 策略**版本化** |
| **PolicyException** | :219-256 | `policy_id` / `reason` / **`approver`** / `justification` | 例外必须有人背书 + 理由 |
| **Precedent** | :260-294 | `source_decision_id` / **`similarity_score`(0–1)** / `relationship_type` ∈ {`similar_scenario`, `same_policy`, `exception_precedent`} | 先例关系**分型**（不是单一"相似"） |
| **ApprovalChain** | :298-336 | `approver` / `approval_method` ∈ {`slack_dm`, `zoom_call`, `email`, `system`} / `approval_context` | 审批来源可区分（人 vs 系统） |

**强校验即准确性第一道闸**（非软约定，是构造时抛错）：
```python
# decision_models.py:110-111
if not 0 <= self.confidence <= 1:
    raise ValueError("Confidence must be between 0 and 1")
# decision_models.py:275-279 similarity_score 同样 0–1 校验 + relationship_type 白名单校验
```

## 1.2 决策落库流水线：一次 record_decision 到底做了什么

`decision_recorder.py` 的 `record_decision`（:115-154）是决策的**唯一入口**，顺序固定：

```
1. 生成 reasoning embedding（若无）  → :134-137   "决策即索引"，落库时就能被语义检索
2. _store_decision_node(decision)    → :140       写入图节点
3. link_entities(...)                → :143       (d)-[:ABOUT]->(e) 连实体
4. _track_decision_provenance(...)   → :146-147   挂溯源
5. 结构化日志：Actor/Timestamp/Outcome/Category  → :149
```

**关键设计：`apply_policies` 固化策略版本**（:190-269）——这是准确性的核心机关：
```python
# :226-238
MATCH (d:Decision {decision_id: $decision_id})
MATCH (p:Policy  {policy_id:   $policy_id})
WHERE $policy_version IS NULL OR p.version = $policy_version
WITH d, p ORDER BY p.updated_at DESC, p.version DESC LIMIT 1
MERGE (d)-[r:APPLIED_POLICY]->(p)
SET r.policy_id = $policy_id,
    r.policy_version = p.version,   # ← 决策时锁定版本，事后策略改版不影响历史判定
```
- 调用方**可显式指定版本** `{policy_id, version}`；不指定则取最新（legacy 兼容）。
- 匹配不到策略时**只 warning 不抛错**（:259-262）——fail-open，但留下告警痕迹。

## 1.3 完整决策轨迹捕获：capture_decision_trace

`decision_methods.py:218-385` 把上面各步编排成**一次事务性轨迹捕获**，并产生 **6 类事件**：

| 事件类型 | 触发条件 | 载荷要点 |
|---|---|---|
| `DECISION_RECORDED` | 总是 | decision_id/category/outcome/confidence/decision_maker/entities/source_documents |
| `CROSS_SYSTEM_CONTEXT_CAPTURED` | 有跨系统上下文 | systems 列表 |
| `POLICIES_APPLIED` | 有 policy_refs | policy_ids + applied_policies(含版本) |
| `EXCEPTIONS_RECORDED` | 有例外 | exception_ids |
| `APPROVAL_CHAIN_RECORDED` | 有审批 | approvers + methods |
| `PRECEDENTS_LINKED` | 有先例 | precedent_ids |

> **注意一个诚实的边界**（:253-271）：若调用方未传 `graph_store`，函数**不落库**，只打一条 `mode=backward_compatible_non_persistent` 的 warning 日志就返回 decision_id。
> 即：**没有图后端时，"决策被记录"是假的**（日志有、数据无）。这是典型的"日志级假绿"，我们在 CRM 落地时必须避免（对应 CRM 铁律：禁裸 catch + 多出口断言带出口标识）。

---

# 第二部分 · Semantica：准确性如何保障（五道闸）

## 2.1 闸一：confidence 自报 + 强类型校验
`confidence ∈ [0,1]` 由**调用方（人或 LLM）自报**，Semantica **不负责生成**置信度——它只校验、存储、并在统计中聚合（`get_decision_statistics` 输出 `average_confidence`，:813）。
> **判据**：Semantica 的准确性责任边界是「**可追溯 + 一致性**」，不是「**判断对不对**」。正确性外包给调用方。

## 2.2 闸二：先例检索四分量加权（准确性真正的发动机）
`decision_query.py:_calculate_combined_similarity`（:1043-1069）：

```
score = w.semantic   × vector_sim          # 向量库相似度
      + w.text       × text_sim            # Jaccard 词重叠（:1071-1077）
      + w.category   × category_sim        # 同类目 1.0 / 否则 0.0（硬门槛）
      + w.structural × structural_sim      # Node2Vec 结构相似（:1079-1099）
```
- **权重必须归一**（:1001-1002）：`abs(semantic_weight + structural_weight - 1.0) > 1e-6` → `raise ValueError("Weights must sum to 1.0")`。
- 前一轮文档记录的 `retrieve_decision_precedents` 用 `semantic 0.7 / structural 0.3`，是这四分量在 context_retriever 里的具体取值。
- **中心性加权**（:1101-1124 `_get_centrality_boost`）：取决策子图（max_depth=2）的 degree centrality 作为排序增益并**缓存**——被引用/连接越多的先例排名越靠前。语义上等价于「**被反复验证过的先例更可信**」。

## 2.3 闸三：策略版本固化 + 合规可复查
- 落库时 `r.policy_version` 固化（见 1.2）。
- `check_decision_compliance`（:698-752）随时可复查：返回 `is_compliant` + `decision_confidence` + `compliance_check_timestamp`，并回填 `record_policy_application`。
- 策略侧另有 `get_policy_history`（policy_engine.py:528）、`analyze_policy_impact`（:711）——**策略改版能反查影响哪些历史决策**。

## 2.4 闸四：决策时刻上下文冻结
`DecisionContext`（decision_models.py:140-166）在决策时保存 `entity_snapshots`（实体当时快照）+ `risk_factors` + `cross_system_inputs`。
> 为什么重要：三个月后复盘"当时为什么批这个折扣"，如果实体状态已变（客户已被降级、金额已回款），没快照就无法重建决策依据。**先例可被信任的前提是先例可被复现**。

## 2.5 闸五：确定性基础设施（架构级准确性）
README 定位：*"no LLM required for graph construction, reasoning, or provenance"*。
图构建、推理引擎（`semantica/reasoning/` 下 datalog/deductive/abductive/sparql/rete 五种确定性推理机）、溯源全部确定性 → **同一输入必得同一输出**，消除 LLM 非确定性对准确性的侵蚀。

## 2.6 Semantica 准确性的真实缺口（诚实标注）
- **无结果回填 / 无校准回路**：在 `semantica/context/` 全目录 grep `actual_outcome|calibrat|outcome_feedback|effectiveness` → **0 命中**。`outcome` 只在落库时写入，事后不更新、不对照。
- **confidence 无后验校正**：自报多少就是多少，永远不会被"实际结果"打脸或修正。
- **结论**：Semantica 的"准确性"= **过程可复现 + 可追溯**，**不是**"预测更准"。

---

# 第三部分 · Semantica：决策如何跟踪（四层，最值得抄）

## 3.1 第一层：哈希链不可变事件（核心中的核心）

`decision_methods.py:388-481 _append_immutable_trace_events` —— 区块链式审计链：

```python
# :435-438  哈希输入串联上一事件哈希
hash_input = f"{decision_id}|{next_index}|{event_type}|{event_timestamp}|{payload_json}|{previous_hash}"
event_hash = hashlib.sha256(hash_input.encode("utf-8")).hexdigest()

# :440-465  写 DecisionTraceEvent 节点（含 previous_hash / event_hash）+ (d)-[:HAS_TRACE_EVENT]->(t)
# :467-475  再用 (prev)-[:NEXT_TRACE_EVENT]->(curr) 把事件串成链
```
- **链式续写**：先查最新事件（`ORDER BY event_index DESC LIMIT 1`）取 `previous_hash` 与 `next_index`，查失败则**开新链**并 warning（:419-427）——不静默丢弃。
- **删除可检测**：整行删除会让它后继者的 `previous_hash` 对不上 → 链断 → 篡改暴露。
- 事件类型即 1.3 的 6 类，覆盖决策全生命周期。

## 3.2 第二层：provenance 全局校验和链

`semantica/provenance/integrity.py:27-116 compute_checksum` —— 每条 provenance 条目 SHA-256，哈希字段包含：
`entity_type / activity_id / agent_id / agent_type / source_document / timestamp / confidence / parent_entity_id / previous_version_id / derived_from_id / used_entities / previous_checksum / invalidated*`

两个**极具借鉴价值的设计权衡**（源码注释里写明了理由）：
1. **哈希里包含 `previous_checksum`**（issue #825）：单行校验和只能证明"这行没被改"，加上前驱哈希后，**整行删除会断链**，从而可检测删除（不只是篡改）。
2. **故意排除 `entity_id`**（:45-51）：因为 `track_entity()` 的版本化机制会把旧值"改名"存档（如 `X` → `X:v:...`），若 entity_id 入哈希，合法重命名会被误判为断链（假阳性）。
> **教训**：防篡改链的设计难点不在"怎么算哈希"，而在"**哪些字段该进、哪些不该进**"。抄之前必须先定好这个白名单。

另有 `verify_checksum`（:119-150）/ `verify_data_checksum`（:171）/ `verify_dict_checksum`（:217）三档验证入口。

## 3.3 第三层：可解释性查询与路径追踪

| 能力 | 位置 | 说明 |
|---|---|---|
| `find_by_category` / `find_by_entity` / `find_by_time_range` | :414 / :475 / :543 | 三个正交检索维度 |
| **`trace_decision_path`** | :738-840 | **BFS 路径追踪**（max_depth=5，环路防护），返回 `path_length/nodes/relationships` 并按长度排序 —— 直接服务"这个决策为什么这么定"的可解释性 |
| `analyze_decision_influence` | :1146 | 决策影响力分析 |
| `predict_decision_relationships` | :1262 | 预测决策间关系（补充漏连的边） |
| `multi_hop_reasoning` | :634 | 多跳推理 |
| `find_similar_exceptions` | :842 | 相似**例外**检索（例外的例外，最易出风险的地方） |

> ContextGraph 与图数据库**双实现**并存（:754-807 是 ContextGraph 的 BFS 版，:809-836 是 Cypher 版）——同一语义两条路径，值得注意其一致性风险。

## 3.4 第四层：决策统计指标（跟踪的仪表盘语义）

`decision_methods.py:755-837 get_decision_statistics` 输出：
```
total_decisions / categories{} / outcomes{} / average_confidence / date_range{start,end} / filters_applied
```
> 极简但抓住了要害：**总量 + 分布 + 平均置信度 + 时间窗**。对照 CRM 的 `auditability_pct` 是同层指标，可并列。

---

# 第四部分 · Lightfield：决策如何实现

## 4.1 决策 = Skill 的输出，且靠**技能链**逐层收敛

Lightfield **没有独立决策实体**。决策藏在 Skill 里（Qualify Deal 按 MEDDPICC 打分 → gaps/risk flags/next steps；Find Next Best Action 扫 pipeline → 每单最高优先级动作）。

真正的"决策架构"体现在 **Four Skills 链**（2026-04-30 博客）——**前一步的结构化输出是后一步的输入**：

| 步 | Skill | 决策动作 | 输出契约 |
|---|---|---|---|
| 1 | **Objection Pattern Library** | 扫全量商机的通话/邮件/会议纪要 → **抽取并归主题** | 主题排名表 + **首次出现阶段** + **每条逐字原文例证** |
| 2 | **Messaging Gap Identifier** | 判定公开内容**是否覆盖**该异议 | 覆盖度三态（yes / partially / no）+ 页面出处 + 一行建议 |
| 3 | **Objection-Stage-Persona Mapper** | 交叉阶段×角色×金额 → **判定哪些组合是真模式** | 矩阵 + **"出现在 ≥3 个商机"才标记** |
| 4 | **Counter-Playbook Generator** | 从 **closed-won** 里找该异议**之后发生了什么** | 每个异议一张应对卡（2–3 个赢单做法 + 内容 + 逐字示例） |

> 这是一条**"经验 → 证据 → 模式 → 打法"**的决策链，本质是把"老销售的模式识别"外化成可复用 Skill 链。

## 4.2 触发：对象/关系变更即触发决策

- 2026-01-30：*"Workflows can now be triggered by creation or updates to objects in the CRM like meetings, tasks, and notes."*
- 2026-08-07：*"Automations can now be triggered with any relationship change between objects supported in the API."* → 从**对象事件**扩展到**关系事件**。

---

# 第五部分 · Lightfield：准确性如何保障（四道闸）

## 5.1 闸一：Knowledge 前置定义（把判据写死在执行前）

Four Skills 每步都有 Pro-tip 强调**先定义后执行**：
> *"Define your deal stages in Knowledge before running this. Even simple stage names ('discovery / technical eval / procurement') give the skill enough context to surface when objections shift across your process."*
> *"Add your contact role definitions to Knowledge before running this. If your deals include 'VP Finance,' 'CFO,' and 'Head of Finance' as separate roles, the skill will split one pattern into three rows and dilute the signal."*

**机制本质**：不先定义口径 → 模型把同一模式拆成多行 → **信号被稀释**。Knowledge 是**判据的单一事实源**，Skill 运行时引用。

## 5.2 闸二：输出契约约束（用"逐字引用 + 数值阈值"压制幻觉）

注意 Four Skills prompt 里的强制要求：
- *"pull **one verbatim example** from the actual notes"* → 每条结论必须挂**原文证据**
- *"Flag any combination that appears in **3 or more deals**"* → **量化阈值**判定，不让模型凭感觉
- *"Output: **a ranked table** of objection themes with frequency, stage of first appearance, and one verbatim example per theme."* → **结构化输出**（表格/矩阵/卡片），不是自由文本
- *"Run it against active deals and **closed-lost from the last 90 days**"* / *"If you have fewer than ten won deals, include **partial wins**"* → **样本范围与样本量下限**显式约束

> 这正是 Oleg/Lightfield 一脉的"**无证据不出结论**"：让 LLM 的结论**自带可核验锚点**。

## 5.3 闸三：HITL 三层（Lightfield 治理的精髓）

| 机制 | 时间 | 形态 | 原文 |
|---|---|---|---|
| **Suggested Record Updates** | 2025-11-14 | AI 提议字段更新，人 accept/reject，**内联显示新值来源** | *"You can see the source of the new value in-line as you accept or reject each suggestion."* |
| **For review 队列** | 2026-06-12 | 自动化先起草 → 指派审阅人 → 落入队列供 **edit / send / dismiss** | *"A automation can draft work and route it to a person to approve first... it lands in their For review queue to edit, send, or dismiss."* |
| **权限开关** | 2026-07-10 | HTTP 工具权限 **Auto-approving / Asking every time** | *"Added a setting for Auto-approving or Asking every time for HTTP request permissions"* |

**并且 HITL 是可关闭的**（2026-04-17）：*"You can now have Lightfield automatically populate and update record fields **without requiring human-in-the-loop intervention**."*
→ **治理粒度是"按动作类型可配置"，不是一刀切**。这与我们 CRM 的"第 0 闸强制 decision_id"是不同层：我们卡的是**写权限凭据**，Lightfield 卡的是**写动作是否需人审**。两者应叠加而非二选一。

## 5.4 闸四：确定性兜底 + 数据复利

- **确定性兜底**（2026-06-12）：*"doing everything it does in chat from open-ended research and CRM updates to **running code when a task needs to be exact**."* → 该精确的环节**不交给 LLM，交给代码**。与 Semantica 的确定性基础设施异曲同工。
- **能力复利**（2026-05-07）：*"The context graph gets better over time... Skills run better on **month-three data** than day-one data."*

## 5.5 Lightfield 准确性的真实缺口（诚实标注）
- **无置信度**：Skill 输出不带 confidence，打分（MEDDPICC）是框架分而非概率。
- **无决策级审计链**：跟踪止于**字段级**（field value history + activity log，2026-07-10）与**看板**（Dashboards + drill-down，2026-08-07），**没有决策轨迹哈希链、没有策略版本固化、没有先例因果链**。
- 其自评框架（2026-01-23 *founder's guide*）五试是**选型标准**（capture / synthesis / why / query / action），**不是运行期准确性度量**。

---

# 第六部分 · 三问对照矩阵（速查）

| 维度 | Lightfield | Semantica | **CRM-ai-native 现状** | 差距判定 |
|---|---|---|---|---|
| 决策实体 | 无（Skill 输出） | **一等公民 + 6 模型** | 有 `decision` 表 + `decision_id` 主轴 | 持平偏弱（缺 DecisionContext 冻结） |
| 决策流水线 | Skill 链（4 步） | record→link→policy→exception→approval→precedent→provenance | `requireDecision` → enrich/execute 双 Agent | 持平（形态不同） |
| 置信度 | 无 | **自报 + 0–1 强校验** | 九尺子评分 + `rubric.pass_line` + 自主放行阈值 ≥0.8 | **我们更强**（有评分不只有校验） |
| 先例检索 | 无 | **四分量加权 + 中心性** | 概念有 `decision_relation`，**S2 检索 0 hit** | **明显落后** |
| 策略版本固化 | 无 | **APPLIED_POLICY.policy_version** | 阈值走 config_store，**未与决策实例绑定版本** | **落后**（易被改配置洗掉历史判定） |
| 上下文冻结 | 无 | **entity_snapshots + risk_factors** | 有 `decision_context_snapshot.dim_coverage` | 接近（覆盖率 semantics/governance/history = 0） |
| 不可变审计链 | 无 | **SHA-256 哈希链 + checksum 链** | 有 `monitor_event` / `decision_event`，**无哈希链** | **明显落后（最大借鉴点）** |
| 可解释路径 | 无 | `trace_decision_path` BFS depth5 | 有 `decision_trace` / 自检卡 7 问 | 接近（缺图路径追踪） |
| 跟踪指标 | Dashboards 下钻 | total/outcomes/**average_confidence** | `auditability_pct` 等 | 持平 |
| HITL | **For review 队列 + 内联来源 + 权限开关** | 无（ApprovalChain 仅记录） | 第 0 闸（decision_id）+ 升级人工 | **形态落后**（有闸无队列） |
| **结果回填/校准** | **无** | **无** | **有** `src/calibration/*` + `decision_outcome` | **我们领先（唯一领先项）** |

---

# 第七部分 · 对 CRM-ai-native 的借鉴方案（7 项，按 ROI 排序）

> 全部遵守：阈值走 `config_store` 配置化、写经第 0 闸、禁 DELETE、不改 10 大 `ai-*` SKILL（外部案例仅作中性跨域示例，落项目 docs）。

### H1（P0，ROI 最高）决策轨迹哈希链 —— 借 Semantica `_append_immutable_trace_events`
- **缺口**：决策可查但**不可证未篡改**；`monitor_event` 是流水日志，删一条无感知。
- **做法**：决策事件表增加 `event_index / prev_hash / event_hash`（SHA-256，输入含 `decision_id|index|type|ts|payload|prev_hash`），写时链式续写；提供 `verifyDecisionChain(decision_id)` 校验接口。
- **事件类型映射**（对齐 Semantica 6 类）：`DECISION_RECORDED` / `CONTEXT_CAPTURED` / `POLICIES_APPLIED` / `EXCEPTIONS_RECORDED` / `APPROVAL_RECORDED` / `PRECEDENTS_LINKED`。
- **必须预先定死哈希字段白名单**（抄 integrity.py:45-51 的教训）：建议进哈希 = decision_id/index/type/timestamp/payload_json/prev_hash/actor；**不进** = 自增主键、软删除标记、可重算的派生字段（避免合法变更被误判断链）。
- **验收**：删中间一行 → 校验返回断链位置；改 payload → 校验失败；正常追加 → 链完整。

### H2（P0）策略/阈值版本固化 —— 借 Semantica `apply_policies`
- **缺口**：阈值改了之后，历史决策无法回答"当年按哪版规则批的"。
- **做法**：决策落库时把当次生效的阈值快照（`config_store` 版本/取值）写入决策行（建议 `decision.threshold_version` 或 `trigger_context` 内固化）。
- **验收**：改阈值后重算历史决策 → 结论可不同，但**原决策记录仍指向旧版本**。

### H3（P0）先例四分量加权检索 + 中心性 —— 借 Semantica `_calculate_combined_similarity`
- **缺口**：S2 先例检索 0 hit（`assembleContextV2` 侧）；即便有数据也缺排序质量。
- **做法**：先例打分 = `w_semantic×向量 + w_text×词重叠 + w_category×同类目(0/1) + w_structural×结构相似`，权重**归一强校验**（和不为 1 直接抛错）；排序叠加**图中心性增益**（被引用多的先例更可信），带缓存。
- **阈值配置化**：权重/跳数/top_k 走 `config_store['decision-precedent']`，禁硬编码。
- **验收**：先例命中率 > 0，且同类目先例稳定排在异类目之前。

### H4（P1）For review 审核队列 —— 借 Lightfield
- **缺口**：我们有第 0 闸（写必须带 decision_id）与升级人工，但**缺"草稿 → 人审 → 编辑/放行/驳回"的产品表面**。
- **做法**：agent 输出（客户回复草稿、商机推进建议、折扣建议）以 **draft** 态落库并指派审阅人；审阅面支持 **编辑 / 放行 / 驳回**三动作，且**内联显示每个建议值的来源**（对应 Lightfield "see the source of the new value in-line"）。
- **治理开关**：按动作类型配置 `auto_approve | ask_every_time`（对齐 Lightfield 权限开关），**但第 0 闸不因 auto_approve 而跳过**——decision_id 仍强制。
- **验收**：AI 生成的对外文案 100% 经队列，未过审不可发出。

### H5（P1）输出契约：逐字引用 + 量化阈值 —— 借 Lightfield Four Skills
- **缺口**：`j_judge` 步骤当前是自由文本 prompt，结论无证据锚点、无样本量下限。
- **做法**：method-* 的 j_judge 步骤统一要求三段式输出：① 结论 ② **逐字证据**（引用原文/记录 id）③ **量化依据**（出现次数 ≥ N、样本窗口 ≤ 90 天、样本量下限）。
- **验收**：无证据的结论判为 `degraded` 而非 `done`（对齐"无假绿"铁律；当前 `executeSkill` 的 j_judge 在 LLM 不可用时降级为 `{degraded:true}`，应扩展为"证据不足也降级"）。

### H6（P1）决策上下文冻结快照 —— 借 Semantica `DecisionContext`
- **缺口**：`decision_context_snapshot.dim_coverage` 显示 semantics / governance / decision_history **三维为 0**。
- **做法**：决策落库时冻结 `entity_snapshots`（涉及实体的当时状态）+ `risk_factors` + `cross_system_inputs`。
- **验收**：三个月后复盘可 100% 重建当时依据，不依赖实体当前状态。

### H7（P2，我们领先项做实）结果回填 + 校准闭环
- **现实**：两家都无；我们已有 `src/calibration/*`（knobs/autoSuggest/replayDims/sampleLoader）+ `decision_outcome`。
- **做法**：把决策 → 实际结果回填 → 反哺阈值/权重/先例权重做成**确定性闭环**，并对齐 Semantica 的 `average_confidence` 增加**校准后置信度**指标（预测置信度 vs 实际兑现率）。
- **验收**：可给出"预测 0.85 的商机实际赢率"这类对照曲线——这是两家都给不出的东西，是我们的差异化。

---

# 第八部分 · 实施路线与铁律

- **阶段 P0**：H1 哈希链 → H2 版本固化 → H3 先例加权（闭合审计 + 先例 0 hit 双缺口）。
- **阶段 P1**：H4 For review 队列 → H5 输出契约 → H6 上下文冻结。
- **阶段 P2**：H7 校准闭环做实（差异化）。
- **每 Task 一 commit；AI 不代 commit（沙箱无私有库凭证）**。
- **铁律**：写操作必经第 0 闸（`decision_id`）；**绝对禁 DELETE**（去重走软合并 `meta.merged_into`）；阈值配置化禁硬编码；禁裸 `.catch(()=>{})`（fail-safe 须 emit trace + recordFailure）；后台派发保留 `VITEST` 隔离护栏。
- **不污染 SKILL**：Lightfield / Semantica 仅作中性跨域方法论示例，内容落本项目 `docs/`，不写入 10 大 `ai-*` SKILL。

---

## 附：本文证据索引

| 结论 | 证据 |
|---|---|
| 决策六模型 + 0–1 强校验 | `semantica/context/decision_models.py:87/140/175/219/260/298`，校验 :110-111, :275-279 |
| 落库流水线 | `decision_recorder.py:115-154`；策略版本固化 :226-238；无匹配仅告警 :259-262 |
| 6 类 trace 事件 + 无图后端不落库 | `decision_methods.py:287-378`；warning 分支 :253-271 |
| 哈希链 | `decision_methods.py:435-438`（哈希输入），:440-465（写节点），:467-475（NEXT_TRACE_EVENT 链） |
| 先例四分量 + 归一强校验 + 中心性 | `decision_query.py:1043-1069`；:1001-1002；:1101-1124 |
| 路径追踪 | `decision_query.py:738-840`（BFS max_depth=5） |
| 统计指标 | `decision_methods.py:755-837`（average_confidence :813） |
| 合规复查 | `decision_methods.py:698-752`；`policy_engine.py:378/528/711` |
| checksum 链 + 排除 entity_id 的权衡 | `provenance/integrity.py:27-116`（含 :34-51 设计注释），:119-150 |
| 无校准回路 | `semantica/context/` 全目录 grep `calibrat\|actual_outcome\|outcome_feedback\|effectiveness` → 0 命中 |
| Lightfield 决策链 | blog 2026-04-30 *Four Skills to turn Objections into Opportunities* |
| Lightfield HITL | 2025-11-14 Suggested Record Updates；2026-06-12 For review / running code when a task needs to be exact；2026-04-17 可关闭 HITL；2026-07-10 权限开关 |
| Lightfield 触发 | 2026-01-30 对象事件；2026-08-07 关系变更触发 |
| Lightfield 跟踪 | 2026-07-10 field value history + activity log；2026-08-07 Dashboards + drill-down |
| Lightfield 选型五试（非运行期度量） | 2026-01-23 *The founder's guide to evaluating an AI CRM* |
