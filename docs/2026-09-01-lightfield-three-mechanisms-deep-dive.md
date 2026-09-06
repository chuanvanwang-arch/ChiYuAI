# Lightfield 三大标志性机制 × CRM-ai-native 深度对比分析

- 日期：2026-09-01
- 一手材料：Lightfield 官方博客《LLMs also prefer stories to graphs and databases》（Keith Peiris, 2026-02-20）
- 本平台证据：src/ 源码 file:line + 运行期事实（全部可复核）
- 性质：机制级差距分析（非实施设计；实施需另走 brainstorming → 设计 → 批准）

---

## §0 结论（三句话判定）

1. **Versioned memory 四元组：本平台"归因"与"状态"两项已超越 Lightfield，"时序"有半成品（只给人看不给模型看），"因果"名义完整（7 边规范）实际只落 3 类——是"设计超前、落地欠账"。**
2. **Stories over graphs：本平台其实同时握有图（AGE + decision_relation）和叙事（insightService.buildTimelineRows）两条轨，但叙事只用于页面渲染，喂给 LLM 的仍是 title + disposition 的标签列表——断层不在数据层，在注入层（src/context/injector.js:19-23）。这是三个机制里投入产出比最高的一个。**
3. **交易诊断复活：本平台的特征空间（MANT/漏斗分区/TAORAN/21 条/BANTCC/阶段停留）比 Lightfield 从非结构化对话里提的更结构化、更可审计，但缺"跨赢输单模式对比"这一中间环节；且所需的方法论 SKILL（method-role-map = 角色地图，正是"补 IT 联系人"的能力）已注册却因 D4 缺陷从未被调用。**

**总体判断：Lightfield 胜在"捕获源头"与"叙事注入"，本平台胜在"归因深度"与"治理可审计"。三者中两项本平台不是能力不足，而是已有资产未接线。**

---

## §1 机制一：Versioned customer memory（chronology / attribution / causality / state）

### 1.1 Lightfield 定义

关键人换岗、销售离职时，系统不只记录新状态，还保留"发生了什么、为什么"的叙事线；公开材料以四个词概括：时序、归因、因果、状态演化。其数据基础是"实时更新的故事化时间线"，不是静态字段快照。

### 1.2 本平台逐项映射（证据）

| 四元组 | Lightfield 实现 | 本平台对应实现 | file:line | 判定 |
|---|---|---|---|---|
| **chronology 时序** | 故事化时间线 | `buildTimelineRows(sources)`：多源事件 → 统一时间线条目，按 ts 倒序 + 同秒同实体去重，带 actor/source/summary 字段 | `src/account/insightService.js:105-118` | **有，但仅用于客户 360 页面渲染，未进 LLM 上下文** |
| | | visit_notes JSONB 数组（手动录入，含 objective/result/next/type/achieved） | `src/sales/visitNote.js:19-28` | 有时序语义但无统一时间索引；字段兼容层本身是技术债（`t_*` 双写法） |
| **attribution 归因** | 记录"谁在什么时候改变了什么态度" | `decision.actor` + **七类根因分类树**（FIELD_MISMATCH / INFO_INCOMPLETE / INPUT_STALE / DIM_MISSING / EDGE_MISSING / NEED_DIM_ORDER / DATA_QUALITY_PRECEDENT），每类带 layer + knob（可调旋钮）+ evidence[] | `src/decision/rootCauseClassifier.js:13-22` | **显著强于 Lightfield**——Lightfield 公开材料无等价的归因分类体系 |
| | | PROV-O 溯源：decision_provenance + was_derived_from 边 | `src/ontology/ageSync.js:44-55` | 已实现（P3），但依赖 provenance 已捕获 |
| **causality 因果** | 时间线叙事中隐含 | **E1–E7 七类决策边规范**（DECIDED_ON / REFERENCED_PRECEDENT / DERIVED_FROM_EXCEPTION / ESTABLISHES_FRAME / OVERRIDES / CAUSED / INFLUENCED），PG 权威 + AGE 镜像双写 | `src/decision/edgeDimensionSpec.js:16-24`、`src/decision/relation.js:39-52` | **规范完整** |
| | | **但实际调用点只有 3 处**：CAUSED / INFLUENCED / ESTABLISHES_FRAME | `src/decision/decisionRepo.js:173,176,179` | **7 类只落 3 类**——DECIDED_ON（决策→业务实体）、REFERENCED_PRECEDENT（引用先例）、DERIVED_FROM_EXCEPTION（异常触发）、OVERRIDES（翻案）**全库零写入** |
| | | 因果追溯：traceUpstream/Downstream + 影响地图 + 每跳置信度 ×0.9 衰减 | `src/decision/decisionTrace.js:9-16`、`src/decision/graphAnalytics.js` | 能力在，但 AGE 不可用时降级到 `decision_precedent_rel` CTE，且边不全 |
| **state 状态演化** | 当前态 + 演化 | 确定性业务计算：MANT 四要素齐全性、漏斗分区（线索/机会-/机会+/漏斗内）、预测分类加权、阶段停留 | `src/sales/funnelQuality.js:19-45` | **强于 Lightfield**：加权与阈值全部走 config_store，可审计、可复算；Lightfield 的状态由 LLM 从对话派生，不可复算 |

### 1.3 判定

- **超出的部分**：归因（七类根因 + 旋钮映射）、状态（确定性可复算而非 LLM 派生）。这两项是把"问责"写进架构的产品，Lightfield 公开材料中不存在。
- **欠账的部分**：因果链 7 类只落 3 类，尤其是 **DECIDED_ON（决策→客户/商机实体）** 缺失——意味着"这个客户身上发生过哪些决策"这条因果链在图上是断的，只能靠 AGE 的粒子顶点边（owned_by/has_contract 等 9 类受控谓词，`src/ontology/ageSync.js:12-17`）间接拼。这直接导致 Lightfield 演示中"打开一笔交易 → 列出它参与过的全部决策"在本平台做不出来。
- **时序的错位**：数据装配能力（`buildTimelineRows`）已经存在且质量不错，但它的消费者是页面，不是模型。

---

## §2 机制二：Stories over graphs（LLM 在叙事时间线上表现优于 KG）

### 2.1 Lightfield 的一手论证（官方博客，2026-02-20）

摘录关键论断（原文）：

> "When we used LLMs with structured graphs, the models **treated the relationships too rigidly. They'd hold the edges too firmly** and lacked understanding of *why* concepts were connected or what the overarching theme was across the data. They were missing the forest for the trees."

> "Modeling human relationships requires **changing the weights of details to fit the dominant narrative**. Maybe the CISO you were trying to sell to said he had a fixed budget and no time for you, but then you explained you could solve a bigger problem, and his view on budget and urgency changed. **Graphs really got in the way of modeling the malleability of humans.**"

> "if you write up all the details about a person and your relationship with them as a story, the best models can **re-weight the importance of details dynamically**."

> "we **dumped the classical graph** and started building our data model of people and companies around stories. We write **live-updating chronological stories** about people and your relationship with them."

> "We also **fetch all the data through code execution to make sure it's not lossy**."

三个技术要点：①图的"边"是硬约束，阻碍模型动态重新加权；②人的可塑性（态度随对话改变）用图表达会失真；③取数走代码执行以避免上下文有损压缩。

### 2.2 本平台现状：图、叙事都建了，但注入层没接

**图这一侧（已建）：**

| 资产 | 说明 | file:line |
|---|---|---|
| AGE 语义图镜像 | 粒子顶点 + 9 类受控谓词边（owned_by / part_of / belongs_to / has_quotation / has_contract / key_contact / relationship_strength / auto_weak），写时镜像，AGE 不可用则短路不阻断 | `src/ontology/ageSync.js:12-17` |
| 决策关系图 | 7 类边，PG 权威 + AGE 镜像，配置可覆盖（config_store['seven-dim'].edge_bindings） | `src/decision/relation.js:39-52` |
| 图分析 | 度数中心度、下游影响规模、因果链追溯（置信度衰减） | `src/decision/graphAnalytics.js:33-37`、`decisionTrace.js` |

**叙事这一侧（也已建，但未给模型）：**

`src/account/insightService.js:105` 的 `buildTimelineRows` 已经是合格的叙事装配器——统一时间线条目、倒序、同秒同实体去重，条目含 `ts / type / title / source / actor / entity / summary`，覆盖 visit_notes、决策、合同、回款等多源事件。

**断层在注入层——这是本次分析最关键的发现：**

```js
// src/context/injector.js:19-23（原文）
if (Array.isArray(layers.L1) && layers.L1.length) {
  parts.push(`相关知识(${layers.L1.length}): ` + layers.L1.map((x) => x.title).join('; '));   // ← 只注入 title，无正文
}
if (layers.L2?.decisions?.length) {
  parts.push(`历史决策(${layers.L2.decisions.length}): ` + layers.L2.decisions.map((d) => `${d.scenario_id}:${d.disposition}`).join('; '));  // ← 只注入 场景:处置，无时间/无因果/无叙述
}
```

即：**模型最终看到的是"标题列表 + 场景:处置 列表"，不是故事。** 按 Lightfield 的论证，这种输入恰恰是"表格/图"形态而非叙事形态，模型无法动态重加权，也无法理解"这个客户的关系是怎么演化到今天的"。平台花大力气装的 L1–L4 分层 + 降级链（`src/context/assembler.js:1-4`），在最后一步被压扁成了标签串。

叠加另外两个已知短板，语义理解能力实质缺位：
- L1 检索用**确定性哈希向量**（`src/ontology/embedding.js:5`，注释自证"零外部依赖，可跑全量测试"），非语义向量，只能做指纹精确匹配；
- 运行期知识层实际注入为 `["L1","L2","L4"]`，**L3 因 KG 降级缺失**（2026-09-01 复盘接线设计文档的运行期事实）。

### 2.3 本平台该如何取舍：不是"弃图从叙事"，而是双轨分工

Lightfield 的批评**不适用于决策图，适用于客户语义图**。需要分开看：

| 图类型 | 是否受"边太硬"批评 | 本平台应取策略 |
|---|---|---|
| **决策因果图**（decision_relation 7 边） | **不受影响**——决策之间的因果/翻案/参考先例关系是**事实**，不随对话改变可塑性 | **保留并加强**：补齐缺失的 4 类边写入（尤其 DECIDED_ON）。这是审计与追溯的确定性资产，恰恰是叙事做不到的 |
| **客户实体图**（particles/edges，key_contact / relationship_strength） | **受影响**——"关系强度""谁是关键人"正是随对话漂移的 | **降权 + 叙事补位**：实体关系用于结构化筛选与权限范围，理解层面交给叙事时间线 |
| **叙事时间线** | 不适用（Lightfield 主张的形态） | **新建注入通道**：把 buildTimelineRows 的产出接进 L2/L3 注入 |

**这条双轨恰恰是 Lightfield 单轨叙事做不到的**：它把字段降级为派生视图后，就没有可审计的确定性因果骨架了；本平台可以做到"叙事给模型理解，图给人类审计"，两者互补而非二选一。

### 2.4 一个被低估的现成资产：method-fact-vs-script

Lightfield 论证的核心是"人的表态会变（话术），事实不变"。本平台已注册 **method-fact-vs-script SKILL**（"区分客户沟通中的事实（可验证证据）与话术（口头表述），事实优先"，`src/skills/seed.js`）。这条方法论可直接作为叙事装配的权重规则：**叙事时间线中标记为"事实"的条目权重稳定，标记为"话术"的条目允许被后续事实覆盖**——这正是对 Lightfield"动态重加权"的可解释化实现，而不是交给模型黑箱处理。**该 SKILL 目前因 D4 缺陷从未被调用。**

---

## §3 机制三：交易诊断与复活（对比赢/输单模式 → 自动补联系人 → 起草邮件）

### 3.1 Lightfield 机制拆解（五步链）

1. 用户问"为什么这笔交易卡住了？"
2. 系统**不返回摘要**，而是在沙盒中**运行代码**，将该交易与系统中**所有已赢/已输交易做模式对比**
3. 发现模式："每笔赢单都让 IT 负责人早期介入；每笔输单都没能及早获得 IT 批准；这笔交易根本没有 IT 联系人"
4. 直接行动：运行约 20 个富化工具 → LinkedIn 搜索 CIO → 创建联系人 → 以销售代表的语气起草介绍邮件
5. 发送前 HITL 人工批准

客户自述效果：Voker.ai 两小时复活 40+ 笔停滞 6 个月的机会，其中 10 笔两天内进入 POC；响应时间从数周缩短到一两天。（创始人自述，未经独立验证）

**能力要件拆成三层**：①可比的特征空间（赢/输样本的结构化特征）；②跨样本归因模式挖掘；③写回行动链（外部富化 + 建记录 + 起草 + HITL）。

### 3.2 本平台逐层对比

#### 层① 可比的特征空间 —— 本平台更结构化

| 特征来源 | 本平台 | file:line | vs Lightfield |
|---|---|---|---|
| 商机资质 | MANT 四要素齐全性（m/a/n/t ok 判定），四要素全清才进漏斗 | `src/sales/funnelQuality.js:19-45` | **更结构化**：Lightfield 从非结构化对话抽取；本平台是显式字段 + 配置化阈值 |
| 漏斗分区 | 线索 / 机会- / 机会+ / 漏斗内（确定性规则） | 同上 | 平台独有 |
| 预测分类 | 确保/优势/可能+/可能-，权重走 config_store | 同上 `FORECAST_WEIGHT_KEY` | 平台可审计，Lightfield 由模型判断 |
| 客户资质 | BANTCC 七维评估 | `src/aiAttributes/evaluator.js:119` | 平台更强 |
| 拜访质量 | TAORAN-A/O/R/N + 21 条行为标准 | `src/sales/behaviorChecklist.js`、`src/sales/visitNote.js` | 平台独有（管理视角） |
| 阶段停留 | stageConfig + 阈值配置化 | `src/sales/stageConfig.js` | 平台有 |

**判定：特征空间这一层，本平台不仅具备而且质量更高、全部可配置可复算。缺的不是特征，是"拿这些特征做跨样本对比"的动作。**

#### 层② 跨赢/输单模式挖掘 —— 本平台缺失

现有最接近的实现是 `crm-deal-analyze` SKILL（`src/skills/seed.js:10-19`），其全部定义：

```js
{ step: 1, action: 'data-particle-read', decision: 'rule', params: { type: 'CRM_DEAL' } },
{ step: 2, action: null, decision: 'j_judge',
  prompt: '基于商机阶段/跟进/赢率给出推进建议 {{steps[0].result}}' }
```

即：**读取商机 → LLM 给单笔推进建议**。差距有三：
- 只读"这一笔"，**不与历史赢单/输单集合做对比**（无模式挖掘）；
- 建议是定性的"推进建议"，不是"为什么卡住"的归因；
- 因 D4 缺陷（`agentLoop.js:63` 恒 fallback），**这个 SKILL 从未被真正执行过**。

其他近似能力：
- `method-role-map` SKILL（"识别决策链/影响者/使用者/利益相关方四类角色并标注立场"）——**这正是 Lightfield 演示里"发现缺 IT 联系人"所需的能力，已注册但从未调用**；
- `method-meddicc`（经济买家/决策流程/冠军）、`method-stop-loss`（止损退出门）、`method-opportunity-matrix`、`method-risk-tradeoff` —— 七套方法论 SKILL 全部在册，全部未接线。

#### 层③ 写回行动链 —— 一半具备，一半缺失

| 环节 | 本平台 | 判定 |
|---|---|---|
| 建记录/改字段 | 有，且带 awaiting_confirm / confirmed_role 等完整字段 | ✅ 具备 |
| HITL 批准 | 决策第 0 闸 + 审批流（已去硬编码） | ✅ **强于 Lightfield**（更细粒度、可审计） |
| 起草邮件 | 无（未见邮件生成与发送通道） | ❌ 缺失 |
| 外部富化（工商/LinkedIn/招投标） | connectors 目录仅有 tenderConnector（招投标），无企业工商/联系人富化 | ⚠️ 弱 |
| 停滞识别 | follow-reminder + funnelQuality 停滞监测 | ✅ 部分具备 |

---

## §4 三机制对齐度总表

| 机制 | 子项 | Lightfield | 本平台 | 差距性质 | 优先级 |
|---|---|---|---|---|---|
| ①Versioned memory | chronology | 故事时间线 | buildTimelineRows 已有，未注入模型 | **接线问题**（成本低） | P0 |
| | attribution | 叙事中隐含 | 七类根因 + PROV-O | **平台超出** | 保持 |
| | causality | 叙事中隐含 | 7 边规范，实落 3 类 | **落地欠账** | P1 |
| | state | LLM 派生 | 确定性计算 + 配置化 | **平台超出** | 保持 |
| ②Stories > graphs | 叙事注入 | 主路径 | 无（injector 只给 title/disposition） | **断层在注入层** | **P0** |
| | 语义检索 | 真 embedding | hashVector 占位 | 低成本可换 | P0 |
| | 图的定位 | 弃图 | 决策图应保留、实体图降权 | 需**分轨策略** | P1 |
| ③交易诊断 | 特征空间 | 非结构化抽取 | MANT/漏斗/TAORAN/BANTCC | **平台超出** | 保持 |
| | 跨样本模式挖掘 | 核心能力 | **无**（deal-analyze 仅单笔建议） | **能力缺失** | P1 |
| | 写回行动链 | 富化+建记录+起草+HITL | HITL 强，富化与起草缺 | 部分缺失 | P2 |

---

## §5 五条具体改造建议（含落点）

| # | 建议 | 落点 | 依赖 | 说明 |
|---|---|---|---|---|
| **1** | **先把叙事接进注入层**（三机制中 ROI 最高） | `src/context/injector.js:19-23`：L2 增加"当前实体故事线"块，消费 `buildTimelineRows`（`insightService.js:105`）产出；L1 由 title 改为 title + 摘要片段 | 无 | 不改采集、不改 schema，只改注入格式。验收：agent 回答"这个客户聊到哪了"时引用具体时间点事件 |
| **2** | **L1 embedding 换真** | `src/ontology/embedding.js`（已预留注入位），vector(384) 维度对齐 | 确认 SiliconFlow embedding 模型 | hashVector 只能指纹匹配，撑不起语义查询 |
| **3** | **补齐决策因果边写入** | `decisionRepo.js` 增补 DECIDED_ON（决策→客户/商机）、REFERENCED_PRECEDENT、OVERRIDES、DERIVED_FROM_EXCEPTION 写入点 | 先修 D4 | 让"这个客户身上发生过哪些决策"可追溯，是 versioned memory 的因果骨架 |
| **4** | **crm-deal-analyze 升级为跨样本归因** | `src/skills/seed.js:10-19`：step1 增取历史赢单/输单集合（按 stage/行业/金额分层），step2 prompt 由"推进建议"改为"与赢单集合对比找缺失要素 + 归因 + 建议动作"，调用 `method-role-map` 判定决策链缺口 | D4 修复后 | 先做**只读诊断**，不自动写回 |
| **5** | **先批准执行 D4 接线修复** | docs/2026-09-01-retro-agent-wiring-design.md（D4→D2→D1→D3） | 无 | 上述 4 条中第 1、4 条的收益都以 SKILL 真被调用为前提；七套方法论 SKILL 目前全是纸面能力 |

**不建议照搬的部分**：①不做外部富化（LinkedIn/工商）集成——国内销售场景 ROI 低且合规复杂，先做内部特征对比；②不做自动 schema remap——多租户下 schema 是契约；③不为"免录入"推翻现有结构化录入——本平台的阈值配置化 + 确定性计算是管理问责的地基，Lightfield 的 LLM 派生不可复算，恰是管理场景的短板。

---

## §6 风险与边界

1. **叙事注入的上下文成本**：完整时间线可能远超上下文窗口，需设计裁剪策略（近期优先 + 事实条目优先于话术条目 + 决策事件优先于例行拜访），不能全量灌入。
2. **叙事与图的一致性问题**：双轨意味着同一事实两种表达，需明确"图是权威、叙事是视图"或反之，并在叙事条目上带来源 id 以支持回查。
3. **跨样本归因的统计有效性**：本平台赢单/输单样本量若不足（尤其分层后），模式挖掘结论不可靠，需设最小样本阈值并在结论中标注置信度（可复用 `confidence` 列与 calibration 机制）。
4. **材料证据边界**：Lightfield 的客户效果数据为创始人自述，未经独立验证；"故事优于图"是其自有实验结论，非行业定论，本平台采纳前建议以自身数据做小规模对照验证。
5. **本文为分析建议，非实施授权**：任何条目进入实施须单独走 brainstorming → 设计文档 → 批准。
