> ⛔ **已合并 / 已归档（2026-09-02）**
> 本文已并入 **`docs/2026-09-02-cognitive-decision-unified-design.md`**（认知驱动决策子系统 · 统一设计 v3）。本文是合并文档的**主干来源**（八要素映射 / 九尺子信号源 / Pre-In-Post / 复盘三通道均被采纳）。
> 本文**仅作历史留档**，一切以合并文档为准。重评修正点：①九尺子 LLM 项由 3 收紧为 1（§1.3 已预见，合并文档定为 8+1）②§5.2 `required_dims` 初值与销售自检实例化文档冲突，已统一裁定（合并文档 §7.2）③实施顺序重排：**新增 P-1 供给层复通 + P0 L0 原料层**，原 D 层/九尺子降为 P1。
> 本文新发现的 F1（装配在写后）、F2（知识层零调用）、F3（向量非语义）、F4（双轨并行）**全部成立并已并入**，其中 F4 升为 P-1 T4。

# 决策—记忆—知识三层贯通 · 详细定义规格

> 输入：《人类知识、记忆与决策的关系》（八要素 / 九尺子 / 闭环）、《# 2B销售全流程决策自检框架》（七阶段）
> 上游：`docs/2026-09-02-cognitive-architecture-redesign.md`（K-M-D 三层 v2）、`docs/2026-09-02-sales-decision-selfcheck-instantiation.md`（领域实例化）
> 本文件定位：**把"三层贯通"从架构意图落成字段级、调用点级、时点级的可执行定义**
> 状态：**设计稿，未实施**（按铁律，批准前不写实现代码）
> 生产库基准：`crm_native`（PG 5433），所有行数均为 2026-09-02 实测

---

## §0 执行摘要

本轮按用户的三个问题逐项落地定义，过程中查出**三个此前未被发现的硬事实**，其中第一条推翻了上游设计的一个隐含前提。

| # | 发现 | 证据 | 影响 |
|---|---|---|---|
| **F1** | **7×7 装配发生在决策落库之后**，不是之前 | `decisionRepo.js:107` 位于 `INSERT INTO decision`(:83) 之后，注释原文"决策落库后自动装配" | 用户诉求①"记忆+知识**驱动**决策"在当前架构下**不成立**——它是事后解释，不是事前驱动 |
| **F2** | **知识层已存在且未被使用** | `methodology_template` 11 行、`methodology_dimension` 34 行（带 `weight`+`required`），但**从未在决策前注入** | 八要素「概念」不是缺数据，是缺注入通道；补通道即可，无需新建知识库 |
| **F3** | **向量是非语义的** | `ontology/embedding.js:8` `hashVector` = sha256 分桶 → 384 维 | S2 先例检索与 `rrfSearch` 的 dense 路实际都是**字面匹配**，"预算充足"与"资金充裕"相似度近 0 |

### 0.1 三项需求的回答口径

| 用户问题 | 回答 | 落点 |
|---|---|---|
| ① 八要素/九尺子 × 7×7 对应关系；粒子属性/本体/向量 × 八要素；记忆知识是否注入、何时注入 | 7×7 只供给八要素中的 **3 项**；粒子/本体/向量**全部可映射**到八要素（本文件 §1–§2 给出逐项表）；当前**仅 Post 阶段注入**，需补 **Pre / In** 两段 | §1、§2、§3 |
| ② 复盘如何生成新知识、存入长期记忆；哪些字段、哪些直更新、哪些需审批 | 复盘字段 **7 组**；分**三通道**——事实类自动直写、增量类（反面先例）自动登记、**改配置类必须处方审批** | §4 |
| ③ 销售 7 大决策 × 八要素/九尺子如何配置、前台如何生效、如何与记忆融合 | 配置落 `decision_scenario` 新增 **4 列**（单一事实源，不进 config_store）；前台走"配置 → Pre 装配 → 判定 → chip 展示"四段链路 | §5 |

### 0.2 实测基线（生产库 `crm_native`）

| 层 | 载体 | 行数 | 判读 |
|---|---|---|---|
| 记忆 M | `particles` / `memory_log` / `edges` | 71 / 36 / 20 | 有记忆 |
| 记忆 M | `memory_note` / `memory_snapshot` | 1 / 0 | 长期记忆通道**空转** |
| 记忆 M | `memory_log.layer` 分布 | L-Workspace 36 / **L-User 0 / L-Org 0** | **三层分层形同虚设** |
| 知识 K | `methodology_template` / `methodology_dimension` | 11 / 34 | **已有知识，但未注入**（F2） |
| 知识 K | `decision_scenario` / `skill_registry` | 12 / 24 | 场景齐备 |
| 知识 K | `decision_rule` / `policy_version` / `assertions` | 0 / 0 / 0 | 规则层空 |
| 决策 D | `decision` / `decision_context_snapshot` / `decision_provenance` | 12 / 26 / 8 | 有决策有留痕 |
| 决策 D | `decision_outcome` / `decision_precedent_rel` | 4 / 4 | 有结果有先例边 |
| 学习 | `calibration_patch` / `decision_retro_report` | 0 / 0 | **学习闭环零运行** |

供给质量：`decision_context_snapshot.supplied_dims` 分布 = 1(3) / 2(5) / 3(6) / 4(12)——**26 条快照无一达到 5/7 门槛**。

---

## §1 八要素 / 九尺子 × 7×7 精确对应

### 1.1 7×7 的准确定义

7×7 = **7 个供给操作（S1–S7）× 7 个事实域维度**，单一事实源 `src/context/supplySpec.js:16-24`，由 `validateSupplySpec` 强制双向全覆盖（7 操作齐备 + 7 维无悬空）。

| 操作 | 名称 | 供给维度 | kind | 产出边 | 真实模块 |
|---|---|---|---|---|---|
| **S1** | 实体与结构取 | identity, structure | fact | DECIDED_ON | `retrieveEntityProfile+particles` |
| **S2** | 决策史检索 | decision_history | fact | REFERENCED_PRECEDENT | `searchPrecedents` |
| **S3** | 冲突探测 | semantics, governance | fact | — | `detectConflicts` |
| **S4** | 规则校验 | governance | deterministic | rule_hit | `ruleEngine.check` |
| **S5** | 时间线构建 | time_config, operational_state | narrative | CAUSED | `buildTimelineRows+loadTimelineSources` |
| **S6** | 运行态取 | operational_state | fact | — | `tasks+agent_health+回款/竞品` |
| **S7** | 溯源捕获 | 全 7 维 | deterministic | PROV-O | `trackEntry` |

七维：`identity`（是谁）、`structure`（长什么样）、`semantics`（语义）、`time_config`（时效）、`decision_history`（先例）、`operational_state`（运行态）、`governance`（治理边界）。

### 1.2 八要素 × 供给源逐项对应

**判定规则**：任一要素必须有「供给源 → 落库字段」的完整链路，缺任一环即判**未承载**。

| # | 要素 | 供给操作 | 七维 | 数据源（表/字段） | 现状字段 | 判定 | 目标字段 |
|---|---|---|---|---|---|---|---|
| 1 | **目的** Purpose | — | — | 无（调用方输入） | 无 | ❌ 无字段无供给 | `intent.purpose` + `intent.hidden_goal` |
| 2 | **问题** Question | — | — | 无（调用方输入） | 无 | ❌ 无字段无供给 | `intent.question` + `intent.sub_questions[]` |
| 3 | **信息** Information | S1 / S3 / S5 / S6 | identity, structure, semantics, time_config, operational_state | `particles` + `edges` + 上下文快照 | `conditions_evaluated`（带权重）+ `trigger_context` | ⚠️ **供给存在但发生在写后**（F1） | 不变 + **Pre/In 阶段前置** |
| 4 | **概念** Concepts | 知识层（非 7×7） | — | `methodology_template`(11) + `methodology_dimension`(34) | `methodology_ids`（仅 ID 数组） | ⚠️ **有数据、无注入**（F2） | 新增 `concept_refs[]` 物化维度与权重 |
| 5 | **假设** Assumptions | S2 | decision_history | `decision_precedent_rel`(4) + `decision`(12) | 无 | ❌ 无字段；S2 跑在写后 | 新增 `assumptions[]`，由 Pre 阶段 S2 生成草稿 |
| 6 | **推论** Inference | — | — | 推理产出 | `rationale`（自由文本，实测填的是探针文案） | ⚠️ 有字段、**无结构** | 新增 `inference.chain[]`（evidence → via_assumption → conclusion） |
| 7 | **视角** PoV | S1 / S3 | structure, semantics | `CRM_CONTACT.decision_power` + `relationship_strength` 边 | 无 | ❌ 无字段 | 新增 `viewpoints[]`（stance / holder / covered） |
| 8 | **意涵与后果** Implications | S5 / S6 | operational_state, time_config | 运行态（回款/竞品/tasks） | 无 | ❌ 无字段 | 新增 `implications[]` + `risk_register[]` + `stop_loss` |

**汇总**：8 要素中 **完整承载 0 项**、部分承载 3 项（信息/概念/推论）、**完全缺失 5 项**（目的/问题/假设/视角/意涵）。

### 1.3 九尺子 × 可判定信号（全部有信号源，仅 1 项需 LLM）

九尺子（文档 §3 标题行，顺序以标题为准）：清晰性、准确性、精确性、相关性、深度、广度、逻辑性、重要性、公平性。
（注：文档展开行把第 5 项写作"关联性"，标题行写作"相关性"——**以标题行为准，统一用「相关性」**。）

| # | 尺子 | 信号源 | 判定方式 | 依赖要素 | 依赖 7×7 |
|---|---|---|---|---|---|
| 1 | **清晰性** | `intent.question` + `assumptions[].text` 措辞明确性 | **LLM**（默认关）+ 确定性代理：非空且无模糊词 | 目的/问题/假设 | — |
| 2 | **准确性** | `conditions_evaluated[].source` 存在 + 未过期 | 确定性 | 信息 | S1/S6 |
| 3 | **精确性** | `conditions_evaluated[].value` 具体度（非"大概/可能"） | 确定性 | 信息 | S1 |
| 4 | **相关性** | 供给项 ∩ `required_dims` 命中率 | 确定性 | 信息 | 全 7 维 |
| 5 | **深度** | `inference.chain` 层数 ≥2 且触及根因 | 确定性 | 推论 | — |
| 6 | **广度** | `viewpoints` 立场多样性（≥3 且含反方） | 确定性 | 视角 | S1/S3 |
| 7 | **逻辑性** | `chain` 每条同时有 `evidence` + `via_assumption` | 确定性 | 推论 | — |
| 8 | **重要性** | `methodology_dimension.weight` 加权命中率 | 确定性 | 概念 | 知识层 |
| 9 | **公平性** | 反面先例被 S2 检索到**且被消费**（非只召回） | 确定性 | 视角/假设 | S2 |

**关键结论**：9 尺子中 **8 项可确定性评分（零 token）**，仅"清晰性"需 LLM 且默认关——比上游 v2 估计的"3 项需 LLM"更乐观，因为 `methodology_dimension.weight` 为"重要性"提供了现成量化信号（F2 的直接收益）。

### 1.4 缺口汇总

| 缺口 | 类型 | 修复动作 | 成本 |
|---|---|---|---|
| 目的/问题/假设/视角/意涵 5 项无字段 | **结构缺** | `decision` 加 8 个 JSONB 列 | 低 |
| 概念未被注入 | **通道缺** | Pre 阶段读 `methodology_dimension` 物化 `concept_refs` | 低 |
| 7×7 跑在写后 | **时点错** | 拆 Pre/In/Post 三段 | 中 |
| 向量非语义 | **能力缺** | 可插拔 embedding provider + hashVector 兜底 | 中 |

---

## §2 粒子属性 / 本体模型 / 向量 × 八要素

### 2.1 粒子属性 → 八要素

27 种粒子按**决策职能**分五组（非按业务域），映射依据 `src/particles/particleModel.js:6-250`：

| 职能组 | 粒子类型 | 供给要素 | 供给维度 |
|---|---|---|---|
| **身份结构组** | CRM_ACCOUNT, CRM_CONTACT, CRM_DEAL, CRM_ORGANIZATION, CRM_PERSON | 信息（是谁）+ 视角（谁参与） | identity, structure |
| **商务事实组** | CRM_QUOTATION, CRM_CONTRACT, CRM_PAYMENT_PLAN, CRM_PAYMENT_RECORD, CRM_INVOICE, CRM_ORDER | 信息 + 意涵（回款/交付后果） | semantics, operational_state |
| **知识规则组** | CRM_KNOWLEDGE, CRM_DICT_ENTRY, CRM_OFFER_POLICY, CRM_APPROVAL_*（7 种） | **概念** + 治理边界 | governance |
| **证据组** | CRM_UNSTRUCTURED_ASSET, CRM_TECHNICAL_PROPOSAL, CRM_COMPETITOR | 信息 + **准确性**（证据链） | semantics |
| **产能组** | CRM_RESOURCE_CALENDAR | **意涵**（交付可行性后果） | operational_state |

**语义标签 → 八要素**（`SEMANTIC_TAGS`，`particleModel.js:253-260`）：

| 标签 | 属性 | 供给要素 | 说明 |
|---|---|---|---|
| `firmographic` | domains, funding_raised_usd, foundation_date, estimated_arr_usd, employee_range, categories | 信息 | 企业客观事实 |
| `relation` | champion_strength, key_contact, relationship_strength, company | **视角** | 关系强度 = 立场强度的直接量度 |
| `interaction` | interaction_index | 信息 | 互动频次，带时效性 |
| `social` | linkedin, twitter, facebook, instagram, angellist | 信息 | 补充事实 |
| `legacy` | name, industry, region, rating, decision_power… | 信息 | 基础事实；`decision_power` 同时供**视角** |
| `ui` | logo_url, avatar_url, primary_location | **不参与决策** | 仅展示，注入时剔除（防 token 浪费） |

**19 种属性类型 → 要素角色**：

| 类型族 | 类型 | 角色 |
|---|---|---|
| 事实型 | text, number, currency, percent, date, timestamp, boolean, select, multi-select, rating | **信息** |
| 引用型 | record-reference, actor-reference | **结构**（视角的来源：谁能说话） |
| 通信型 | email-address, phone-number, url, domain, location | **信息**（联络与溯源） |
| 证据型 | interaction | **准确性**（互动可验证性） |

### 2.2 本体模型 → 八要素

本体 = **18 个受控谓词**（`particleModel.js:278-287`）+ `edges` 表（20 行）。谓词是八要素中「结构」与「视角」的骨架：

| 谓词 | 供给要素 | 语义 |
|---|---|---|
| `belongs_to`, `part_of`, `member_of` | 信息（结构） | 归属关系，构成 identity |
| `owned_by`, `has_employee`, `works_at` | **视角** | 谁参与、谁负责 |
| `key_contact`, `relationship_strength` | **视角** | 关系强度，视角权重量化 |
| `priced_by`, `used_in`, `has_technical_proposal` | 信息 | 商务与技术事实 |
| `evidenced_by`, `sourcedFrom` | **准确性** | 证据链与来源，支撑尺子 2 |
| `auto_weak` | **准确性** | 弱边标记，降低该事实置信权重 |
| `referenced_in` | **假设** | 假设的引用来源 |
| `transitionedBecause`, `explains` | **推论** | 状态迁移理由（Oleg Product Memory 的 why 层） |
| `instanceOf`, `governs` | **概念** | 方法论实例化与治理规则 |
| `temporallyFollows` | **意涵** | 时序后果链 |
| `named_assignment` | 治理 | 指名客户分配审计 |

**判据**：`edges` 仅 20 行，对比 `particles` 71 行——**关系密度严重不足**，直接后果是「视角」要素失去量化基础（尺子 6 广度无法评分）。补齐边（尤其 `key_contact` / `relationship_strength`）是八要素落地的**前置条件**。

### 2.3 向量 → 八要素

**现状诊断（F3）**：`hashVector`（`ontology/embedding.js:8`）把 sha256 的 32 字节按 `byte % 384` 分桶累加，是**字符指纹**而非语义向量。

后果：
- S2 先例检索（`searchPrecedents`，minSimilarity 0.6）实际按字面碰撞匹配 → 「假设」要素召回质量低
- `rrfSearch`（`memoryLog.js:66`）的 dense 路与 sparse 路**信息同源**，RRF 融合的收益被打折

**三通道目标设计**：

| 通道 | 承载 | 现状 | 目标 | 供给要素 |
|---|---|---|---|---|
| **V1 决策向量** | `decision.embedding` → S2 先例检索 | hashVector | 语义 embedding（可插拔） | 假设、视角 |
| **V2 记忆向量** | `memory_log` → `rrfSearch` 召回 | hashVector | 同上 | 信息 |
| **V3 概念向量** | `methodology_dimension` → 场景/方法论匹配 | **无** | 新建，用于按语义推荐适用方法论 | 概念 |

**可插拔纪律**：
1. `embedding.js` 暴露统一 `embed(text)`，内部按 `config_store` 选择 provider（`hash` / `siliconflow`），**未配置时默认 hash，不静默失败**。
2. 切换 provider 时维度必须对齐 `vector(384)`；不一致时降级 hash 并 `emit('trace','embedding-dim-mismatch')` 留痕。
3. 回填任务幂等：按 `contentHash` 比对，内容未变不重算。

### 2.4 故事线 × 客户记忆 × 八要素 / 九尺子

本节回答：故事线与客户记忆在方法论里处于什么位置、如何咬合。

**四者角色分工**：

| 角色 | 是什么 | 回答的问题 |
|---|---|---|
| **客户记忆** | 素材（散点） | 客户是谁、偏好什么、雷区在哪 |
| **故事线** | 组织（时序） | 发生了什么、先后顺序 |
| **八要素** | 结构（语义） | 这个决策由什么构成 |
| **九尺子** | 评估（质量） | 构成得好不好 |

**判据**：单独任一方只答得出「是什么」，**结合才答得出「该怎么办」**——而决策要的是后者。

#### 2.4.1 故事线 → 八要素

故事线（`src/context/timelineSource.js`）是**派生视图**，四源只读聚合：`events` / `tasks` / `decision` / `memory_log`，不落库。

| 八要素 | 故事线供给什么 | 机制 |
|---|---|---|
| **信息** | 时序事实（time_config / operational_state 维） | 事件按 `occurred_at` 串起，回答"什么时候发生了什么" |
| **推论** | 因果链 | 时间相邻 + 实体相同 → 候选因果；`temporallyFollows` / `CAUSED` 边坐实 |
| **意涵** | 前因 | 「过去发生过 X」是「现在做 Y 会怎样」的唯一经验依据 |
| **假设** | **可验证性**（见 2.4.3） | 假设是否被历史事实支持，到故事线里查 |

#### 2.4.2 客户记忆 → 八要素

| 八要素 | 客户记忆供给什么 | 载体 |
|---|---|---|
| **信息** | 身份事实 | `CRM_ACCOUNT` / `CRM_CONTACT` 粒子属性（firmographic / relation 组） |
| **视角** | 客户立场与关系强度 | `relationship_strength` / `champion_strength` 边、`decision_power` 属性 |
| **假设** | 经验基础 | 「这个客户历史上如何反应」→ `memory_log` 按客户锚定的记录 |
| **概念** | 方法论的实例化 | 对该客户，MEDDICC 的 E1（经济买家）具体是谁 → `ROLE_MAP` + 边 |

#### 2.4.3 核心机制：让假设可被验证

这是故事线与客户记忆结合的**最大价值**，也是把故事线从"展示物"变成"决策输入"的关键。

```
假设录入时：assumptions[] = [{ id, text, basis, falsifiable_by, evidence_ref[] }]
                                                    ↑ 指向故事线条目 id

验证时：到故事线四源检索与假设语义相关的条目
   ├─ 命中且支持 → verdict = grounded（证据充分）
   ├─ 命中但矛盾 → verdict = contradicted（**立即预警**）
   └─ 未命中     → verdict = unsupported（无据假设，九尺子「准确性」扣分）
```

**反假绿纪律**：`unsupported` **不静默、不用默认值美化**——在监控台明确标为"无据假设"，而不是给它一个好看的分数。

**九尺子如何评估故事线本身**：

| 尺子 | 对故事线的判定 |
|---|---|
| 2 准确性 | 每条是否有 `source` + `ts`（可溯源到具体表行） |
| 3 精确性 | 时间精度（具体到日 vs 模糊"上个月"） |
| 5 深度 | 是否触及根因，还是仅罗列事件 |
| 6 广度 | 是否含多方视角（客户侧 / 我方侧 / 竞品侧） |
| 7 逻辑性 | 时序是否连贯、有无断裂跳跃 |
| 4 相关性 | 条目与本次决策 `scenario_id` 的相关度 |

#### 2.4.4 现状实测（生产库 `crm_native`）

**故事线四源中三源实际为空**：

| 源 | 行数 | 可用性 |
|---|---|---|
| `events` | **0** | ❌ 空 |
| `tasks` | **0** | ❌ 空 |
| `decision` | 12 | ⚠️ 仅在 `involved_entities` 数组形态匹配修复后才抽得到（2026-09-02 已修该 bug） |
| `memory_log` | 36 | ❌ **恒空**——`timelineSource.js:95` 查 `topic='account:<id>'`，但库里 topic 全为 `event:alert:info_collect_lag`(15) / `event:trace:sales-daily-scan`(15) / `decision:*`(6)，**无一条按客户锚定** |

**客户记忆实体基础薄弱**：`CRM_ACCOUNT` **仅 1 个**、`CRM_CONTACT` **仅 1 个**、`CRM_DEAL` 5 个；`particles` 71 行中审批域占 45 行（`CRM_APPROVAL_*`）。

**判定**：故事线与客户记忆目前都还是**空壳**——故事线只剩决策一源，客户记忆在 `memory_log` 里根本不存在（没有客户锚点）。二者结合的设计再好，没有数据基础也是空转。

#### 2.4.5 改造动作（按依赖顺序）

| # | 动作 | 说明 | 依赖 |
|---|---|---|---|
| **M1** | `memory_log` 增加 `entity_id` 列 + 索引 | 让记忆能按客户锚定；同时兼容既有 `topic` 写法，不破坏 `capture.js` | 无 |
| **M2** | 写记忆时带客户锚点 | 客户相关事件的 `captureMemory` 传入 `entity_id`（`memoryLog.js:22` 已有 `topic` 参数，扩一个即可） | M1 |
| **M3** | `buildTimelineRows` 输出增加 `element_ref` + `dim_ref` | 每条时间线条目标注"它支撑哪个八要素、对应哪一维"，**把流水账变成证据链** | 无 |
| **M4** | `assumptions[].evidence_ref[]` 绑定故事线条目 | 落地 2.4.3 的假设验证机制 | M3 |
| **M5** | S5（时间线构建）前置到 Pre / In 阶段 | 现状 S5 只在 Post 跑（`assembleContextV2`），故事线永远晚于决策 | §3 |

**M1 迁移纪律**：走 `ALTER TABLE crm.memory_log ADD COLUMN IF NOT EXISTS entity_id uuid`（见 §6.1，禁止写进 `CREATE TABLE IF NOT EXISTS` 段）。

---

## §3 注入时点：Pre / In / Post 三阶段模型

### 3.1 现状：Post-only

`assembleContextV2` 的全部生产调用点：

| 位置 | 时点 | 说明 |
|---|---|---|
| `decisionRepo.js:107` | **INSERT 之后** | 主链路，注释原文"决策落库后自动装配" |
| `routes.js:2096`, `routes.js:2121` | 调试端点 | 非生产路径 |

写操作**之前**发生的只有两件事，且都只做空值判定：
- `checkContextGuard`（`decisionRepo.js:62`）：查 `trigger_context` / `conditions_evaluated` 是否为空
- `sevenDimensionsCheck`（`decisionRepo.js:77`）：查七维上下文是否为空——但 `decision_scenario.required_dims` **12 个场景全为空数组**（实测 11 个 `[]` + 1 个 `{}`），恒返回"无必填维"→ **从未拦截过一次**

**判定（分两条路径，结论不同）**：

| 路径 | 决策前是否装配 | 说明 |
|---|---|---|
| **直接调 `createDecision`**（UI / 手工 / 校准） | ❌ **完全没有** | 知识（K）与记忆（M）从不参与决策形成，只在决策已成事实后被"记录" |
| **经 `autonomyEngine.requireDecision`**（AI 自主决策） | ⚠️ **有，但与 7×7 装配器双轨并行** | 见下 |

**F4：双轨并行缺陷（`autonomyEngine.js:60-89`，本轮新发现）**

引擎在调 `createDecision` **之前**已经自行完成决策前装配：
- ② `buildConditions({...sc, trigger_context})`（:80）→ 加载方法论 → 生成 `conditions` —— **这就是知识注入**
- ③ `searchPrecedents(scenario_id, qvec, {k:5})`（:86）→ 先例检索 —— **这就是 S2**
- ④ 用 `methodologyScore` + `avgSimilarity` + `coverage` 算置信度（:105）→ 决定自主放行还是升级 HITL

随后 `createDecision` 落库，**其内部的 `assembleContextV2` 又把 S2 跑了一遍**。

这是个既存缺陷，不只是架构不理想：

1. **可审计性失效（主害）**：引擎用来算置信度的那批先例（决策依据），与落快照里的那批先例（审计留痕），**是两次独立检索的结果**。两次之间若有新决策入库，`searchPrecedents` 的返回就会不同 → 出现"决策时参考了 A，留痕里却是 B"。审计追问"你当时到底看了什么"将无法回答。
2. **性能浪费（次害）**：同样的先例检索在一次决策里跑两遍，且两遍结果都不落到八要素字段上。

**这条发现反过来也证明了改动的可行性**：决策前装配在技术上早已跑通（引擎路径就是活证据），要做的不是从零新建 Pre 阶段，而是**把引擎已有的 Pre 计算接入统一装配器，消除双轨**。

### 3.2 三阶段定义

```
Pre  (K → D)  知识先问：这次该问什么、该看哪些维度、边界在哪
In   (M → D)  记忆再答：实际是什么、有无冲突、时序如何、现在什么状态
      ↓ 决策落定
Post (D → K/M) 留痕装配 + 闭环回流（复盘 / 后见之明 / 证实性偏差）
```

| 阶段 | 触发 | 执行操作 | 产物 | 失败策略 |
|---|---|---|---|---|
| **Pre** | 决策表单打开 / Agent 起意 | S2（先例） + S4（规则） + 知识注入（概念清单） | `PreContext` | fail-open，标 `degraded` |
| **In** | 实体选定 / 条件变化时 | S1（实体结构） + S3（冲突） + S5（时间线） + S6（运行态） | 信息填充 + 视角素材 | fail-open |
| **Post** | `INSERT` 成功后 | S7（溯源） + 快照落库 + 闭环回流调度 | 快照 + PROV-O | fail-open，已实现 |

### 3.3 完整注入清单（回答"什么注入、何时注入"）

| 阶段 | 源 | 注入内容 | 落到八要素 | 落库 | 前台可见 |
|---|---|---|---|---|---|
| **Pre** | `decision_scenario.required_dims` | 本次必填维度清单 | 信息（定口径） | 不落库（读时算） | 表单必填标记 |
| **Pre** | `methodology_template` + `methodology_dimension` | 适用概念清单 + 每维权重 + required | **概念** | `decision.concept_refs` | 方法论勾稽表 |
| **Pre** | `decision_rule` / `ruleEngine` | 治理边界（红线） | 意涵（约束） | `decision.conditions_evaluated` | 红线提示 |
| **Pre** | `decision_precedent_rel` + S2 | 相似先例（top-3） | **假设**（草稿） | `decision.assumptions[].basis` | 假设建议卡 |
| **Pre** | 反面先例（新增标记） | 失败先例 | **视角**（反方） | 同上，标 `negative=true` | 反方视角提示 |
| **In** | S1 `particles` + `edges` | 实体画像 + 关系强度 | 信息 + **视角** | 快照 + `viewpoints` | 客户 360 卡 |
| **In** | S3 `detectConflicts` | 冲突断言 | 信息（反向证据） | `decision_provenance` | 冲突警示 |
| **In** | S5 时间线 | 时序叙事 | 意涵（前因） | 快照 `narrative` | 故事线 |
| **In** | S6 运行态 | 在办任务 / 回款 / 竞品 | 信息 + 意涵 | 快照 | 运行态条 |
| **Post** | S7 `trackEntry` | 逐操作溯源 | — | `decision_provenance` | 溯源抽屉 |
| **Post** | 全量 | 快照 + `supplied_dims` | 信息（账本） | `decision_context_snapshot` | 「3/7 档位」chip |
| **Post** | 九尺子评分器 | 评分 + 阶段加权 | — | `decision.rubric` | 评分卡 + chip |
| **Post→回流** | outcome 落地 | 复盘 / 后见之明 / 偏差校验 | 见 §4 | 见 §4 | 复盘入口 |

### 3.4 接口改动（最小面）

| 改动 | 说明 |
|---|---|
| `assembleContextV2(input)` 增加 `phase: 'pre' \| 'in' \| 'post'` | 缺省 `'post'`，保持向后兼容既有调用 |
| `createDecision` 增加 `pre_context` 入参 | 若传入则不重复 Pre 计算 |
| 新增 `GET /api/decision/pre-context?scenario_id=&entities=` | 前台渲染决策表单骨架（必填维/概念清单/先例建议） |
| 新增 `GET /api/decision/:id/rubric` | 九尺子评分明细 |

### 3.5 向后兼容与降级路径（关键，防止改动打破既有链路）

**降级判据**：`createDecision` 检测入参是否带 `pre_context`。
- **带** → 走单轨：直接用 Pre 产物填充八要素，Post 阶段**只冻结留痕，不重跑 S1–S7**
- **不带** → 走降级：**在 INSERT 之前**自动补跑一次 `assembleContextV2({phase:'pre'})`，再把产物当 PreContext 用

降级路径保证了两类存量调用方零修改即可受益：
1. 所有直接调 `createDecision` 的代码（UI、校准 `store.js:47`、各处 action）
2. `autonomyEngine` 的两处调用（:124 自主、:144 升级）——改造时把引擎已有的 `conditions` / `precedents` 作为 `pre_context` 传入即可，**无需改引擎的判定逻辑**

**Post 阶段语义变化（易踩错，必须注意）**：

> **不是把 Post 挪到 Pre，而是新增 Pre/In，Post 保留但语义改变。**

| | 现状 Post | 目标 Post |
|---|---|---|
| 做什么 | 重新装配 S1–S7 | **冻结** Pre/In 已得结果 |
| 落什么 | 快照 + PROV-O | 快照 + PROV-O（不变） |
| 重跑检索 | 是 | **否** |
| 目的 | 事后补一份上下文 | 证明"决策当时看到的就是这份" |

这样改后，快照记录的是**决策真正依据的那份上下文**，而不是事后重查的可能已变化的数据——**可审计性反而更强**，同时省掉一次重复检索。

**时序风险与对策**：

| 风险 | 说明 | 对策 |
|---|---|---|
| Pre 与决策之间数据变化 | Pre 装配后、INSERT 前，若有新决策入库 | PreContext 带 `assembled_at` + `content_hash` 落库；审计时以此为准，不重新查询 |
| `required_dims` 回填后开始真拦截 | 存量调用方可能因缺维被 block | 初值一律 `on_missing='warn'`，只留痕不阻断；观察一个周期后再按场景逐个转 `block` |
| 装配失败 | Pre 装配异常 | fail-open + `emit('trace','pre-assembly-failed')` 留痕，不阻断决策（与既有 Post 失败策略一致） |

---

## §4 复盘：新知识生成与长期记忆回流

### 4.1 复盘字段全集（7 组）

落库策略：**单决策复盘写 `decision_provenance`（`entry_type='RETRO'`，append-only）；批量聚合复盘写 `decision_retro_report`（已有表，0 行，10 列：report_id / run_at / window_start / window_end / decisions_scanned / clusters / draft_patches / summary / llm_enabled / created_at）**。二者分工：前者是原子事实，后者是周期性洞察。

| 组 | 字段 | 类型 | 说明 |
|---|---|---|---|
| **A 结果事实** | `outcome_type` | enum | won / lost / paid / stalled（复用 `decision_outcome` 既有列） |
| | `vs_expected` | enum | as_expected / better / worse |
| | `verified_at`, `verified_by` | ts, text | 谁在何时确认 |
| **B 假设核验**（核心） | `assumption_review[]` | jsonb | `{ assumption_id, text, verdict: held\|falsified\|partial, evidence, note }` |
| **C 信息缺口** | `missing_information[]` | jsonb | `{ dim, what, would_have_changed, severity }` |
| **D 归因** | `root_cause` | jsonb | 复用 `decision.root_cause` 既有列 |
| | `hindsight_delta` | real | 决策时置信度 vs 复盘后置信度之差 |
| **E 知识产出** | `knowledge_update[]` | jsonb | `{ target, patch, rationale, evidence, confidence }` |
| **F 记忆影响** | `memory_impact[]` | jsonb | `{ memory_id, action: reinforce\|rewrite, before, after }` |
| **G 元信息** | `retro_by`, `retro_at`, `decision_id` | text, ts, uuid | — |

### 4.2 三通道分流（回答"哪些直更新、哪些需审批"）

**判据**：**增量 vs 覆盖**——新增事实自动放行；覆盖既有配置/知识必须审批。

| 通道 | 内容 | 动作 | 审批 | 依据 |
|---|---|---|---|---|
| **C1 自动直写** | A 结果事实、B 假设核验结论、C 信息缺口、D 归因、G 元信息 | 写 `decision_provenance`(`RETRO`) + 更新 `decision.outcome/outcome_verified/feedback` | **不需要** | 事实记录，append-only，不可逆改，不污染配置 |
| **C2 自动登记** | B 中 `verdict='falsified'` 的假设 | 登记为**反面先例**：写 `decision_precedent_rel`（新增 `negative_precedent` 布尔列，默认 false） | **不需要** | 是**新增**先例，不覆盖既有知识；下次 S2 检索时作为反方证据参与，喂尺子 9「公平性」 |
| **C3 处方审批** | E `knowledge_update` 中**修改配置**的 patch（改 `required_dims` / `focus_rulers` / `methodology_dimension.weight` / 阈值） | 生成 `calibration_patch` 处方 → 批准时走 `createDecision({scenario_id:'CALIBRATION_CHANGE'})` 真实决策行 → 事务原子落配置 | **必须**（决策第 0 闸 + HITL） | 改规则 = 影响后续**所有**决策；AI 不直接改生产配置（项目铁律） |
| **C3′ 仅留痕** | F 记忆影响 | 见 §4.4 | **不需要**（但原始记忆永不覆盖） | 记忆不可篡改 |

### 4.3 知识生成算法（复盘 → 新知识）

```
输入：assumption_review[] + missing_information[] + outcome_type

1. 对每个 falsified 假设：
   → 生成反面先例（C2，自动）
   → 生成候选知识：「在 scenario X 下，假设 H 不成立，因为 E」→ knowledge_update 候选

2. 对每个 missing_information（severity=high）：
   → 生成候选 patch：「scenario X 的 required_dims 增加 dim D」
   → 置信度 = 该缺口在窗口内重复出现次数 / 总次数

3. 窗口聚合（decision_retro_report，批量复盘）：
   → clusters 按 root_cause.code 聚类
   → 同一 patch 在窗口内被 ≥N 次独立复盘独立提出 → 提升置信度
   → 置信度 ≥ 阈值（走 config_store，阈值配置化铁律）→ 生成 calibration_patch 处方

4. 处方 → 审批 → 落配置 → 下次 Pre 阶段生效（闭环合拢）
```

**反假绿纪律**：候选知识**不自动落 `methodology_dimension`**，一律走处方；未达阈值的只留痕在 `decision_retro_report.clusters`，不做任何写入。

### 4.4 后见之明：决策结果改写记忆（用户强调点 2.1）

文档原文：「成功了，就强化原有经验记忆；失败了，会重新改写对当时场景的记忆。」

**设计原则：原始记忆永不覆盖，后见之明是新增层。**

| 结果 | 动作 | 落库 |
|---|---|---|
| 成功 | `reinforce`：新增 `memory_log{kind:'HINDSIGHT_REINFORCE', payload:{memory_id, reason}}`，并给原记忆打 tag `verified` | 新增行 + `tag_history` append |
| 失败 | `rewrite`：新增 `memory_log{kind:'HINDSIGHT_REWRITE', payload:{memory_id, original, reinterpretation, reason}}`，给原记忆打 tag `rewritten:hindsight` | 同上，**原 payload 不动** |

**为什么不让 AI 直接改原始记忆**：记忆一旦被改写，后续复盘就失去了"当时到底怎么想的"这个基准——证实性偏差会**自我巩固**（越改越觉得自己当初是对的）。保留原始层 + 新增解读层，才能计算「当时判断 vs 事后解读」的偏差率（§4.5）。

### 4.5 证实性偏差校验（用户强调点 2.2）

文档原文：「决策的复盘，会生成新的知识，存入长期记忆，成为下一次决策的输入。」

| 环节 | 机制 |
|---|---|
| **记录** | 决策时写 `decision_provenance{entry_type:'HINDSIGHT_CHECK', payload:{belief_at_decision, confidence_at_decision}}` |
| **比对** | 复盘时算 `hindsight_delta` = 复盘后置信度 − 决策时置信度 |
| **检出** | 窗口内 `|hindsight_delta| > 30%` 的决策占比 → 偏差率 |
| **处置** | 偏差率超阈值（走 `config_store`）→ 自动生成 `calibration_patch` 处方（C3，需审批），建议调整该场景的 `focus_rulers` 权重或 `required_dims` |

**闭环终点**：批准后的 patch 落到 `decision_scenario` → 下次 Pre 阶段装配时读新配置 → 新决策的必填维/重点尺子已改变 → **新知识真正成为下一次决策的输入**。

---

## §5 销售 7 大决策 × 八要素 / 九尺子：配置化与前台生效

### 5.1 配置数据模型

**单一事实源 = `decision_scenario` 表本身新增 4 列**（不进 `config_store`，避免双源；`config_store` 当前仅 1 行，是全局开关的归宿，不是场景配置的归宿）。

| 新增列 | 类型 | 内容 |
|---|---|---|
| `focus_elements` | jsonb | 本场景重点核查的八要素子集（2–4 项），带权重 |
| `focus_rulers` | jsonb | 本场景重点尺子子集（2–4 把），带权重 |
| `rubric_pass_line` | real | 九尺子加权及格线 |
| `retro_required` | boolean | 是否强制复盘 |

**评分权重三档**（非聚焦不归零，避免盲区）：

```
基础项（信息 / 推论，全场景）  × 1.0
本场景 focus 项               × 1.5
其余项                        × 1.0
```

### 5.2 销售 7 大决策默认配置初值

依据《2B销售全流程决策自检框架》七阶段，结合 `decision_scenario` 实测 `methodology_ids` 绑定推导。**初值全设 `warn` 不阻断**，待业务复核。

| 阶段 | scenario_id | 已绑方法论 | focus_elements（重点要素） | focus_rulers（重点尺子） | required_dims 推导 |
|---|---|---|---|---|---|
| S1 线索发掘 | `LEAD_FOLLOW_UP` | BANT, MEDDICC, OPP_MATRIX | 假设、问题、信息 | 相关性、重要性、精确性 | identity, structure, decision_history |
| S2 需求确认 | `OPP_QUALIFY` | MEDDICC, OPP_MATRIX, ROLE_MAP | 假设、视角、信息 | 深度、广度、准确性 | identity, structure, semantics, decision_history |
| S3 方案匹配 | `SOLUTION_VALUE` | OPP_MATRIX, RISK_TRADEOFF | 假设、概念、意涵 | 相关性、深度、逻辑性 | identity, structure, semantics, operational_state |
| S4 报价谈判 | `QUOTE_PRICING` | RISK_TRADEOFF, STOP_LOSS | 假设、意涵、推论 | 重要性、精确性、逻辑性 | identity, structure, operational_state, governance |
| S5 合同确认 | `SIGN_RISK` | RISK_TRADEOFF, STOP_LOSS | 意涵、视角、假设 | 深度、广度、公平性 | identity, structure, governance, decision_history |
| S6 赢单移交 | `POST_CONTRACT` | RISK_TRADEOFF, OPP_MATRIX | 意涵、信息、目的 | 准确性、逻辑性、相关性 | identity, structure, operational_state, time_config |
| S7/S8 输单丢单 | `LOSS_REVIEW` | FACT_VS_TALK, OPP_MATRIX | 假设、推论、视角 | 公平性、深度、广度 | identity, decision_history, semantics |

> 跨阶段补充：`CLIENT_STRATEGY`（ROLE_MAP / FACT_VS_TALK / MEDDICC）不在七阶段主轴内，作为客户级策略决策独立配置。

**`required_dims` 推导链**：聚焦要素 → 该要素所需事实域 → `required_dims` 初值。例：S2 聚焦「视角」，视角依赖 `relationship_strength` / `decision_power`（structure）+ 冲突断言（semantics）+ 先例（decision_history）→ 故 S2 的 required_dims 含此三维。

### 5.3 前台生效链路（四段）

```
① 配置    后台配置中心 → PUT /api/config/stage-focus → 写 decision_scenario 4 列（sysadmin + 第 0 闸）
              ↓
② Pre 装配  GET /api/decision/pre-context → 读 4 列 + methodology_dimension → 返回必填维/概念清单/先例建议
              ↓
③ 判定     createDecision → sevenDimensionsCheck（required_dims 已非空 → 真拦截）
                          → 九尺子评分（focus_rulers 加权 vs rubric_pass_line）
              ↓
④ 展示     /sales-decision-monitor：
              · 场景列表 chip = 真实评分归因（不再是演示数据）
              · 7 轴档位 = 真实 supplied_dims（不再是常量）
              · 决策详情 = 思维卡（八要素）+ 评分卡（九尺子）+ 复盘入口
```

**前台改造纪律（UI 一致性铁律）**：
- 颜色 100% 走 `src/web/tokens.css` 语义变量（`--bg/--panel/--ink/--mut/--line/--ac/--ok/--err/--warn`），**零硬编码色值**
- 布局复用 `common.css` 的 `.panel/.sect/.sect-title/.btn/.table/.card/.page-head`
- **禁止**在 HTML 内 `:root` 重定义全局 token；**禁止** `var(--x, #浅色)` 危险 fallback
- 新增折叠区挂到既有决策详情抽屉内，**不新建页面**

### 5.4 与记忆系统的融合点

| 融合点 | 机制 |
|---|---|
| **Pre 读记忆** | S2 先例检索（`decision_precedent_rel`）+ 反面先例 → 生成假设草稿 |
| **Pre 读知识** | `methodology_dimension`（34 条带权重）→ 概念清单 + 尺子 8「重要性」量化信号 |
| **In 读记忆** | S1 实体画像、S3 冲突、S5 时间线、S6 运行态 → 填充信息要素 |
| **Post 写留痕** | S7 溯源 + 快照（已实现） |
| **回流写记忆** | §4.4 后见之明（reinforce / rewrite，append-only） |
| **回流写知识** | §4.3 知识生成 → 处方审批 → 落 `decision_scenario` → 下次 Pre 生效 |

---

## §6 迁移、验收与风险

### 6.1 迁移纪律（踩坑铁律，必须遵守）

> **禁止**把新列写进 `db/schema.sql` 的 `CREATE TABLE IF NOT EXISTS` 段内——旧库表已存在时**不会补列**，随后依赖该列的索引会让**整文件单事务的 `db/migrate.js` 全量回滚**（2026-08-31 生产库实测 `column "stable_key" does not exist`）。
> **必须**在 `db/migrate.js` 向后兼容段追加独立 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`（既有 `skill_registry.updated_by`、`particles.stable_key` 同模式）。

本设计涉及的 DDL（全部走 `ALTER TABLE ADD COLUMN IF NOT EXISTS`）：

| 表 | 新增列 |
|---|---|
| `crm.decision` | `intent`, `assumptions`, `inference`, `viewpoints`, `implications`, `risk_register`, `stop_loss`, `rubric`, `concept_refs`（9 个 JSONB） |
| `crm.decision_scenario` | `focus_elements`, `focus_rulers`（JSONB）, `rubric_pass_line`（real）, `retro_required`（boolean） |
| `crm.decision_precedent_rel` | `negative_precedent`（boolean，默认 false） |

### 6.2 验收硬指标

| 指标 | 当前 | 目标 |
|---|---|---|
| 八要素字段承载 | 0/8 完整 | **8/8** |
| 九尺子有真实评分 | 0/9 | **9/9**（8 确定性 + 1 LLM 默认关） |
| Pre 阶段注入生效 | ❌ | ✅ `GET /api/decision/pre-context` 返回非空必填维 |
| `required_dims` 非空 | 0/12 场景 | **≥7/7** 业务场景 |
| 拦截引擎真拦截 | 0 次 | 缺必填维时 `block` 生效（warn 模式下留痕） |
| 监控台 chip 真实化 | 演示数据 | 真实评分驱动 |
| 7 轴档位达标率 | 0/26 快照 | 有 required_dims 后重测 |
| 复盘闭环 | 0 行 | 有 outcome 的决策可复盘，falsified 假设自动登记反面先例 |
| 记忆分层 | L-Workspace 36 / 其余 0 | L-User / L-Org 有真实数据 |

### 6.3 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 八要素 9 列靠调用方自觉填写，物化率可能长期为 0 | 设计空转 | Pre 阶段生成**草稿**（先例推导假设、方法论推导概念清单），调用方只需确认/修改，不靠自觉；监控物化率 |
| `edges` 仅 20 行，视角要素无量化基础 | 尺子 6「广度」无法评分 | 补齐 `key_contact` / `relationship_strength` 边作为前置任务；不足时该尺子标 `degraded` **不假填充** |
| 向量非语义导致先例召回质量低 | 假设质量差 | V1/V2 换语义 embedding（可插拔），hashVector 兜底并留痕 |
| 复盘知识自动落配置污染生产 | 规则被错误修改 | 一律走处方审批（C3），AI 不直接改配置 |

---

## §7 待决问题

| # | 问题 | 建议 |
|---|---|---|
| Q1 | 7 大决策的 `focus_elements` / `focus_rulers` 初值（§5.2）是否照单全收？ | 先按初值全 `warn` 上线，跑出评分数据后再校准 |
| Q2 | `LOSS_REVIEW` 同时绑 S7/S8，是否拆分？ | 暂不拆；若输单与丢单的复盘结论分化明显再拆 |
| Q3 | V1/V2 语义 embedding 何时切换？ | 建议 P1 末；切换前先跑 A/B：hashVector vs 语义向量在同一批先例上的召回质量 |
| Q4 | `decision_rule` / `policy_version` / `assertions` 三张空表是废弃还是待填？ | 若废弃应显式标注 deprecated，避免误判为缺口 |

---

**HARD-GATE：以上为设计稿，未获批准前不写任何实现代码。**
