# 决策问责闭环基础设施（C-DAI）设计 v2：三图闭环

- 日期：2026-08-30（v2 重设计）
- 承接：原 `2026-08-30-semantica-decision-accountability-design.md`（G1–G7 借鉴自研）
- 最新要求源（在途实施，须对账）：
  - `2026-08-30-j2-j3-comprehensive-design.md`（J2 反馈回路 + J3 校准层四维度改造，T15–T32）
  - `2026-08-30-full-traceability-root-cause-design.md`（四层全链路溯源 J→M→K→粒子库 + J3 根因归因，T1–T24）
- 方法论依据：`ai-bypass-process-enhancement`（集成治理层）+ `ai-capability-audit` + `ai-memory-lifecycle`（M）+ `ai-context-layering`（K）+ `ai-feedback-loop`（J2/J3）
- 状态：**待批准**（批准前不写实现代码）

---

## §0 执行摘要（先结论）

两篇文章（《9.6K Star，一款 Agent 决策问责项目》小成同学 2026-08-21；《告别Agent黑盒！开源1W+Star基座Semantica》江狐随笔 2026-08-23）指向同一开源项目 **Semantica**（GitHub 2026-08 约 8–9.6K Star，MIT，v0.6.5，Python 3.8+）：**图原生的上下文与决策问责基础设施**。它解决的不是"让 AI 更聪明"，而是"半年后有人追问当时为什么这么决定时，团队拿得出当时的来源、规则和策略"。

**核心判定不变：本平台不引入 Semantica，采用「借鉴自研」形态（方案 C）。** 三条铁律（重依赖不进内核 / 只补真缺口 / 单一事实源）在 2026-08 外部新信号下被进一步坐实（见 §6）。

**v2 重构要点（与初版的本质区别）**：初版以"G1–G7 平铺缺口"组织，未反映两份在途闭环设计。本版以 **Semantica 明确区分的三层图模型** 为骨架，重定位为——**C-DAI 是 K/M/J 三图各自闭环的确定性底座**：

| 闭环 | 对应图 | 对应系统 |
|---|---|---|
| **知识图谱闭环** | K | 知识系统（particles + 受控谓词 edges + meta_attr） |
| **上下文图谱闭环** | M | 记忆系统（L1–L7 维度 + E1–E7 边 + 不可变快照） |
| **决策图谱闭环** | J | 决策脊柱（J1 上下文图 / J2 反馈 / J3 校准） |

Semantica 三层图（KG / Context Graph / Decision Graph）即本平台 K/M/J 的实例化；差异仅在于我们多了"反馈→校准→重跑"智能层（J2/J3），这正是 Semantica 完全没有的。**每个图自身就是一个构建—使用—进化的闭环生命体**，C-DAI 的 G1–G7 + 6.1–6.6 是让三个闭环跑起来的确定性设施。

---

## §1 三图模型总览（K/M/J ↔ Semantica 三层图）

| Semantica 三层 | 本平台 | 数据载体（证据） | 一句话 |
|---|---|---|---|
| **Knowledge Graph**（世界如何组织） | **K 知识系统** | `crm.particles`（`schema.sql:11-45`）+ `crm.edges`（受控谓词）+ `crm.meta_attr`（`schema.sql:322-344`） | 实体/属性/关系的客观世界 |
| **Context Graph**（Agent 当时知道什么） | **M 记忆系统** | `crm.decision`（七点 Schema `schema.sql:153-174`）+ memory 三构件（`schema.sql:217-277`）+ `decision_relation`（E1–E7）+ `memory_snapshot`（`:259-265`） | 某决策当时的上下文快照 |
| **Decision Graph**（为何决定+后果） | **J 决策脊柱** | `crm.decision` + `crm.decision_event`（`:207`）+ `crm.decision_outcome`/`feedback`/`root_cause`（闭环新增）+ `crm.calibration_patch`（`:411-429`） | 决策即一等对象，连证据连后果 |

**对外映射（向监管/审计讲述用）**：本平台 = "一个 CRM 领域的 Semantic Graph 底座，但把 Semantica 的单一决策图拆成了 K（世界）/M（当时）/J（决定）三张协同图，并在 J 上叠了 Semantica 没有的反馈校准闭环。"

---

## §2 知识图谱闭环（对应知识系统 K）

**闭环命题**：原始业务事实如何被**正确、可追溯、可进化**地沉淀为 K 图，并被确定性检索使用。

```
构建：raw → hooks 身份解析 → particleRepo 写粒子 → 21 受控谓词约束 → meta_attr 写时校验(6.6)
使用：assembler L1-L4 装配 → 图遍历推理 → RRF 混合召回(G6)
进化：dedup 软合并 → backfill → meta_attr.required/source_refresh_sla(6.3) → 双时态 replay(P2/T10)
```

### §2.1 构建（如何建）
- `hooks.js:38-120` 身份解析（CONTACT email 域名→ACCOUNT 的 `auto_weak` 边，含防子串误判的 JSONB 元素级匹配）→ `particleRepo.js` 写粒子 → `particleModel.js:262-270` 21 个受控谓词白名单约束 → `meta_attr`（`schema.sql:322-344`）字段元模型。
- **新增 SHACL-equivalent 写时校验层（§5 之 6.6）**：`normalizeFacts()` 类型归一化 + `meta_attr.required` 拦截脏事实，防误触发规则（借鉴 Semantica at-ingest SHACL 校验，对应江狐踩坑经验"类型不匹配让规则默默漏网"）。

### §2.2 使用（如何用）
- `assembler.js:41-115` L1–L4 上下文装配读取 K；图遍历（edges）做关系推理；`memoryLog.js` 检索升级为 **RRF（dense+sparse）融合**（§5 G6，借鉴 Semantica GraphRAG RRF）。

### §2.3 进化（如何进化）
- `dedup.js:12-38` 软合并（`meta_attr.merged_into`，永不物理删，保溯源，优于 Semantica 物理合并）；`scripts/backfill-age.js` 幂等 MERGE。
- `meta_attr.required`/`source_refresh_sla`（§5 之 6.3）驱动数据质量治理，支撑溯源④跳"信息不完整/输入不及时"检测（全链路 §1.2）。
- **双时态 replay**（P2/T10，借鉴 `state_at(date)`，与 Datalog 同源评估）。

**承载设施**：G6（向量化+RRF）、6.3（meta_attr 治理）、6.6（SHACL 写时校验）、T8（retrieval_cfg 四层 topk 可配）。

---

## §3 上下文图谱闭环（对应记忆系统 M）

**闭环命题**：某个决策"当时上下文"如何被物化为 M 图，如何支撑历史决策检索/溯源，并随使用蒸馏进化。

```
构建：decisionRepo 七点 Schema → memory 三构件 → decision_relation E1-E7 权威表(G1, serves_dimension)
使用：assembler L2 历史决策装配 → trace/impact → precedent 检索
进化：30 天蒸馏 → 不可变 memory_snapshot → attribution.edge_compliance 七态(6.4)
```

### §3.1 构建（如何建）
- `decisionRepo.js:39-143` 七点 Schema（场景/上下文/推导/判定/置信度/依据/归因）→ memory 三构件 `memoryLog.js`/`note.js`/`snapshot.js` → **`decision_relation` E1–E7 权威表**（§5 G1，扩 `serves_dimension`+`props`，替代 AGE 单类型镜像 `decision_precedent_rel` `schema.sql:191-196`）。

### §3.2 使用（如何用）
- `assembler.js:69-78` 历史决策装配（L2）→ `ageGraph.js:167-214` trace（带 0.9^distance 置信衰减）→ `:217-226` impact → `decisionRepo.js:176-191` precedent 检索。

### §3.3 进化（如何进化）
- 30 天蒸馏（`decisionRepo.js:250-257`）→ 不可变 `memory_snapshot`（`:259-265`，时间点重放）→ `attribution.edge_compliance`（E1–E7 应存/实存/缺，§5 之 6.4）+ `category` **七态**（原仅 3 态，`attribution.js:14-21`）。

**承载设施**：G1（decision_relation E1-E7）、6.2（serves_dimension + edge_bindings）、6.4（edge_compliance 七态）、G4（冲突消解，作用于 M assertions）。

---

## §4 决策图谱闭环（对应决策脊柱 J，含 J1/J2/J3 三个运行阶段）

**闭环命题**：一个决策如何被物化为 J 图节点、被业务结果检验、并被校准回写使下次更准。J1/J2/J3 即该闭环的三个运行阶段，各自对应在途文档的子设计。

```
构建(J1 上下文图)：请求 → 装配 K+M → createDecision 第0闸(record) → 生成决策节点 + attribution + decision_relation(E1-E7)
使用：trace/impact/precedent → check_decision_rules(mini-Rete, G2) → PROV-O 留痕(G3)
检验(J2 反馈)：业务事件/人工回写 outcome/feedback → decision_outcome/feedback/root_cause(6.1) → getGateOutcome 双率对比 → 隐性错误簇
进化(J3 校准)：root_cause 七类 → calibration patch(knob 7+类, 6.5) → 第0闸写回 K/M → 重跑 → 记忆蒸馏
```

### §4.1 J1 上下文图（决策物化）
- `createDecision` 第0闸（record_decision，经 `auditHook.js:38-56` SHA-256 链 + fail-open）→ 写入七点 + attribution + `decision_relation`（G1，E1–E7 + `serves_dimension`）。
- **confidence 提列 G5（唯一定义，J2/J3 反算共用同列，消除与 j2-j3 文档重复）**。
- 借鉴：决策即一等节点、确定性推理零 token（`ruleEngine.js` grep llm 零命中，须保持）、PROV-O 标准导出。

### §4.2 J2 反馈（业务结果检验）
- `outcome.js` + `outcomeIngester.js`（订阅 task/trace/approval/particle/**payment** 总线）回写 `decision_outcome`/`decision.feedback`/`decision.root_cause`（§5 之 6.1，闭环新增一等公民，旧文仅松散 `outcome TEXT`）。
- `getGateOutcome` 双率对比（决策通过率 vs 业务成功率）→ 暴露"隐性错误簇"（人工采纳但业务失败）→ 驱动 J3。
- 借鉴：业务信号滞后校验（金律 18 双信号：即时人工 + 滞后业务）；冲突检测不静默覆盖（J2 反馈即业务侧冲突信号）。

### §4.3 J3 校准（反馈→校准→重跑）
- J2 反馈 + J1 attribution → `rootCauseClassifier` 七类（全链路 §3）→ `calibration_patch`（knob 7+ 类，§5 之 6.5）→ `store.js:117-138` 第0闸写回 K/M（`meta_attr`/`edge_bindings`/`required_dims`）→ `decision-scenarios.html` 重跑 → 记忆蒸馏。
- 借鉴：冲突 5 策略消解（timestamp/source_priority/confidence_weighted/**merge**/**human_arbitration=第0闸**）；先例蒸馏降权（PRECEDENT_DISTILL）；规则 DB 化可审计（G2）。
- **承载设施**：G2（decision_rule + mini-Rete）、G3（PROV-O 导出）、G5（confidence）、6.1（outcome/feedback/root_cause）、6.5（calibration knob）、G4（冲突 5 策略）、G7（鉴权跨环）。

**三图衔接**：K 提供客观世界 → M 提供"当时上下文" → J 把决定物化为图节点并连证据连后果；J2 用业务结果检验 J1，J3 据 J1+J2 偏差写回 K/M 使 J1 下次更准。C-DAI 底座（G1–G7 + 6.1–6.6）为三图三闭环提供图/规则/PROV-O/冲突/向量确定性能力。

---

## §5 基础设施清单（G1–G7 + 闭环新底座需求，按 图/环 交叉索引）

| 编号 | 设施 | 服务图 | 服务闭环 | 状态 | 证据 |
|---|---|---|---|---|---|
| **G1** | `decision_relation` E1–E7 权威表（扩 `serves_dimension`+`props`） | M | 上下文闭环 | 🟡→升 | `ageGraph.js:136` 声明7类实落3类；`schema.sql:191-196` 单类型 |
| **G2** | `decision_rule`+`rule_hit`+mini-Rete+`normalizeFacts()` | J | 决策闭环(使用) | ❌→建 | `ruleEngine.js:4-23`(2条)、`alertRegistry.js:7-61`(内存7条)、`approval/rules.js:21-27`(3常量)、`ruleEngine.js:31-33`(block无审计) |
| **G3** | PROV-O 叠加层 + 归档分级 + EU AI Act 格式 | J | 决策闭环(全) | ❌→建 | 全仓 grep `PROV-O` 零命中；仅 `ageSync.js:40-51` 借边名 |
| **G4** | 冲突 5 策略 + `source_credibility` | M/K | 上下文/知识闭环 | ❌→建 | `conflict.js:24-59`(仅 adoptValue)、`conflict.js:9`(表无DDL) |
| **G5** | `decision.confidence` 提列（唯一定义） | J | 决策闭环 | 🟡→升 | `decisionRepo.js:128`/`autonomyEngine.js:128` 藏 payload；`calibrationRouter.js:35-41` 侧信道 |
| **G6** | memory 三表向量化 + RRF 融合 | K | 知识闭环(使用) | ❌→建 | `memoryLog.js:40-43` LIKE前缀；schema 仅2处 vector |
| **G7** | 溯源端点鉴权对齐 + scope + 下线 DEPRECATED | 跨 | 跨环 | 🟡→升 | `routes.js:1802-1823` 无鉴权 vs `calibrationRouter.js` 全 sysadmin；`routes.js:1729-1756` DEPRECATED |
| **6.1** | `decision_outcome`/`feedback`/`root_cause` 一等公民 | J | 决策闭环(J2) | ❌→建 | 原仅松散 `outcome TEXT`(`schema.sql:167-168`)；`attribution.js:18,40` 占位 |
| **6.2** | `decision_relation.serves_dimension` + `config_store.edge_bindings`（E1–E7×维度） | M | 上下文/决策闭环 | ❌→建 | 全链路 §5；原 G1 枚举无 `serves_dimension` |
| **6.3** | `meta_attr.required` + `source_refresh_sla` | K | 知识闭环(进化) | ❌→建 | 全链路 §1.2 检测基础；`schema.sql:322-344` |
| **6.4** | `attribution.edge_compliance`（E1–E7）+ `category` 七态 | M | 上下文闭环(进化) | 🟡→升 | 原 `attribution.js:14-21` 仅 3 态 |
| **6.5** | `calibration_patch.knob` 扩 7+ 类（含 `EDGE_BINDING`/`META_ATTR_MAP`/`PARTICLE_ATTR_ADD`） | J | 决策闭环(J3) | ❌→建 | 全链路 §3；原 knob 枚举窄 |
| **6.6** | SHACL-equivalent 写时校验层（`normalizeFacts` + `meta_attr` 约束） | K | 知识闭环(构建) | ❌→建 | 江狐踩坑经验；`particleModel.js:262-270` 谓词白名单仅校验边名 |

---

## §6 外部最新学习与对账（2026-08，每条标注服务图/闭环）

| # | 新信号（Semantica 截至 2026-08） | 服务图/闭环 | 对平台的含义 |
|---|---|---|---|
| 1 | **v0.6.5 是安全修复版**（堵 SSRF/SQL注入/SPARQL注入/认证缺口）；外部原话："审计层的认证缺口，正是卖问责的项目最不能承受的失败模式" | G7 / 跨环 | 强化 **G7 溯源端点鉴权**——不是锦上添花，是生死线 |
| 2 | **bus factor≈1**（约 1,800/2,300 commits 单人贡献） | 铁律一 | 进一步坐实"不引外部依赖"判据 |
| 3 | **Rete 引擎自评"intentionally simple，不适合生产合规闸"**（andrew.ooo 实测） | G2 / 决策闭环(使用) | 我们自建 mini-Rete 被验证正确，但**必须补测试护城河** |
| 4 | **EU AI Act 高风险义务的 record-keeping + traceability 于 2026-08 正式适用** | G3 / 决策闭环 | **新监管驱动力**，强烈抬升 G3（PROV-O）业务价值（初版未提） |
| 5 | **冲突消解 5 策略**（timestamp / source_priority / confidence_weighted / **merge** / **human_arbitration**），初版只知 2 个 | G4 / 上下文闭环 | G4 应扩到 5；我们"消解走第0闸=human_arbitration"比 Semantica 更严 |
| 6 | **SHACL 写入时约束校验**（at ingest 防脏事实误触发规则） | 6.6 / 知识闭环(构建) | 映射到 `meta_attr.required` + `normalizeFacts()`，补"写时 schema 校验层" |
| 7 | **三层图模型 KG / Context / Decision 的明确区分** | §1 全部 | **最强概念桥**：我们的 K/M/J 即该模型在 CRM 的实例化 |
| 8 | **双时态 replay（`state_at(date)`）** | K 进化 / P2 T10 | 初版"不抄"；外部强调是审计核心。我们 `memory_snapshot` 是不可变快照，缺"当时政策下事实真值"双时态建模 → 标 P2 待评估（与 T10 Datalog 同源） |
| 9 | **GraphRAG RRF 融合（dense+sparse）** | G6 / 知识闭环(使用) | G6 记忆向量化的"混合召回"可明确为 RRF 融合 |
| 10 | **Provenance 存储成本警告**（全量 PROV-O 日志膨胀） | G3 归档 | G3 补"归档/分级留存"策略（我们禁删但需归档分级） |
| 11 | **实体解析是最被低估的一步**（同客户拆多节点→全链偏差） | K 构建 / dedup | 我们的 dedup.js 软合并（保溯源、禁物理删）恰好正确，确认不改 |

**与原始两篇文章一致性仍成立**：决策即一等节点、确定性推理零 token、冲突不静默覆盖、PROV-O 导出——四条核心判据被 2026-08 外部资料**全部再次印证**。

---

## §7 三闭环运作机理（感知-应用-反馈）与跨环数据/溯源：两维度细分借鉴点

> 本节把 §5（设施清单 G1–G7 + 6.1–6.6）与 §6（外部 11 条学习）的借鉴点，沿两个正交维度重新切分：**维度一 = 三闭环各自的"感知→应用→反馈"运作机理与增强需求**；**维度二 = 三闭环之间的数据传递与反馈溯源**。§2–§4 的"构建-使用-进化"是图自身的生命周期视角，本节改用控制论"感知-应用-反馈"闭环视角，二者互补而非重复。

### §7.1 维度一：三闭环的感知-应用-反馈运作 + 各自增强需求

每个图自身是一个"感知世界 → 应用决策 → 反馈进化"的控制闭环。下表给出每环三阶段、当前实现（file:line）、增强需求（来自 §5 设施）与对应借鉴点（§6 编号）。

#### §7.1.1 知识图谱闭环（K）
| 阶段 | 控制含义 | 当前实现（证据） | 增强需求（设施） | 借鉴点（§6） |
|---|---|---|---|---|
| **感知** | 从原始业务事实"感知"出世界结构 | `hooks.js:38-120` 身份解析 → `particleRepo.js` 写粒子 → `particleModel.js:262-270` 21 谓词约束 → `meta_attr`（`schema.sql:322-344`） | **6.6** SHACL-equivalent 写时校验（`normalizeFacts` + `meta_attr` 约束，拦截脏事实） | #6 SHACL 写时校验；#11 实体解析（dedup 软合并已正确，加固）；#8 双时态 replay（P2/T10） |
| **应用** | 把知识"应用"到决策上下文装配 | `assembler.js:41-115` L1–L4 读 K + 图遍历 + `memoryLog.js` 检索 | **G6** 向量化 + **RRF（dense+sparse）融合**；**T8** `retrieval_cfg` 四层 topk 可配 | #9 GraphRAG RRF 融合 |
| **反馈** | 世界变化"反馈"回知识图（进化） | `dedup.js:12-38` 软合并 + `scripts/backfill-age.js` 幂等 MERGE | **6.3** `meta_attr.required` + `source_refresh_sla` 数据质量治理；双时态 replay 补齐"当时政策下事实真值" | #3（间接，类型归一防漏网）；#8 双时态 |

#### §7.1.2 上下文图谱闭环（M）
| 阶段 | 控制含义 | 当前实现（证据） | 增强需求（设施） | 借鉴点（§6） |
|---|---|---|---|---|
| **感知** | 决策时"感知"当时上下文 | `decisionRepo.js:39-143` 七点 Schema → memory 三构件 → `decision_relation`（E1–E7） | **G1** `decision_relation` + `serves_dimension`；**6.2** edge_bindings（E1–E7×维度） | #7 三层图（Context=当时） |
| **应用** | 历史上下文"应用"于检索/溯源 | `assembler.js:69-78` L2 装配 → `ageGraph.js:167-214` trace → `:217-226` impact → `decisionRepo.js:176-191` precedent | AGE 开/关 parity（T2）；trace 置信衰减 `0.9^distance` | #7 三层图（Context→Decision 桥） |
| **反馈** | 上下文价值随使用"反馈"（蒸馏进化） | 30 天蒸馏（`decisionRepo.js:250-257`）+ 不可变 `memory_snapshot`（`:259-265`） | **6.4** `attribution.edge_compliance`（E1–E7）+ `category` **七态**；蒸馏触发调优 | #5 冲突 5 策略（蒸馏即降权） |

#### §7.1.3 决策图谱闭环（J，含 J1/J2/J3 三阶段）
| 阶段 | 控制含义 | 当前实现（证据） | 增强需求（设施） | 借鉴点（§6） |
|---|---|---|---|---|
| **感知** | 一次请求"感知"为决策图节点（J1 物化） | `createDecision` 第0闸（record，`auditHook.js:38-56` SHA-256 链）→ 七点 + attribution + `decision_relation` | **G5** `decision.confidence` 提列（唯一定义）；**6.1** `outcome/feedback/root_cause` 一等公民 | #7 三层图（Decision=决定+后果） |
| **应用** | 规则门 + 留痕（J1→J2 衔接） | 缺规则引擎 + 缺 PROV-O | **G2** `decision_rule`+mini-Rete+`rule_hit`；**G3** PROV-O 叠加层 | #3 Rete 须补测试护城河；#4 EU AI Act 抬升 G3 |
| **反馈** | 业务结果"反馈"→校准→重跑（J2→J3） | 仅松散 `outcome TEXT`；calibration 窄 knob | **6.1** outcome/feedback/root_cause；**6.5** `calibration_patch.knob` 7+ 类；**G4** 冲突 5 策略；**G7** 跨环鉴权 | #5 冲突 5 策略（human_arbitration=第0闸）；#1 v0.6.5 安全→G7 生死线 |

**维度一小结**：三环的"感知"段普遍缺写时校验/结构化（K 6.6、M G1、J 6.1/G5），"应用"段普遍缺规则门与 PROV-O（G2/G3），"反馈"段普遍缺七态归因与校准写回（6.4/6.5/G4）。这恰好对应 §5 中状态为"❌→建"的设施——**三环的感知-应用-反馈三段缺口高度一致地指向同一组底座设施**。

### §7.2 维度二：三闭环之间的数据传递 + 反馈溯源

#### §7.2.1 五条跨环数据传递链路（载体与方向）
| # | 方向 | 传递什么 | 物理载体（证据） | 借鉴点（§6） |
|---|---|---|---|---|
| D1 | **K → M**（知识注入上下文） | 客观世界真值（粒子/边/meta_attr） | `assembler.js` L1/L3 读 K；`decision_relation.serves_dimension` 绑定 K 维度（6.2） | #7 三层图（KG 是 Context 的世界底座） |
| D2 | **M → J**（上下文注入决策） | 当时上下文（七点/attribution/decision_relation） | `createDecision` 读 M；`decision_relation` E1–E7（G1） | #7 三层图（Context→Decision 桥） |
| D3 | **J → K**（决策校准回写知识） | 校准后的规则/属性/边绑定 | `calibration_patch.knob`（6.5）+ 第0闸写回 `meta_attr`/`edge_bindings`/`required_dims`（`store.js:117-138`） | #5 冲突 5 策略（human_arbitration=第0闸）；#3 规则 DB 化 |
| D4 | **J → M**（决策结果反哺记忆） | 业务成败 → 边合规态/蒸馏权重 | `attribution.edge_compliance`（6.4 七态）+ 30 天蒸馏 | #5 冲突 5 策略（蒸馏降权） |
| D5 | **K ↔ M**（双向约束） | meta_attr 写时约束同时护 K 与 M | 6.6 SHACL 写时校验跨 K/M | #6 SHACL 写时校验 |

**关键判据**：D3/D4 是"决策闭环进化"反向流入 K/M 的唯一受控通道，**必须 100% 经第0闸（createDecision）**——否则 J 的反馈无法问责地改变知识/记忆（R1 风险）。这把"反馈溯源"与"单一事实源"铁律绑定。

#### §7.2.2 反馈溯源链路（四层全链路，J→M→K→粒子库）
```
particle ──edge──> memory_snapshot ──decision_relation(E1-E7)──> decision
   (K 字段级)         (M 当时)                                    (J 决定)
      ↑                                                        │
      │  calibration_patch.knob 经第0闸写回                      ↓
      └──────────────── meta_attr/edge_bindings ◀── outcome/feedback/root_cause
                                                       (J2 业务结果 → J3 根因 → 写回)
```
- 每一跳都有 provenance：粒子（`meta_attr` 来源）→ 快照（`memory_snapshot` 时间点）→ 决策（`auditHook` SHA-256 链）→ 结果（`outcome/feedback`）→ 校准（`calibration_patch` 含 before/after）。
- **溯源④跳**（全链路 §1.2）：J(决策)→M(记忆)→K(知识)→粒子库（字段级）。载体 = **G3** PROV-O + **G1** `decision_relation` + **6.4** `edge_compliance` + **6.3** `meta_attr.required/source_refresh_sla`（检测"信息不完整/输入不及时"）。
- 借鉴点映射（维度二视角）：
  - **#4 EU AI Act + #7 三层图 + 原始四条核心判据** → 四层边界天然对应 KG/Context/Decision/粒子，PROV-O 导出须覆盖四层且可出 EU 格式（G3）。
  - **#5 冲突不静默覆盖** → 溯源链中每个被覆盖的 assertion 必须留痕（G4 5 策略 + 第0闸），否则溯源断点。
  - **#10 Provenance 存储成本** → G3 须"归档/分级留存"（禁删但控膨胀），否则全量 PROV-O 日志撑爆。
  - **#8 双时态 replay** → 溯源可答"当时政策下事实真值"，把快照从"时间点重放"升级为"双时态可信"（P2/T10 同源评估）。
  - **#1 v0.6.5 安全** → 溯源端点（G7）须鉴权，否则溯源链本身成泄露面。

### §7.3 两维度细分借鉴点矩阵（总表）

下表把 §6 的 11 条外部学习 + 4 条原始核心判据，沿"维度一（服务环/阶段）"与"维度二（跨环传递/溯源环节）"双坐标定位，便于实施排期与缺口审计。

| §6# | 借鉴点 | 维度一：服务环/阶段 | 维度二：跨环传递 / 溯源环节 | 落地设施 |
|---|---|---|---|---|
| 1 | v0.6.5 安全修复 | 决策环(应用) G7 | 溯源端点鉴权，防未授权读溯源链 | G7 |
| 2 | bus factor≈1 | （铁律，非环） | — | 铁律一 |
| 3 | Rete 不适合合规闸 | 决策环(应用) G2 | J 规则门正确性→影响 D3 写回 | G2（补测试护城河） |
| 4 | EU AI Act 适用 | 决策环(全) G3 | 溯源导出合规（维度二核心） | G3 |
| 5 | 冲突 5 策略 | 上下文环(反馈) G4 / 决策环(反馈) J3 | D3/D4 写回冲突须走第0闸 | G4 / 6.5 |
| 6 | SHACL 写时校验 | 知识环(感知) 6.6 | D1/D5：K 构建拦截脏事实，保 M/J 干净输入 | 6.6 |
| 7 | 三层图模型 | 全部（概念桥） | 维度二基础：KG/Context/Decision 边界 = 溯源四层划分依据 | §1 |
| 8 | 双时态 replay | 知识环(反馈) P2/T10 | 溯源"当时真值"可信度 | K 进化 |
| 9 | RRF 融合 | 知识环(应用) G6 | D1：K 检索质量→M 装配/J 决策输入质量 | G6 |
| 10 | Provenance 成本 | 决策环 G3 归档 | 维度二：溯源链归档分级 | G3 |
| 11 | 实体解析被低估 | 知识环(感知) dedup | D1：同客户解析错→M/J 全链偏差 | K 构建 |
| ★ | 决策即一等节点 | 决策环(感知) J1 | D2：决策节点是溯源锚 | J |
| ★ | 确定性推理零 token | 决策环(应用) | 溯源可复现（无随机性） | G2 |
| ★ | 冲突不静默覆盖 | 上下文环(反馈)/决策环 | 维度二：溯源链不断点 | G4 |
| ★ | PROV-O 导出 | 决策环(全) | 维度二：标准导出 | G3 |

**结论**：两条维度交叉验证——维度一暴露"三环三段缺口一致指向 G1–G7+6.1–6.6"，维度二暴露"跨环 5 条链路 + 四层溯源链"必须靠同一组设施打通。**借鉴点不是清单，而是被两个维度同时命中的设施需求**；凡在矩阵中"维度一×维度二"双命中者（G2/G3/G4/G5/G6/G7/6.1–6.6）即最高优先级底座，应先于在途 T15–T32 智能层实施。

---

## §8 实施计划（T1–T14 脊柱，按 图闭环 分组 + decision-retro 生命契约）

> 每 Task 附生命契约：`agent: decision-retro`（src/agent/agentSpec.js 中 knowledgeScope L1–L3、skillCalls `decision-retrospective`+`data-particle-read`），`skills` 取该 agent skillCalls 子集（可过契约校验）；与在途 T15–T32 对齐、消除 `confidence`/`decision_relation` 重复定义。

### §8.1 知识图谱闭环（K）
| Task | 内容 | 承接/对齐 |
|---|---|---|
| **T7** | G6 memory 三表向量化 + RRF 融合检索 | 全链路④跳 |
| **T8** | `retrieval_cfg` 接线（assembler.js:46,73 四层 topk 可配置） | — |
| **T2-part** | 6.6 `normalizeFacts()` + `meta_attr` 写时校验（K 构建段） | 初版 §5.2 |
| **T10** | 评估 Datalog / 双时态 replay（P2，K 进化） | 触发条件同初版 |

**T7 契约示例**
```contract-yaml
- task: "G6 记忆三表向量化 + RRF(dense+sparse) 混合召回"
  agent: decision-retro
  skills: [data-particle-read, decision-retrospective]
  memory: [decision-retro]
  knowledge_scope: { layers: [L1], maxHops: 2 }
  success: "memory_* 三表 embedding 列就位；检索从 LIKE 前缀升级为 向量topk ∪ LIKE；换真模型仅改 embedding.js 一处"
```

### §8.2 上下文图谱闭环（M）
| Task | 内容 | 承接/对齐 |
|---|---|---|
| **T2** | G1 `decision_relation` E1–E7 权威表 + `serves_dimension` + 4 类边接线 + 降级路径改读 PG | 全链路 T25/T29；parity 测试 |
| **T5** | G4 冲突 5 策略 + `source_credibility` + assertions 补 DDL | 全链路 T28；M assertions 多源冲突 |
| **T11** | 作战室溯源面板骨架（sales-decision-monitor.html T 区） | 全链路 T30 / j2-j3 T17 |
| **T12** | 巡检卡业务结果行 + 溯源抽屉（单决策四层溯源） | 全链路 T30 |
| **T14** | 配置中心 `edge_bindings` + `root_cause_thresholds` 页签（6.2 配置面） | j2-j3 T22 / 全链路 T32 |

**T2 契约示例**
```contract-yaml
- task: "G1 decision_relation 7边权威表 + E1-E7 serves_dimension + 降级路径"
  agent: decision-retro
  skills: [data-particle-read, decision-retrospective]
  memory: [decision-retro, review-gate]
  knowledge_scope: { layers: [L1, L2, L3], maxHops: 5 }
  success: "AGE 开/关 parity 逐边相等；decision_relation 含 serves_dimension 列且 E1-E7 全有落点"
```

### §8.3 决策图谱闭环（J）
| Task | 内容 | 承接/对齐 |
|---|---|---|
| **T1** | G5 confidence 提列（唯一定义）+ 回填 + 删 calibrationRouter 侧信道 | j2-j3 T15 共用同列 |
| **T3** | G2 `decision_rule`+`rule_hit`+mini-Rete+`normalizeFacts`+规则迁移+第0闸 | j2-j3 T20；R7–R17 落库 |
| **T4** | G3 PROV-O + 导出 + 归档分级 + EU AI Act 格式 | 全链路 §5 导出 |
| **T6** | G7 鉴权对齐 + scope + 下线 DEPRECATED | — |
| **T9** | 决策图谱可视化（受控渲染 renderPage + page.css） | — |
| **T13** | SSE `calibration` 域 + 自动建议浮卡骨架（autoSuggest.js） | j2-j3 T21 |
| **T3-part** | 6.1 `decision_outcome`/`feedback`/`root_cause` 落库（J2 段） | 全链路 §3 |
| **T5-part** | 6.5 `calibration_patch.knob` 扩 7+ 类（J3 段） | 全链路 §3 |

**T3 契约示例**
```contract-yaml
- task: "G2 decision_rule+rule_hit+mini-Rete+normalizeFacts+12条规则迁移+第0闸"
  agent: decision-retro
  skills: [data-particle-read, decision-retrospective]
  memory: [decision-retro, review-gate]
  knowledge_scope: { layers: [L1, L2, L3], maxHops: 5 }
  success: "12条规则逐条 parity；rule_hit 落库率100%(含block)；规则DML 100%经 createDecision"
```

**编号缺口补齐说明**：j2-j3 §5 与全链路 §10 均称"承接 T1–T24"，但初版只定义 T1–T10，且下游引用 T11–T14（作战室溯源面板/巡检卡/SSE calibration 域/配置中心 edge_bindings）却未定义。本版补齐 T11–T14，并明确 T15–T32 属在途闭环文档（J2/J3 + 全链路），**不在本 C-DAI 脊柱重复定义**。

---

## §9 验收口径（按三图闭环）

1. **知识图谱闭环（K）**：RRF 混合召回生效；`meta_attr.required` 拦截脏事实；dedup 软合并零物理删；`retrieval_cfg` 四层 topk 可配。
2. **上下文图谱闭环（M）**：E1–E7 全落点；AGE 开/关 trace 逐边相等（parity）；`attribution.edge_compliance` 七态可计算；30 天蒸馏不丢溯源。
3. **决策图谱闭环（J）**：① J1——createDecision 第0闸全量 record、confidence 列唯一定义；② J2——`outcome/feedback/root_cause` 落库、`getGateOutcome` 暴露隐性错误簇；③ J3——root_cause 七类断言通过、calibration patch 经第0闸写回 K/M；④ G2 规则迁移逐条 parity、block 落 `rule_hit` 100%；⑤ G3 导出含 `feedback`/`root_cause`/`outcome`、EU AI Act 格式（Turtle/RDF）可用、归档分级可配；⑥ G7 角色越权用例全绿、DEPRECATED 端点 410。
4. **延迟**：`/api/graph/trace` P95 < 300ms（Node 本地直查 PG，零跨进程）——否决旁路进程形态 A 的量化判据，必须实测。
5. **测试纪律**：每 Task 配套测试；跑法遵守铁律——**小批量重跑验证**，勿被全量 `vitest run` 连接池耗尽伪失败误导。

---

## §10 明确不借鉴 / 风险与开放问题

### §10.1 明确不借鉴（保留初版 §6，新增一条）
图谱构建/NER/Entity Merger 物理合并/双时态图/ContextGraph Python API/Sigma.js 可视化 —— 理由不变（见初版 §6 证据表）。
**新增**：Semantica Rete 引擎自评"不适合生产合规闸"，故我们自建 mini-Rete 须自带测试护城河（R5 扩展）——不抄其引擎，但抄"须有 property-based 测试防类型静默漏网"这一教训。

### §10.2 风险
| 编号 | 风险 | 缓解 |
|---|---|---|
| R1 | 规则 DB 化后若被非第0闸路径修改，规则本身失去问责 | `crm.decision_rule` DML 强制经 `createDecision`（RULE_CHANGE）；测试守卫扫描直接 DML |
| R2 | `decision_precedent_rel` ↔ `decision_relation` 双写不一致 | 统一收在 `linkDecisions()` 单一写入口；一致性巡检脚本 |
| R3 | PROV-O 导出含 PII | 导出前走 redact；`prov_export` 记等级与事由；"擦除只在导出物上做，库内保留"须在 UI 明示 |
| R4 | hashVector 伪向量，语义召回有限 | 标注"结构召回"；真语义待 `embedding.js` 换真模型单点切换 |
| R5 | mini-Rete 不支持递归/传递闭包 | 一期明确不支持；补 property-based 测试；需要时走 T10 评估 Datalog |
| R6 | 死代码 `reverseDecision`（decisionRepo.js:273）被误用 | T2 一并标注或移除；disposition.js 是 HITL 唯一出口 |

### §10.3 开放问题（需确认后再实施）
1. `crm.decision_rule` 管理入口：配置中心卡片（须同步 `configCenter.js` + `config.html` + `configCenter.test.js` 三处）还是独立 `/rules.html`？
2. EU AI Act 合规导出格式优先级（Turtle/RDF vs PDF 审计包）？
3. 双时态 replay 是否纳入（P2/T10，与 Datalog 同源评估）？
4. Rete 护城河：须补 property-based 测试防"类型静默漏网"（R5）。

---

## 附：证据基础（保留初版 file:line + 补两份在途文档交叉引用）

全部结论基于 2026-08-30 对 `D:\system\CRM-ai-native` 的全仓只读扫描，关键锚点：

- 决策表与索引：`db/schema.sql:153-174`（decision）、`:191-196`（decision_precedent_rel）、`:207`（decision_event）、`:226-232`（ivfflat）、`:411-429`（calibration_patch）、`:322-344`（meta_attr）、`:217-277`（memory 三表）、`:259-265`（memory_snapshot）
- 决策内核：`src/decision/decisionRepo.js:29-36/39-143/79/125/176-191/244/250-257/273`、`provenance.js:37-73`、`ageGraph.js:136/167-214/217-226/230-264`、`autonomyEngine.js:39-44/99-102/128`
- 规则与告警：`src/ruleEngine.js:4-23/26-34`、`src/alerts/alertRegistry.js:6-7/61/70`、`src/approval/rules.js:21-27`
- 冲突与去重：`src/decision/conflict.js:9-21/24-59`、`src/particles/dedup.js:12-38`
- 记忆与上下文：`src/memory/memoryLog.js:40-43`、`src/context/assembler.js:41-115`、`src/ontology/hooks.js:38-120`、`src/particles/particleModel.js:262-270`
- 校准闭环：`src/calibration/metrics.js:60-83`、`replay.js:10-89`、`store.js:117-138`
- 路由：`src/http/routes.js:1729-1756（DEPRECATED）/1802-1823`、`src/http/calibrationRouter.js`
- **在途文档交叉引用**：`2026-08-30-j2-j3-comprehensive-design.md`（J2 双信号金律18/四象限归因/拒绝出方守卫↔第0闸；J3 根因七类；T15–T32）；`2026-08-30-full-traceability-root-cause-design.md`（四层全链路溯源 J→M→K→粒子库；§3 root_cause 七类；§5 E1–E7 edge_bindings；§10 T1–T24）

---

## §11 增量借鉴（2026-08-30 · 二次对账 v0.6.7）

> 触发：用户要求"再次借鉴 Semantica"。本节**只记录 v2（§1–§10）尚未覆盖的净增量**；已覆盖者（决策即一等节点、确定性推理零 token、冲突不静默覆盖、PROV-O 导出、三层图模型、SHACL、RRF、双时态、实体解析）不再重复。
> 状态：**待批准**（批准前不写实现代码）。

### §11.1 事实版次对账（仅更新数字，不改结论）

| 项 | v2 记录 | 2026-08-30 复核 | 影响 |
|---|---|---|---|
| 版本 | v0.6.5 | **v0.6.7**（安全修复线持续） | 无 |
| commits | ~2,300 | ~2,650 | bus factor≈1 结论**加强** → 铁律一（不引外部依赖）更稳 |
| 许可 / 定位 | MIT / Graph-Native Infrastructure for Context and Accountable AI Systems | 一致 | 无 |
| 核心声明 | "no LLM required for graph construction, reasoning, or provenance" | 一致 | 再次印证 G2/G3 确定性路线 |
| 新增可见能力 | — | `record_decision` / `add_causal_relationship` / `trace_decision_chain` / `analyze_decision_impact`、Rete+Datalog、ConflictDetector/Resolver、Retraction/Purge、确定性 IRI、词表强制、MCP server | 见 §11.2 |

### §11.2 净增量借鉴点（5 条，标注服务图/闭环与判定）

#### A. 确定性标识铸造（`mint_entity_iri` / `mint_relationship_iri`）— **新增缺口，建议采纳**

- **Semantica 做法**：实体/关系 IRI 由内容哈希铸造（基于 `hash_data`），保证同一事实跨运行、跨进程得到**同一标识**，从而支撑可复现溯源与导入幂等。
- **我方现状（证据）**：
  - 全 schema **16 处** `gen_random_uuid()`，标识**全部随机**；
  - `src/` 内 **grep `mint_.*iri|deterministic.*id|hashId|deriveId` 零命中** → 无任何确定性 ID 铸造；
  - 粒子仅有 `content_hash`（`schema.sql:20`，注释"幂等判变（内容没变不重算）"）用于**判变，未用于标识推导**；
  - `slug` 仅有索引 `idx_crm_particles_slug`（非 UNIQUE）→ 重复粒子只能靠 `dedup.js:12-38` **事后**软合并。
- **判定**：**采纳（新增设施 6.7）**。随机 ID 使"同一客户/同一关系"在不同批次落成不同节点，既放大 dedup 压力，也让跨批次溯源链不稳定——与 §7.2"溯源链每一跳都有 provenance"直接冲突。
- **落地映射**：**不改动既有 UUID 主键**，新增派生稳定键 `stable_key = sha256(tenant_id|type|natural_key)`（natural_key 按 particle_type 取 slug/email/domain，配置进 `meta_attr`），落唯一索引做幂等写；`decision_relation` 已有 `UNIQUE(from_id,to_id,rel_type)` 天然幂等，仅需把 `rel_id` 改为派生键以便跨系统引用。与 `content_hash` 分工：**content_hash 判变、stable_key 定址**。
- **风险**：natural_key 选择需按 particle_type 配置，否则仍会分叉（R7 候选）。
- **【已落地 2026-08-30】**：`src/particles/mintId.js`（`stableKey`/`mintEntityIri`/`mintRelationshipIri`/`computeParticleStableKey`/`backfillStableKeys`/`upsertParticleByStableKey`）+ `db/schema.sql` 加 `crm.particles.stable_key` 列 + 非部分唯一索引 `uq_crm_particles_stable_key`（PG16 不支持 partial index 作 ON CONFLICT arbiter，故用完整唯一索引，NULL 不冲突）+ `traceRootCause.js` 粒子映射补 `stable_key`。TDD：纯函数 6 例 + DB 集成 2 例（`test/decision/mintId.test.js`，8/8 绿）。natural_key 暂统一取 `slug`（粒子已实现），`decision_relation` 派生 `rel_id` 留待后续。

#### B. 词表强制（未声明词项 = 构建失败）— **部分采纳，并入 6.6**

- **Semantica 做法**：词表须显式声明（如 `semantica:format`、`@type: "semantica:KnowledgeGraph"` 须入 `EMITTED_TERMS`），**未声明词项导致构建失败**。
- **我方现状**：`particleModel.js:262-270` 已有 21 条 `CONTROLLED_PREDICATES` 白名单（拒绝裸外键），方向一致；但**缺"未声明即失败"的构建期强约束**（当前仅为运行时校验）。
- **判定**：并入 **6.6**（SHACL-equivalent 写时校验），增加**构建/CI 期词表一致性校验**，把运行时拒绝**前移**为构建期失败。

#### C. 撤回与清除（Retraction / Purge，GDPR）— **明确不借鉴，与 R3 对账**

- **Semantica 做法**：`ContextGraph` 支持局部节点撤回（Retraction）与彻底清除（Purge），响应隐私擦除且不必重构整图。
- **我方铁律**：**绝对禁删**（去重走软合并 `meta.merged_into`）。
- **判定**：**不借鉴**，与既有 **R3** 一致——"擦除只在导出物上做，库内保留"（§10.2 R3：导出前走 redact，`prov_export` 记等级与事由）。
- **新增动作**：把该差异写进 §1 **对外讲述口径**，作为"我们比 Semantica 更严"的差异化点，并在导出 UI 明示。

#### D. Explorer 鉴权 fail-closed 范式 — **采纳为 G7 实施模板**

- **Semantica 做法**：未配置 `SEMANTICA_API_KEY` 时 **503（fail closed）** 而非匿名放行；错误/缺失 key 返 **401**；默认绑定 `127.0.0.1`；WebSocket 握手亦校验 key；公开路由仅 `/health`、`/api/info`、静态资源。
- **我方现状（v2 §5 G7）**：`routes.js:1802-1823` 溯源端点无鉴权，vs `calibrationRouter.js` 全 sysadmin；`routes.js:1729-1756` DEPRECATED 未下线。
- **判定**：**采纳为 G7 实施模板**——照抄四条（未配置即 503、错 key 401、WS 握手校验、白名单仅留健康检查），比 v2 的抽象描述更可执行。

#### E. `record_decision` + 因果边 + trace/impact — **确认性印证（无新工作）**

- **Semantica 做法**：`record_decision(category, scenario, reasoning, outcome, confidence, metadata)` 把决策记为一等节点；`add_causal_relationship(app_id, uw_id, "CAUSED")` 显式建因果边；`trace_decision_chain(id)` 追溯上游、`analyze_decision_impact(id)` 评估下游。
- **我方现状**：七点 Schema（`decisionRepo.js:39-143`）已覆盖 scenario/reasoning/outcome/confidence；**E1–E7 已含 `CAUSED`**（`edgeDimensionSpec.js:24`）；`ageGraph.js:167-214` trace / `:217-226` impact 已实现；`decision.confidence` 已提列（T8 已落地）。
- **判定**：**无需新工作**，仅作外部印证——我们已具备 Semantica 决策图核心三件套，且**多出 `decision_relation.serves_dimension`（E 边服务哪个维度）**，这是 Semantica 所没有的。

### §11.3 对在途任务的映射

| 增量点 | 落到既有 Task | 说明 |
|---|---|---|
| **A 确定性标识（新设施 6.7）** | **新增**，建议插在 K 闭环构建段（与 6.6 同批） | 影响 ① T25 溯源链稳定性 ② dedup 压力；**须先出设计、批准后再实施** |
| B 词表构建期校验 | 并入 **6.6 / C-DAI T2-part** | 校验时机前移 |
| C 撤回/清除 | 不采纳；落到 **R3 对账 + §1 对外口径** | 差异化点 |
| D 鉴权 fail-closed | **G7 / C-DAI T6** | 作为实施模板 |
| E record_decision | 无（已完成） | 仅外部印证 |

### §11.4 结论

二次借鉴的**净增量只有 1 个真缺口（A 确定性标识）+ 1 个实施模板（D）+ 1 个时机前移（B）**，其余为印证或不借鉴。这再次验证 v2 §0 的核心判定：**本平台与 Semantica 的差距不在"功能有没有"，而在"标识与写入是否可复现、鉴权是否 fail-closed"这类工程确定性细节**；而 **J2/J3 反馈校准闭环（业务结果→根因七类→第0闸写回→重跑）仍是我们领先于 Semantica 的部分**——Semantica 只有"记录与追溯"，没有"校准与重跑"。
