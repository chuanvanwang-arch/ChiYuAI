# BUG 判定 + 四元组 / Oleg 七维 / 七决策边 三者关系

> 日期：2026-09-01
> 性质：证据驱动分析（含生产库只读探针实测）。**任何条目进入实施须单独走 brainstorming → 设计文档 → 批准。**
> 关联：`2026-09-01-tetrad-vs-7x7-and-story-vs-graph.md`（本文 §1.3 更正该文 F3 结论）

---

## §0 结论速览

### 问题一：这三件事不是同一性质，不能一律叫 BUG

| # | 现象 | 性质判定 | 级别 | 关键依据 |
|---|---|---|---|---|
| **A** | 注入层丢弃已装配字段 | **真 BUG**（实现缺陷） | **P1** | `assembler.js:72,76` 取回 `rationale`+`memories`，`injector.js:19,22` 只输出 `title` / `scenario:disposition` |
| **B1** | `OVERRIDES` 不进权威表 | **真 BUG**（纯遗漏） | **P1** | 它是 decision→decision，**FK 完全允许**，`decisionRepo.js:307` 却只 `addEdge` |
| **B2** | `DECIDED_ON` / `DERIVED_FROM_EXCEPTION` 存不下 | **架构偏离**（静默 spec deviation） | **P0** | 设计要 `to_particle` 列（`drillthrough-design.md:105,114,175`），实现表无此列；`decisionRepo.js:155-156` 注释自我承认但未回告评审 |
| **C** | 生产库 7 类边各 1 行、看板显示齐备 | **数据假绿**（非 bug，但更危险） | **P0** | 全部 `source='seed-script'`；`source<>'seed-script'` 行数 = **0** |
| **D** | `required_dims` 装弹状态 | **更正：不是缺口**（我上轮判错） | — | `scripts/seed-seven-dim.mjs` 已装 6 个场景 |
| **E** | 装弹 + 边写不进 | **定时误报炸弹** | **P0** | 装弹含 `identity/structure` → 应连边推出 `DECIDED_ON` → 运行时恒 `missing` |

### 判定标准（三问法）

| 问 | 真 BUG | 架构偏离 | 数据假绿 |
|---|---|---|---|
| ① 规范是否明确要求？ | 是（代码内契约） | 是（已批准设计文档） | — |
| ② 实现是否达成？ | 否 | 否 | 达成但靠种子 |
| ③ 未达成时是否留痕？ | 无痕 | **无痕（连失败 trace 都没有）** | 显示绿，掩盖真相 |

> B2 之所以比 B1 严重：**B1 是"忘了写"，B2 是"改了设计但没告诉任何人"**——代码注释里写着"走 JSONB 不进此表"，而设计文档里写着"要建 `to_particle` 列"。两条轨道各自正确，合起来是错的。

---

## §1 问题一：逐项判定

### A. 注入层把已装配的字段丢了 —— 真 BUG（P1，改动量最小、收益最大）

**装配层已经拿到的数据**（`src/context/assembler.js`）：

```js
// :72  SELECT decision_id, scenario_id, disposition, rationale FROM crm.decision ...
// :76  const m = await retrieveMemory({ topicLike: 'decision:%', limit: 5 })
// :77  return { decisions: r.rows, memories: m.rows };   // ← rationale + memories 都在 bundle 里
```

**注入层实际输出**（`src/context/injector.js`）：

```js
// :19  layers.L1.map(x => x.title).join('; ')                              // rationale 无
// :22  layers.L2.decisions.map(d => `${d.scenario_id}:${d.disposition}`)   // rationale 丢、memories 零注入
```

**定性**：不是"叙事功能没做"，而是**叙事数据已经装配到 bundle、在最后一厘米被丢弃**。这不是能力缺口，是格式串缺陷。

**规范对照**：`ai-context-layering` SKILL 要求 L2 产出"历史实例 + AI 派生属性"（`SKILL.md:93`）、供需判据 `historicalCases ≥ 3`（`:152`）。当前注入的 `scenario_id:disposition` 是**标签**，不是实例，未达 SKILL 规范。

**修复量**：一个格式串。不改采集、不改 schema、不改检索。

---

### B. 七类边：必须拆成三类，否则修复会开错药方

| 边 | 服务维度 | 方向 | 运行时写入点 | 权威表可写? | 生产库行 | 判定 |
|---|---|---|---|---|---|---|
| `DECIDED_ON` | identity, structure | decision→**粒子** | `decisionRepo.js:106` `addEdge`（仅 AGE） | ❌ FK 拒绝 | 1（seed，语义错） | **架构偏离** |
| `REFERENCED_PRECEDENT` | decision_history | decision→decision | `:152` AGE + `:157` 直插 PG | ✅ | 1（seed） | 已接线 |
| `DERIVED_FROM_EXCEPTION` | operational_state | decision→**异常** | `:188` `addEdge`（仅 AGE） | ❌ FK 拒绝 | 1（seed） | **架构偏离** |
| `ESTABLISHES_FRAME` | semantics, governance | decision→decision | `:179` `linkDecisions` 双写 | ✅ | 1（seed） | 已接线 |
| `OVERRIDES` | governance, decision_history | decision→decision | `:307` **只 `addEdge`** | ⚠️ 允许但未写 | 1（seed） | **真 BUG（遗漏）** |
| `CAUSED` | time_config | decision→decision | `:173` `linkDecisions` 双写 | ✅ | 1（seed） | 已接线 |
| `INFLUENCED` | time_config | decision→decision | `:176` `linkDecisions` 双写 | ✅ | 1（seed） | 已接线 |

**实测（生产库只读）**：

```
decision_relation 总数 = 7（每类各 1）
source <> 'seed-script' 的行数 = 0        ← 运行时零产出
来源：scripts/seed-decision-network.mjs:89（脚本头注释即写「7 类边齐备」）
```

#### B1 `OVERRIDES` —— 真 BUG

`OVERRIDES` 两端都是 decision，`db/schema.sql:494-495` 的 FK 完全允许它进权威表。但 `decisionRepo.js:307` 只调了 `addEdge`：

```js
// :307  await addEdge('OVERRIDES', String(s.decision_id), String(decision_id), { reason }).catch(() => {});
```

同文件 `:173/176/179` 的 `CAUSED/INFLUENCED/ESTABLISHES_FRAME` 都走了 `linkDecisions`（PG 权威 + AGE 双写），**只有 `OVERRIDES` 没走**。这是明确的遗漏，一行改动即可修复。

#### B2 `DECIDED_ON` / `DERIVED_FROM_EXCEPTION` —— 架构偏离（比 bug 更严重）

**设计契约**（`docs/2026-08-30-decision-drillthrough-design.md`，已批准）：

```sql
-- :105   to_particle   TEXT,          -- 指向 K 粒子 id（D2 载体）
-- :111   UNIQUE (from_decision, to_decision, to_particle, rel_type)
-- :114   物化时在 createDecision 内遍历 involved_entities 生成 DECIDED_ON→to_particle（D2 边）
-- :175   "D2_M_to_J": { "exists":true,  "carrier":"decision_relation.DECIDED_ON→to_particle" }
-- :257   T-D2 | decision_relation 迁移 + 物化时写 DECIDED_ON/REFERENCED_PRECEDENT
```

**实现**（`db/schema.sql:492-503`）：**没有 `to_particle` 列**，`from_id`/`to_id` 双双 `REFERENCES crm.decision(decision_id)`。

**实现者知道，并选择了变通**——`src/decision/decisionRepo.js:155-156`：

```
// 约束（schema.sql:492-493）：from_id/to_id 均 REFERENCES decision → 仅承载「决策↔决策」边；
// 「决策→粒子」联动走 decision.involved_entities(JSONB)，不进此表。
```

问题不在变通本身（走 JSONB 也说得通），而在于：**设计文档未同步、评审未回告、`D2_M_to_J` 契约项在代码里被单方面改判**。且因为代码根本没尝试写 PG，连 `recordFailure` 的失败 trace 都不会产生——**完全静默**。

#### C. 生产库"7 类边齐备"是种子数据

```
rel_type 分布：CAUSED/DECIDED_ON/DERIVED_FROM_EXCEPTION/ESTABLISHES_FRAME/
               INFLUENCED/OVERRIDES/REFERENCED_PRECEDENT  各 1
source：全部 = 'seed-script'
created_at：2026-08-31（两批：08:16 与 12:53）
```

更值得注意的：**种子脚本造的 `DECIDED_ON` 行 `to_is_decision = true`**——FK 迫使它指向 decision，而设计语义要求它指向商机/客户粒子。所以这条边**看起来 green，语义是错的**：巡检卡会据此判定 `DECIDED_ON: present`，掩盖真实缺口。

这正是项目记忆里的教训复现：**"看板全绿" ≠ "回路通"**。

---

### §1.3 更正上一轮结论（我判错了）

上轮 `2026-09-01-tetrad-vs-7x7-and-story-vs-graph.md` §F3 称"巡检卡从未装弹"，依据是 DDL 默认 `'[]'`。**生产库实测这是错的**：

| 场景 | 已装维度 |
|---|---|
| `CLIENT_STRATEGY` | 全 7 维（identity/structure/semantics/time_config/decision_history/operational_state/governance，均 warn） |
| `OPP_QUALIFY` | 全 7 维 |
| `LOSS_REVIEW` | 全 7 维 |
| `POST_CONTRACT` | 全 7 维 |
| `LEAD_FOLLOW_UP` | 5 维（identity/semantics/time_config/operational_state/governance） |
| `ATTR_SCHEMA_CHANGE` | 3 维（identity/structure/governance） |
| `CALIBRATION_CHANGE` | 空 |

装弹来源：`scripts/seed-seven-dim.mjs`（仅对空场景写入，不覆盖管理员调整）。DDL 默认 `'[]'` 只对**新建场景**成立。

---

### §1.4 由此升级出的 P0：装弹已完成 + 边写不进 = 恒误报

这条比原 F3 更值得排期：

1. `monitor/attribution.js:46` → `requiredEdgesForDims(requiredDims)` 推导应连边；
2. `edgeDimensionSpec.js:27` → `DECIDED_ON` 服务 `identity` + `structure`（`test/decision/edgeCompliance.test.js:27` 对此有断言）；
3. 因此**任何含 `identity` 或 `structure` 的场景** → `required_edges` 必含 `DECIDED_ON`；
4. 运行时写不进 → `required_missing` 恒含 `DECIDED_ON`（`attribution.js:49`）；
5. → `rootCauseClassifier.js:23` 的 `EDGE_MISSING` 分支会对**该场景每一条真实决策**误报。

**当前不红，只因为**：真实决策仅 9 条，且边是 seed 造的（含语义错误的 `DECIDED_ON` 假绿）。一旦真实决策量上来，6 个已装弹场景会系统性转红，且红色指向的是**结构缺陷**而非业务问题——管理员会按错误信号去调阈值，形成二次污染。

---

### §1.5 修复序（修订版）

| 序 | 项 | 动作 | 依赖 |
|---|---|---|---|
| **0** | 数据可信度隔离 | 看板区分「种子演示 / 运行时真实」；`source='seed-script'` 单独标记或建视图 | 无 |
| **1** | F1 结构扩容 | `decision_relation` 加 `to_type`（decision/particle/exception），或另建 `decision_entity_relation`（**推荐后者**，保持 FK 纯洁） | 无 |
| **2** | B1 补 `OVERRIDES` | `decisionRepo.js:307` 改走 `linkDecisions` | 无 |
| **3** | F3' 装弹自检 | S20 保存 `required_dims` 时校验「推出的应连边 ⊆ 可写边集合」，否则拦截并告警 | 序 1、2 |
| **4** | A 注入层补字段 | `injector.js` 补 `rationale` + `memories`（最低成本最高收益，可与 1-3 并行先做） | 无 |
| **5** | 端到端验证 | 造 1 笔真实决策，断言 `decision_relation` 出现 `source='engine'` 的 7 类边 | 序 1-4 |

> 序 3 必须在序 1、2 之后：先让边可写，再允许装弹，否则装弹即误报。

---

## §2 问题二：四元组 / Oleg 七维 / 七决策边 的关系

### §2.1 七个决策边（E1–E7）逐条

单一事实源：`src/decision/edgeDimensionSpec.js:16-33`

| # | 边 | 中文 | 含义 | 服务维度 | 方向 | 运行时状态 |
|---|---|---|---|---|---|---|
| E1 | `DECIDED_ON` | 针对 | 决策直接作用于某业务实体（客户/商机/报价） | identity, structure | decision→实体 | ❌ 仅 AGE |
| E2 | `REFERENCED_PRECEDENT` | 参考先例 | 决策引用了某历史先例作为依据 | decision_history | decision→decision | ✅ 已接线 |
| E3 | `DERIVED_FROM_EXCEPTION` | 由异常触发 | 决策由某异常/告警事件触发升级 | operational_state | decision→异常 | ❌ 仅 AGE |
| E4 | `ESTABLISHES_FRAME` | 确立标杆 | 决策确立了一个新的判定框架/标杆 | semantics, governance | decision→decision | ✅ 已接线 |
| E5 | `OVERRIDES` | 推翻翻案 | 后续决策推翻/覆盖本决策 | governance, decision_history | decision→decision | ⚠️ 漏接 |
| E6 | `CAUSED` | 直接引发 | 决策直接引发了下游决策或业务动作 | time_config | decision→decision | ✅ 已接线 |
| E7 | `INFLUENCED` | 间接影响 | 决策间接影响了其他上下文（弱于参考先例） | time_config | decision→decision | ✅ 已接线 |

> 补充：七边可由 `config_store['seven-dim'].edge_bindings` 覆盖（`edgeDimensionSpec.js:44-51`，fail-safe：配置非法回退默认，绝不阻断写边）。

### §2.2 Oleg 七维 —— 本平台的"七个抽屉"就是它

**原文**（Oleg Shilovitsky, *Correct AI Answer, Wrong Product Decision*, 2026-08-16）：

> "...that architecture as having seven dimensions: **identity** (are we discussing the same object across systems?), **structure** (how is it connected, and to what?), **semantics** (what does "approved" or "equivalent" mean in each domain?), **time and configuration** (when and where was it true?), **decision history** (why was this choice made?), **operational state** (what is happening right now?), and **governance** (what is allowed, and who is accountable?). The three failures above are not mysterious once you have these names."

**三失败案例的维度归属（原文）**：

| Oleg 案例 | 缺失维度 |
|---|---|
| 错误的版本（rev C vs rev E） | time & configuration |
| 技术上可行但未批准的替代品 | decision history + governance |
| 误导性的成本比较 | semantics + operational state |

**平台实例化**（`src/sevenDimensions/constants.js:5-13`，注释自陈）：

```
// Oleg Shilovitsky（OpenBOM）产品情境七维度 → CRM 决策场景完整性校验
identity 身份 / structure 结构 / semantics 语义 / time_config 时间与配置
decision_history 决策历史 / operational_state 运行状态 / governance 治理
```

`src/decision/edgeDimensionSpec.js:7` 亦标注 `// L1–L7 七维度（Oleg 七维度上下文模型）`。

**结论：本平台的"七个抽屉"不是自创，就是 Oleg 七维的 CRM 实例化。** 差异只在描述文案——Oleg 面向产品（BOM/供应商/产线），本平台面向销售（客户/商机/报价）。

### §2.3 Lightfield 四元组（客户记忆内容模型）

| 元 | 含义 | 平台对应 |
|---|---|---|
| **chronology** 时序 | 围绕人/公司的实时更新的故事化时间线 | `insightService.js:105 buildTimelineRows`（已实现，**未进注入层**） |
| **attribution** 归因 | 每条记忆的来源与归属 | `rootCauseClassifier.js:13-22` 七类根因 + PROV-O |
| **causality** 因果 | 事件之间的因果链 | E1–E7 七边 |
| **state** 状态 | 客户/交易的当前状态 | `funnelQuality.js:19-45` 确定性计算 + 配置化阈值 |

### §2.4 三者定位：正交三层，不是竞争关系

| | Lightfield 四元组 | Oleg 七维 | 本平台七边 |
|---|---|---|---|
| 学派 | **内容学**（记忆该装什么） | **诊断学**（缺什么会答错） | **证据学**（拿什么证明） |
| 视角 | 客户实体 | 决策情境 | 决策网络 |
| 输出 | 记忆是否**完整** | 情境是否**充分** | 校验是否**通过** |
| 可机器校验 | 弱（需 LLM 判） | 中（需维表配置） | 强（SQL 可查） |
| 失败表现 | 忘了记 | 答错且不知错 | 巡检卡红 |

**类比**：四元组 = 病历应写哪些项；七维 = 术前核查表（少查哪项会出事故）；七边 = 核查表上每一项的**签字记录**（可被审计、可被计数）。

三者串联成一条链：

```
叙事（chronology）  →  抽取因果动词  →  E1-E7 边  →  7×7 巡检（七维体检）
    内容层                 转换层            证据层            诊断层
```

### §2.5 交叉映射（核心）

#### 七维 × 七边（平台既有官方映射）

`edgeDimensionSpec.js:26-33`，与 `docs/2026-08-30-decision-quality-closed-loop-redesign.md:96` 一致：

| 维度 | 由哪些边服务 |
|---|---|
| identity | `DECIDED_ON` |
| structure | `DECIDED_ON` |
| semantics | `ESTABLISHES_FRAME` |
| time_config | `CAUSED`, `INFLUENCED` |
| decision_history | `REFERENCED_PRECEDENT`, `OVERRIDES` |
| operational_state | `DERIVED_FROM_EXCEPTION` |
| governance | `ESTABLISHES_FRAME`, `OVERRIDES` |

#### 四元组 × 七维（本轮推导，此前未显式化）

| 四元组 | 供给哪些维度 | 说明 |
|---|---|---|
| **state** 状态 | `operational_state`, `structure`, 部分 `semantics` | 当前状态直接回答"现在发生了什么""结构是否齐备" |
| **chronology** 时序 | `time_config`, `decision_history` | 时间线回答"何时为真""此前做过什么选择" |
| **attribution** 归因 | `decision_history`, `governance` | "为何这么选""谁负责/谁批" |
| **causality** 因果 | **七边整体** | 七边就是因果的动词化 |
| **（四元组无对应）** | **`identity`, `semantics`** | ← **Lightfield 的盲区** |
| **（七维无对应）** | **chronology 的"叙事形态"** | ← **本平台的盲区**，即 §1-A 的 BUG |

#### 四元组 × 七边（对角关系）

| 四元组 | 对应边 | 关键洞察 |
|---|---|---|
| causality | **全部 7 边** | 七边即因果动词（针对/参考/触发/确立/推翻/引发/影响） |
| attribution | `OVERRIDES`, `REFERENCED_PRECEDENT`, `DERIVED_FROM_EXCEPTION` | "为什么这么判"的三类依据 |
| state | `DECIDED_ON` | 作用在哪一实体、该实体结构是否齐备 |
| chronology | **部分承载**：`CAUSED`/`INFLUENCED`（偏序）+ `REFERENCED_PRECEDENT`/`OVERRIDES`（回溯链） | ⚠️ 见下方修订——边只承载 chronology 的**骨架**，承载不了**时间轴本身** |

> **【2026-09-01 修订】原表述"七边无法承载 chronology"过于绝对，精确化为：**
>
> **边是因果谓词，时间是坐标系。谓词可落在坐标上（`decision_relation.created_at`，`schema.sql:501`），但谓词不等于坐标。** 七边承载 chronology 的**骨架**（决策间偏序、先例引用链、翻案链），承载不了 chronology 的**血肉**（全序时间轴、事件密度与沉默期、非决策类事件）。补边补的是"因为"，补不出"然后"。
>
> 故原结论仍成立：故事线必须是独立一层，§1-A（叙事进注入层）与 §1-B（补边）并行不可互相替代——但理由不是"边与时序无关"，而是"边只覆盖 chronology 的决策子集"。详见 §2.5b。

### §2.5b 追问：七维有 `time_config` / `decision_history`，为何仍说边承载不了时序？

**（2026-09-01 追加。回应质疑：既然七维里有两个时间相关维度，且它们由边服务，"边承载不了 chronology"是否自相矛盾？）**

#### 1. 先摆事实：这两个维度在七边里对应哪几条

| 七维 | 服务它的边 | 证据 |
|---|---|---|
| `decision_history` | `REFERENCED_PRECEDENT`、`OVERRIDES` | `edgeDimensionSpec.js:32, :35` |
| `time_config` | `CAUSED`、`INFLUENCED` | `edgeDimensionSpec.js:36, :37` |

质疑成立——**七边确实服务着两个时间相关维度，说"边与时序无关"是错的**。

#### 2. 但 `time_config` 是两半，只有一半由边承载（平台内部的反证）

`time_config` 在本平台有两处定义，均含两半：

- `edgeDimensionSpec.js:11` —「时效与时机窗口（决策是否在有效期内）」
- `sevenDimensions/constants.js:9` —「决策生效时间窗 / **产品线 / 配置版本**」

| `time_config` 的两个成分 | 实际承载体 | 是不是边 |
|---|---|---|
| ① 时间窗 / 先后偏序 | `CAUSED`、`INFLUENCED` | ✅ 是边 |
| ② 产品线 / 配置版本有效性 | `decision.effective_policy_version` → `crm.policy_version`（`effective_from` / `effective_to` / `snapshot`） | ❌ **是行内 FK + 时态表，不是边** |

证据：`schema.sql:161`（`effective_policy_version TEXT REFERENCES crm.policy_version`）、`schema.sql:148-149`（`effective_from TIMESTAMPTZ NOT NULL` / `effective_to TIMESTAMPTZ`）。

**这条是本平台自己的反证**：设计者用"决策行上的外键 + 版本时态表"承载 time_config 的配置一半，而不是用边。说明**"七维由七边承载"这个隐含等式在平台内部本就不成立**——七维的承载体是**混合的**：行内字段 ⊕ 边 ⊕ 外部事件源。

#### 3. 精确化后的三层：边给"因为"，轴给"然后"

`chronology`（四元组之一）可分解为四个成分，只有两个被七维覆盖：

| chronology 成分 | 是否被七维覆盖 | 平台承载体 |
|---|---|---|
| ① **事件流**（多源、全序、带密度/沉默期） | ❌ **无任何维度覆盖** | `buildTimelineRows`（`insightService.js:106`） |
| ② 决策历史回溯链 | ✅ `decision_history` | `REFERENCED_PRECEDENT` / `OVERRIDES` |
| ③ 时态有效性（哪个版本何时有效） | ✅ `time_config` 的一半 | `policy_version.effective_from/to`（非边） |
| ④ 因果先后 | ✅ `time_config` 的另一半 + `causality` | `CAUSED` / `INFLUENCED` |

**集合关系：`chronology ⊋ (time_config ∪ decision_history)`**，严格超集。多出来的正是"事件流"——而它恰是故事线的主体。

#### 4. 三个边结构性做不到的点（修订后保留的核心理由）

| # | 缺口 | 理由 | 证据 |
|---|---|---|---|
| 1 | **偏序 ≠ 全序** | `CAUSED(A→B)` 只蕴含"A 早于 B"，是二元偏序；两条无连接的因果链之间**谁先发生不可判定**。而 `buildTimelineRows:115` 对所有源按 `ts` 排序 = 全序 | `insightService.js:115` |
| 2 | **无密度、无沉默期** | 边不携带时间间隔。"35 天无接触"在图上完全不可见——而停滞/复活恰是销售场景最强信号之一 | `decision_relation` 仅 `created_at`（`schema.sql:501`） |
| 3 | **粒度错配（最致命）** | 边两端是 `decision→decision`（`DECIDED_ON` 除外），而 `loadTimelineSources` 的四源里 **3/4 不是决策**（`events` / `tasks` / `memory_log`）——结构上进不了边网络 | `insightService.js:244-278` |

#### 5. 一句话定论

> **边给故事线加"因为"，时间轴给故事线加"然后"。二者正交，缺一不可。**
> 只有边没有轴：知道 A 导致 B，不知隔了 3 天还是 3 个月；
> 只有轴没有边：知道发生了什么，不知为何发生（只能靠 LLM 现场推断，且不留痕、不可复算）。

这也解释了 Lightfield 与本平台的分工差异：Lightfield 只留叙述、因果由 LLM 读时推断（灵活但不可审计）；本平台**双轨都有**（时间线 + 决策因果图），**却双双没进注入层**——这才是 §1-A 那个 BUG 的实质，也是 ROI 最高的修复点。

#### 6. 【新发现】三处时间基准不一致 → 拟列 BG-08

| 位置 | 使用的时间列 | 语义 |
|---|---|---|
| L2 上下文装配（`assembler.js:73`） | `decided_at DESC` | 业务发生时间 |
| 叙事时间线（`insightService.js:262`） | `created_at` | 记录创建时间 |
| 决策边（`schema.sql:501`） | 仅 `created_at` | 记录时间，无业务发生时间 |

HITL 场景下二者必然分离：`decisionRepo.js:271`（`confirmDecision`）将 `decided_at` 更新为 `now()`，`:340` 另记 `human_decided_at`；`calibration/metrics.js:38-39` 正是在计算 `human_decided_at - created_at` 的审批时延。

**后果**：第 0 闸 / 人工审批的决策，在 L2 与故事线上的**排序会不一致**，且与因果边的时间基准（记录时间）对不上。生产库当前 12 条决策 `gap_hours` 全为 `0.00`（均自主决策，未走 HITL），故尚未暴露。

**修复建议**：BG-01b 叙事进注入层时统一时间基准为 **`decided_at`（业务发生时间），`created_at` 兜底**；`decision_relation` 增列 `valid_from` / `valid_to`（尤其 `OVERRIDES` 需"自某时起被覆盖"的生效时点），使边成为真正的**时态边**。

### §2.6 双向盲区

| 盲区 | 归属 | 后果 | 补法 |
|---|---|---|---|
| 四元组缺 `identity` / `semantics` | Lightfield | 跨系统身份一致、术语一致无从校验 | 本平台已有粒子 `stable_key` + `ESTABLISHES_FRAME`，是差异化优势 |
| 七维缺"叙事形态" | 本平台 | 模型拿到标签而非故事 | 复用 `buildTimelineRows` 接进注入层（§1-A） |

### §2.7 合成：一条合格决策记忆的判据

四个必答问题，缺一不可：

| 判据 | 载体 | 平台现状 |
|---|---|---|
| ① 时间线上发生了什么？ | 叙事（`buildTimelineRows`） | 已实现，**未注入** |
| ② 当前状态是什么？可复算吗？ | 确定性结构化计算（MANT/漏斗分区/阈值） | ✅ 强于 Lightfield |
| ③ 为什么这么判？ | 七类根因 + PROV-O 溯源 | ✅ 强于 Lightfield |
| ④ 因果链可查吗？ | E1–E7 边（SQL 可查） | ⚠️ 规范完整，运行时 0 行 |

且必须能被**七维逐项体检**，体检的证据是**七边**，体检发现的缺失项要能落回**四元组**的某一元——三者构成闭环，缺任何一个，闭环都不成立。

---

## §3 一句话总结

**问题一**：三件事性质不同。注入层丢字段与 `OVERRIDES` 漏接是**真 BUG**（一行到几行可修）；`DECIDED_ON`/`DERIVED_FROM_EXCEPTION` 是**静默的架构偏离**（改了设计未回告，比 bug 更需优先处理）；生产库"7 类边齐备"是**种子数据假绿**。最紧急的不是补边，而是**装弹已完成 + 边写不进**这条定时误报链。

**问题二**：三者正交。四元组是**内容学**（记什么）、Oleg 七维是**诊断学**（缺什么会错，且本平台"七个抽屉"就是它）、七边是**证据学**（拿什么证明）。七边是四元组中 causality 的可执行投影，也服务 `time_config`/`decision_history` 两个时间相关维度——但**只覆盖 chronology 的决策子集**（骨架），时间轴本身（全序、密度、非决策事件）必须由 `buildTimelineRows` 独立承载。这正是 §1-A 那个 BUG 的实质：我们有故事线装配器，却把它关在了注入层门外；双轨（时间线 + 因果图）**双双未进模型**。
