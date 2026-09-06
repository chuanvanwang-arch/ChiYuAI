# 客户四元组 vs 7×7 决策矩阵；故事时间线 vs 上下文图谱
> 日期：2026-09-01　作者：WorkBuddy（分析建议，未进入实施）
> 输入：Lightfield versioned customer memory（chronology/attribution/causality/state）、"stories over graphs" 博客论证；本平台 `src/decision/*`、`src/context/*`、`db/schema.sql`、`db/migrate-config.sql` 实证
> 性质：**概念辨析 + 缺口定位**。任何条目进入实施须单独走 brainstorming → 设计文档 → 批准。

---

## §0 一句话结论

1. **四元组与 7×7 不是竞争关系，是上下层**：四元组规定「记忆要回答哪四个问题」（内容模型），7×7 规定「一次决策是否站得住」（校验矩阵）。本平台**只有下层没有上层**——E 边规范齐备但无人生成叙述，导致 7 类边只有 3 类进权威表。最优解是**两层合并、中间用「叙述 → E 边抽取」连接**。
2. **本平台用的不是「上下文图谱」，是「三层检索 + 两张图」，而喂给模型的只是其扁平投影**——既不是图也不是故事，是标签列表。所以「图 vs 故事」在本平台是**伪命题**，真问题是「两者都没进上下文」。取舍判据应当换成**事实/解释二分**：真值不随对话改变的走图+确定性计算，随对话改变的走叙事。

---

## §1 四元组 vs 7×7：不是同一个层级，无法直接比「好坏」

### 1.1 各自的本体定位

| | Lightfield 四元组 | 本平台 7×7 |
|---|---|---|
| 类别 | **记忆内容模型**（memory content model） | **决策质量校验矩阵**（audit checklist） |
| 回答的问题 | 一条客户记忆必须涵盖哪四类信息 | 一次决策在七个维度上是否站得住 |
| 作用对象 | 客户/人（实体） | 决策事件（event） |
| 判据 | 完整性（缺一类则记忆不完整） | 合规性（缺一维/一边则决策不合规） |
| 类比 | 病历的内容规范 | 手术的术前核查表（WHO checklist） |

**结论：正交。** 把它们放在天平两端比较是范畴错误。强行比较：

| 维度 | 谁更强 | 依据 |
|---|---|---|
| 记忆内容完整性 | **四元组** | 它规定了「记什么」；7×7 完全不管内容 |
| 决策可审计性 | **7×7** | Lightfield 没有「决策」一等公民，无法回答「这个判断依据哪条先例、被谁推翻、后来结果如何」 |
| 工程可落地性 | **7×7** | 本平台已有表、有代码、有校验函数；四元组目前只是概念 |

### 1.2 唯一的重叠点：两者都在处理「因果」——且恰好是上下层

- 四元组的 **causality** = 语义层的「为什么」，自然语言叙述，LLM 生成；
- 7×7 的 **E1–E7 边** = 结构层的「因果」，类型化、可查询、可计数、可校验。

**E 边就是 causality 的可执行投影。** 把四元组的 causality 看作「叙述」，E1–E7 就是叙述里的**动词**：

| E 边 | 在叙述中对应的动词 | 本平台写入位置 | 权威表可存？ |
|---|---|---|---|
| `DECIDED_ON` | 这条叙述**作用在**哪个实体上 | `decisionRepo.js:106` `addEdge`（仅 AGE） | ❌ 靶是粒子，FK 不匹配 |
| `REFERENCED_PRECEDENT` | 这条叙述**援引了**哪段历史 | `decisionRepo.js:156-160`（独立表 `decision_precedent_rel`） | ❌ 不在 `decision_relation` |
| `OVERRIDES` | 这条叙述**推翻了**哪条旧叙述 | `decisionRepo.js:307` `addEdge`（仅 AGE） | ❌ 未走 `linkDecisions` |
| `CAUSED` | **直接引发** | `decisionRepo.js:174` `linkDecisions` | ✅ |
| `INFLUENCED` | **间接影响** | `decisionRepo.js:178` `linkDecisions` | ✅ |
| `ESTABLISHES_FRAME` | **确立标杆**（成为后续判定框架） | `decisionRepo.js:179` `linkDecisions` | ✅（需调用方显式传 `establishes_frame_for`） |
| `DERIVED_FROM_EXCEPTION` | **由什么异常触发** | `decisionRepo.js:188` `addEdge`（仅 AGE） | ❌ 靶是异常，FK 不匹配 |

**这就是上一轮「7 类边只落 3 类」的根因，且比原先判断更严重——是结构性的，不是配置性的。**

---

## §2 7×7 的三处结构性缺陷（本轮新发现，可直接排期修复）

### F1：两条边在权威表里**物理存不下**

`db/schema.sql:492-503`：

```sql
CREATE TABLE crm.decision_relation (
  from_id UUID NOT NULL REFERENCES crm.decision(decision_id),
  to_id   UUID NOT NULL REFERENCES crm.decision(decision_id),   -- ← 双双 FK 到 decision
  rel_type TEXT NOT NULL CHECK (rel_type IN ('DECIDED_ON', ..., 'DERIVED_FROM_EXCEPTION')),
  ...
```

而 `DECIDED_ON` 的语义是 `decision->entity`（`edgeDimensionSpec.js:26` direction: `'decision->entity'`），靶是**业务粒子**；`DERIVED_FROM_EXCEPTION` 语义是 `decision->exception`（同文件 :28），靶是**异常事件**。
→ **枚举允许、外键拒绝**，这两类边永远只能活在 AGE 镜像里，而 AGE 是可降级的（`ageGraph.js` 降级纪律）。

### F2：`OVERRIDES` / `REFERENCED_PRECEDENT` 未走统一写入口

`relation.js:36` 的 `linkDecisions()` 是「PG 权威 + AGE 镜像」双写入口，但：
- `decisionRepo.js:307` 直接 `addEdge('OVERRIDES', ...)` → **只写 AGE，权威表无记录**。而 `OVERRIDES` 两端都是 decision，FK 完全允许进权威表 → 这是**纯遗漏型真 BUG**，一行可修；
- ~~`REFERENCED_PRECEDENT` 落独立表 `decision_precedent_rel`，权威表看不到~~ → **此项初版判定有误**：`decisionRepo.js:143` 写 `decision_precedent_rel` 的同时，`:157` 已直插 `decision_relation`（`source='engine'`），权威表**可见**。它与 `decision_precedent_rel` 是双写而非替代。

### F3：巡检卡「已装弹」——本条结论已实测更正（2026-09-01）

> ⚠️ **本节初版判定有误，以下为更正版。** 初版据 DDL 默认 `'[]'` 推断"巡检卡从未装弹"，生产库只读探针实测推翻了该推断。

- 初版依据：`db/migrate-config.sql:82` 的 `DEFAULT '[]'`——**该默认值只对新建场景成立**；
- 实测（生产库）：`scripts/seed-seven-dim.mjs` 已完成装弹，`CLIENT_STRATEGY`/`OPP_QUALIFY`/`LOSS_REVIEW`/`POST_CONTRACT` 各 7 维、`LEAD_FOLLOW_UP` 5 维、`ATTR_SCHEMA_CHANGE` 3 维（含 identity+structure）、`CALIBRATION_CHANGE` 空；
- **结论升级为更严重的一条**：装弹已完成，而 `DECIDED_ON` 运行时写不进权威表（F1）→ `requiredEdgesForDims()`（`attribution.js:20-31`）对含 `identity`/`structure` 的场景恒推出 `DECIDED_ON` → `required_missing` 恒非空 → `rootCauseClassifier.js:23` 的 `EDGE_MISSING` 分支会**系统性误报**；
- 当前看板不红，仅因真实决策量小（9 条）且边为种子数据（含语义错误的 `DECIDED_ON` 假绿）。

**另一项实测更正**：生产库 `decision_relation` 有 7 行（每类各 1），但全部 `source='seed-script'`，`source<>'seed-script'` 行数 = **0**——即"7 类边齐备"来自 `scripts/seed-decision-network.mjs:89`，运行时零产出。详见 `docs/2026-09-01-bug-verdict-and-tetrad-7dims-7edges-mapping.md` §1。

**修复顺序建议（更正版：装弹已完成，故自检改为「存量装弹复核」而非「装弹前拦截」）**：

| 序 | 修复 | 要点 |
|---|---|---|
| 0 | 存量装弹复核 + 数据可信度隔离 | 对已装弹的 6 个场景跑一次「应连边 ⊆ 可写边」核对；看板区分「种子演示 / 运行时真实」（全部 7 行均为 `source='seed-script'`） |
| F1 | 结构扩容 | `decision_relation` 加 `to_type`（`decision`/`particle`/`exception`）并放宽 FK，或另建 `decision_entity_relation`（保持 FK 纯洁，推荐） |
| F2 | 统一入口 | `OVERRIDES` 改走 `linkDecisions`（`REFERENCED_PRECEDENT` 已双写，无需改） |
| F3' | 保存时自检 | S20 保存 `required_dims` 时校验「推出的应连边 ⊆ 当前可写边集合」，否则页面告警并拒绝 |
| — | 端到端验证 | 造 1 笔真实决策，断言 `decision_relation` 出现 `source='engine'` 的 7 类边 |

---

## §3 「对决策到底如何划分」——本平台是四轴划分 + 一轴横切校验

决策的**划分**（partition）与决策的**校验**（validation）是两件事，7×7 属于后者，不参与划分。

| 轴 | 取值 | 载体 | 作用 |
|---|---|---|---|
| **① 场景轴（主划分）** | 11 个 `scenario_id` = 8 业务阶段场景 + 3 meta 场景 | `db/seed.sql:227-283` `decision_scenario` | 决定触发条件 `trigger`、绑定方法论 `methodology_ids`、业务判据 `eval_dimensions`（含权重）、`autonomous_allowed`、`dispositions` 枚举 |
| **② 风险轴** | `LEAD`/`NORMAL`/`HIGH` + `business_tier_config` | `schema.sql:121, 201` | 决定闸的强度（谁批、批几级） |
| **③ 主体轴** | `decider_type`（agent/human/系统） | `schema.sql:163-165`，与 `human_*` 四列严格分离 | 区分「引擎判给谁」与「人实际怎么判」，支撑 autonomy override rate 统计 |
| **④ 处置轴** | `APPROVE`/`REJECT`/`ESCALATE`/`OVERRIDE`/`EXCEPTION` | `schema.sql:123` | 决策的结论 |
| **⑤ 7×7（横切校验，非划分）** | 7 维度 × 7 边 | `edgeDimensionSpec.js` + `monitor/attribution.js` | 每个决策都要过的术前核查，与场景无关 |

8 个业务阶段场景（与销售 L2C 主轴一一对应）：
`LEAD_FOLLOW_UP`（线索跟进）→ `OPP_QUALIFY`（机会评估）→ `CLIENT_STRATEGY`（客户策略）→ `SOLUTION_VALUE`（方案价值）→ `QUOTE_PRICING`（商务报价）→ `SIGN_RISK`（签单前风险）→ `POST_CONTRACT`（终局决策）→ `LOSS_REVIEW`（丢单复盘）；
3 个 meta 场景：`ATTR_SCHEMA_CHANGE`（属性元模型变更）、`CALIBRATION_CHANGE`（校准参数变更）、`EXTERNAL_ENRICHMENT`（外部数据写入）。

**与 Lightfield 的本质差异**：Lightfield **没有决策划分这个概念**——它只有「一条客户记忆 + 状态派生」，不存在决策事件一等公民。这恰是本平台差异化的核心：

> **Lightfield 记的是「发生了什么」；本平台记的是「我们据此判了什么、判得对不对」。**
> 前者是记忆，后者是可问责的决策台账。

因此**不应用四元组替换 7×7**，正确形态是：

```
四元组（记忆层：记什么）  ──叙述→E 边抽取──▶  7×7（校验层：判得对不对）
  原始记录 → chronology+attribution 叙述
                ↓ 抽取动词
          E1–E7 边落权威表
                ↓
          7×7 巡检卡 + 根因分类 + 校准处方
```

---

## §4 故事时间线 vs 上下文图谱：先纠正概念，再谈取舍

### 4.1 本平台用的不是「上下文图谱」

需区分三样东西，没有一样是 Lightfield 所说的「图谱」：

| 名称 | 实际是什么 | 证据 |
|---|---|---|
| `crm.edges` | 粒子**实体关系图**，受控谓词（belongs_to/owned_by/part_of…） | `db/schema.sql:33-47` |
| `crm_decision_network`（AGE） | **决策因果图**，7 类边；PG 权威 + AGE 镜像，AGE 降级时全靠 PG | `src/decision/ageGraph.js`、`relation.js` |
| L1–L4 分层装配 | **分层检索**（知识底座/历史决策/执行协同/治理决策），不是图 | `src/context/assembler.js` |

> 「J1 上下文图谱(groundedness)」（`src/decision/retro.js:31`）指的是**可溯源性**（每个结论能追到源），不是图数据结构。

**所以本平台的实际形态是「三层检索 + 两张图」，而喂给模型的是第三样的扁平投影。**

### 4.2 喂给模型的既不是图，也不是故事——是标签列表

```js
// src/context/injector.js:19-23
L1 → layers.L1.map(x => x.title).join('; ')                    // 只有标题，无正文
L2 → decisions.map(d => `${d.scenario_id}:${d.disposition}`)   // 只有 场景:处置，无时间/因果/叙述
```

叠加两条放大器：
- **L1 用哈希向量**：`src/ontology/embedding.js:5` `hashVector`——只有指纹级匹配，撑不起语义检索；
- **L3 KG 降级**：`src/agent/agents.js:2` 断言 5「KG 就绪(降级)」。

**结论：本平台不存在「图 vs 故事」的取舍问题，因为两者都没进上下文。** Lightfield 说「图让模型 hold the edges too firmly」，我们的情况更糟——模型连边都没拿到。

### 4.3 真正的取舍判据：事实/解释二分，而非图/叙事二分

判据应换成：**这条信息的真值会不会随对话改变？**

| 类别 | 特征 | 载体 | 要求 |
|---|---|---|---|
| **事实**（不随对话改变） | 交易金额、谁在何时签了什么、决策 A 推翻决策 B、MANT 齐全性、漏斗分区 | **图 + 确定性计算** | 越硬越好，必须可复算 |
| **解释**（随对话改变） | 客户为什么犹豫、CISO 立场如何变化、话术与事实的冲突 | **叙事时间线** | 越软越好，必须可覆盖 |

- 事实侧走硬结构，正是 **Lightfield 的盲区**：它的 state 由 LLM 从对话派生，不可复算，管理场景无法问责；
- 解释侧走软叙事，正是 **硬图的问题**：一旦写死「张总反对」，后续对话中他转为支持，图不会自己改。

本平台已有这条二分的实现基础：**`method-fact-vs-script` SKILL**（在册，因 D4 从未被调用）——事实条目稳定、话术条目可被后续事实覆盖。可直接升级为**叙事权重规则**，把「动态重加权」做成可解释规则而非黑箱。

### 4.4 取舍结论（三条）

1. **保留两张图，但只当审计资产，不当理解资产。**
   决策因果图用于追溯、审计、计数（`graphAnalytics.js` 度数中心度 / 下游影响规模），这些叙事做不到。客户实体图降权，理解层交给叙事。
2. **新建叙事时间线作为理解资产，接进注入层。**
   复用 `buildTimelineRows`（`src/account/insightService.js:105`）——已是合格装配器：多源事件统一时间线、按 ts 倒序、同秒同实体去重、带 `actor`/`source`/`entity`/`summary`。**它今天只供客户 360 页面渲染，未进模型。** 改造只是把 injector 的 L2 从 `scenario:disposition` 换成时间线条目。
3. **图的「硬」用可推翻机制化解，不用弃图化解。**
   `OVERRIDES` 边就是图的版本控制——只是它现在只写 AGE（`decisionRepo.js:307`）。把 `OVERRIDES` 落权威表（§2 F2），图就获得「边可失效」能力，Lightfield 说的「边太硬」在结构层即被解决。

### 4.5 建议的注入形态（三层同喂，不是二选一）

```
【上下文】
  L4 角色与数据范围
  客户画像（结构化字段：MANT / 漏斗分区 / 金额）        ← facts，稳定
  故事时间线（最近 N 条，倒序，带 actor/source/ts/summary） ← narrative，可覆盖
  本场景判定规则（methodology_ids + 配置化阈值）         ← 确定性，可审计
  相关历史决策（disposition + rationale + 是否被 OVERRIDE）← 图的骨架，带失效标记
```

关键设计点：
- **时间线条目带 `superseded_by`**：后发生的同类条目在注入时压掉先前的（不是删除，是「注入时不呈现」）——这就是**叙事的版本化**，与图的 `OVERRIDES` 边成对；
- **每条叙述必须带源事件 id**（provenance）：复用 `crm.decision_provenance` 既有模式，否则叙事不可审计；
- **窗口策略**：默认最近 20 条 + 语义 top-k（top-k 需先换真 embedding，否则无语义检索能力）。

---

## §5 缺口与行动项（按 ROI 排序）

| 序 | 行动 | 证据 | 收益 | 依赖 |
|---|---|---|---|---|
| 0 | **批准 retro-agent-wiring（D4 接线）** | `src/agent/agentLoop.js:63` 恒 `crm-skill-fallback` | 不修此步，下述所有 SKILL 消费类收益均为零 | 设计已在待评审 |
| 1 | **叙事接进注入层** | `injector.js:19-23` × `insightService.js:105` | 不理解层从「标签」升级为「故事」；不改采集、不改 schema | 无 |
| 2 | **F3' 装弹自检 + F1/F2 补边** | `migrate-config.sql:82`、`schema.sql:494-495`、`decisionRepo.js:307` | 7×7 从「残三边」变为真七边，巡检卡可安全启用 | 无 |
| 3 | **embedding 换真** | `embedding.js:5`、列已 `vector(384)` | 解锁语义 top-k，叙事窗口可被压缩（省 token） | 确认 SiliconFlow embedding 模型 |
| 4 | **crm-deal-analyze 升级为跨样本归因** | `src/skills/seed.js:10-19` 仅单笔 LLM 建议 | 补「赢输单模式挖掘」，调 `method-role-map` 判决策链缺口 | 序 0 |
| 5 | **method-fact-vs-script 升为叙事权重规则** | SKILL 在册未调用 | 让叙事可解释、可覆盖、可审计 | 序 0、1 |

### 明确不建议照搬的三项

| 项 | 理由 |
|---|---|
| 用 LLM 派生 state 替代确定性计算 | 不可复算 = 管理问责失效，恰是本平台相对 Lightfield 的优势 |
| 自动 schema remap | 多租户下 schema 是契约，自由演化与配置治理冲突 |
| 为「免录入」推翻结构化录入 | 确定性计算依赖结构化输入；正确做法是「原始记录 + AI 派生」双层，而非二选一 |

---

## §6 定位陈述（可直接对外使用）

> **Lightfield 让记忆自由生长；我们让记忆可问责。**
> 它回答「客户身上发生了什么」，我们回答「我们据此判了什么、依据哪条先例、被谁推翻、结果验证了吗、判错了调哪个旋钮」。
> 对有治理诉求的销售组织，**可问责的记忆比自由生长的记忆更值钱**。
