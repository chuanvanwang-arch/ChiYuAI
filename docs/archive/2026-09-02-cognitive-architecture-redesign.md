> ⛔ **已合并 / 已归档（2026-09-02）**
> 本文已并入 **`docs/2026-09-02-cognitive-decision-unified-design.md`**（认知驱动决策子系统 · 统一设计 v3）。
> 本文**仅作历史留档**，一切以合并文档为准。重评修正点：①「Q1 恒 warn」根因错分（真根因是 S2/S3/S4 供给零命中，非 `required_dims` 空）②「概念要素已完整承载」降级（有 ID 无物化）③九尺子 LLM 项由 3 收紧为 1 ④实施顺序整体重排（供给层复通 + L0 原料层前置）。
> 保留内容与处置见合并文档 **附录 A**。

# 认知驱动架构重构设计：K-M-D 三层管道 × 九尺子内嵌 × 闭环回流

- 版本：**v2**（v1 → v2 修订）
- 日期：2026-09-02
- 设计输入：
  - `C:\Users\wangchuan08\Documents\人类知识、记忆与决策的关系.txt`（下称《认知文档》）
  - `C:\Users\wangchuan08\Documents\# 2B销售全流程决策自检框架.txt`（下称《销售自检》）
- 实测库：`crm_native`（PostgreSQL 5433，schema `crm`）——本文件所有行数均为直连生产库实测
- 状态：**未批准，不写实现代码**（HARD-GATE）

### v2 修订要点（2026-09-02 用户明确）

| 维度 | v1（五层 K-M-T-J-R） | v2（三层 K-M-D） |
|---|---|---|
| 八要素 | T 独立层 | **并入 D，作为 D 决策的内涵结构**（用户：八要素就是 J 判了什么内容，不是新一层） |
| 九尺子 | R 独立层 + 监控台三视图 | **内嵌到 D 决策生成过程**，产物 = 错误归因 chip + 评分（用户：九尺子应内嵌决策过程，不应单独建层） |
| 闭环 | 仅 I6 学习回写（处方批准） | **新增第三条腿「闭环回流」**：I4 复盘 → 新知识 / I5 后见之明 → 改写记忆 / I6 证实性偏差 → 一致性校验（用户：本轮明确"决策反过来改写记忆与知识"） |
| 7 轴 | M 层维度 | **不占层**：能力保留、层级取消——降为 D 层「信息」要素的**结构化账本** + **写前门禁**（用户追问"7 轴为何还需要保留"，详见 §3.4） |
| 监控台 | 拓扑 / 思维 / 评判三视图并列 | **场景列表 + 决策详情**——九尺子 chip 内嵌、7 轴档位真实化 |

---

## §0 执行摘要：三问三答

### 问 1：按文档重构系统架构，怎么重构？

答：把现有 **K/M/J 三系统**升级为 **K-M-D 三层管道**，九尺子不另起一层，而是**内嵌到 D 决策生成过程**——决策每落一笔，九尺子同步产出错误归因 chip；闭环回流作为第三条腿，让决策反过来改写 K 和 M。

- K 知识系统（用什么判）— 改造
- M 记忆系统（记得什么）— 改造
- **D 决策层** = J 判定层 + T 八要素内涵 + R 九尺子内嵌
- **闭环回流**（D → K + M）— 新增三条腿
  - **复盘** → 新知识生成（错误假设 → 反面先例）
  - **后见之明** → 改写记忆（成功强化 / failure 改写场景记忆 tag）
  - **证实性偏差** → 一致性校验（决策时判定 vs 回看时判定比对）

### 问 2：知识、记忆、决策三系统如何打通？

答：当前三系统是**物理相邻、逻辑断开**。打通靠七个接口契约（§4），最关键的三处断点：

| 断点 | 证据 | 后果 |
|---|---|---|
| K→M 断裂 | `decision_scenario.required_dims` **12/12 场景全为 `[]`** | `sevenDimensionsCheck` 恒返回"无必填维"，七维拦截**从未触发过一次** |
| J→K 断裂 | `calibration_patch` **0 行**、`decision_retro_report` **0 行** | 知识从不因决策结果改变，**系统不学习** |
| D→M 断裂 | `memory_log` 36 行全 `L-Workspace`，无 outcome 回写 | **决策结果从不改写记忆**（用户本轮强调：成功后见之明 / 失败重塑场景记忆均无承载） |

「闭环回流」专治第三类断点。

### 问 3：`/sales-decision-monitor` 的跟踪过程可以完全参考八要素和九尺子吗？

答：**可以参考，且应当完全参考**。但八要素不是新一层（是 D 决策的内涵结构），九尺子不是新一视图（是 D 决策的内嵌检查）。监控台改造方式：

- **场景列表**：每个场景显示「决策准确率 / 必填完整率 / 样本」+ **错误归因 chip 群**（九尺子内嵌产物：输入不及时 / 维度不对 / 先例污染 / 字段不一致 / 边选择不对 ...）
- **决策详情弹窗**：决策网络，显示「根决策 / 可审计性 1/4（Q1/Q2/Q3/Q4 状态）」+ **上下文维度供给档位**（7 轴：3/7 已供给、5/7 未达门槛）+ 当时的上下文 + 直接原因 + 上游子图 + 下游影响

这两块在平台现有 `/sales-decision-monitor` 上**已成型**（截图复核 2026-09-02：场景列表的「输入不及时 1 / 维度不对 1 / 字段不一致 1 / 边选择不对 1 / 先例污染 1」chip 群、决策详情弹窗的「!Q1 / !Q2 / ✓Q3 / !Q4」+ 「上下文维度供给档位 3/7」）。本设计把它从「空转展示」升级为「有真实评分数据驱动、有归因、有 chip 真实聚合」。

---

## §1 设计输入与依据

### 1.1 《认知文档》三条主线（逐字引用）

**主线一：闭环**（文档 L20）
> 闭环：记忆 → 形成知识 → 做出决策 → 决策结果反馈 → 更新记忆与知识，循环迭代。

**主线二：八要素**（文档 L22–L49）
> 核心观点：任何一次思考、任何推理过程，都同时包含这8个要素，相互联动。批判性思维就是把自己和他人的思考拆解这8个构件，逐一审视校验。

八要素编号与字面表述（文档 L24–L46）：
1. 目的 Purpose｜目标、意图
2. 问题 Question at issue｜关键议题、待解决问题
3. 信息 Information｜数据、事实、经验、证据
4. 概念 Concepts｜观念、定义、理论、模型
5. 假设 Assumptions｜预设、前提（大多是无意识）
6. 推论 Inference / Interpretation｜推断、解释、得出结论
7. 视角 Point of View｜观点、参照框架、立场
8. 意涵与后果 Implications & Consequences｜潜在含义、逻辑结果

**主线三：九尺子**（文档 L52）
> 三、9大评判尺子：清晰性、准确性、精确性、相关性、深度、广度、逻辑性、重要性、公平性。

> **文档内部不一致（须裁定）**：L52 标题行是「清晰性、准确性、精确性、相关性、深度、广度、逻辑性、重要性、公平性」，L54–L62 的 1–9 展开顺序是「清晰性、准确性、精确性、深度、相关性、逻辑性、重要性、广度、公平性」。
> **本设计以 L54–L62 的 1–9 编号为准**（编号是显式锚点），即：1清晰性 2准确性 3精确性 4深度 5相关性 6逻辑性 7重要性 8广度 9公平性。标题行与展开的差异源于"标题行侧重视觉排列、展开侧重视逻辑推进"，**统一采用"相关性"**（上游已修正 v1 的"关联性"）。

### 1.2 项目既有架构资产（复用，不推翻）

| 资产 | 位置 | 在本设计中的角色 |
|---|---|---|
| K/M/J 三系统命名 | `src/decision/closure.js:1-5`、`src/decision/retro.js:26-29` | 保留，作为三层管道的 K/M/J 三段 |
| 七维 L1–L7 | `src/sevenDimensions/constants.js:5-13` | **供给侧分类口径，不占层**——是 D 层「信息」要素的结构化账本 + 写前门禁（见 §3.4） |
| 七边 E1–E7 | `src/decision/edgeDimensionSpec.js:18-38` | M 层关系 |
| S1–S7 供给操作 | `src/context/supplySpec.js:16-24` | K→M 装配通道 |
| 上下文装配 | `src/context/assembleContextV2.js:161-226` | M 层产出（已接线 ✅） |
| 审计四问 | `src/decision/auditability.js:34-121` | D 层"决策四问"已有部分 |
| 七类根因 | `src/decision/rootCauseClassifier.js` | D 层根因归因 |
| 13 类校准旋钮 | `src/calibration/knobs/index.js:16-31` | I7 处方回写执行器（零触发 ❌） |
| **`/sales-decision-monitor` 现有 UI** | `src/web/sales-decision-monitor.html` | **场景列表 chip + 决策详情弹窗已成型**，本设计做"真实数据驱动"升级 |

---

## §2 现状审计：三系统物理相邻、逻辑断开

### 2.1 生产库实测（2026-09-02，库 `crm_native`）

| 层 | 载体 | 行数 | 判定 |
|---|---|---|---|
| K | `skill_registry`（方法 SKILL） | 24 | ✅ 有 |
| K | `decision_scenario`（场景卡） | 12 | ⚠️ 有表无知识 |
| K | `decision_rule`（规则库） | **0** | ❌ 空转 |
| K | `policy_version`（策略版本） | **0** | ❌ 空转 |
| K | `assertions`（断言） | **0** | ❌ 空转 |
| K | `meta_attr`（字段约束） | **0** | ❌ 空转 |
| K | `config_store`（配置） | **1** | ❌ 仅 `decision-context-guard` |
| M | `particles` | 71 | ✅ 有 |
| M | `memory_log` | 36 | ⚠️ 全 L-Workspace，无 L-User/L-Org |
| M | `memory_note`（常驻笔记） | **1** | ❌ 近乎空 |
| M | `memory_snapshot`（不可变快照） | **0** | ❌ 空 |
| M | `decision_relation`（E1–E7 边） | 21 | ⚠️ 运行时 14 / 演示 7 |
| M | `decision_context_snapshot` | 26 | ⚠️ `supplied_dims` 最高 **4/7** |
| M | `decision_provenance` | 8 | ⚠️ `context_supply` 7 / `decision` 1 |
| J→D | `decision` | 12 | ✅ 有 |
| J→D | `decision_outcome` | 4 | ⚠️ 但 `decision.outcome` 列 **0/12** |
| J→D | `decision_precedent_rel` | 4 | ⚠️ 少量 |
| D→K | `calibration_patch` | **0** | ❌ 学习层从未触发 |
| D→K | `decision_retro_report` | **0** | ❌ 复盘从未触发 |

### 2.2 五个致命断点（代码级证据）

**B1 · 知识从未注入判定（P0）**

`decision_scenario.required_dims` 12/12 全为 `[]`（实测）。链路：

```
sevenDimensions/engine.js:13-19   读 required_dims → required = []
sevenDimensions/engine.js:21-29   遍历 required → missing 恒为 []
decision/decisionRepo.js:77-81    decideInterception(chk) → 恒不 block
monitor/attribution.js:70         category 恒 'ok'
```

后果：七维拦截引擎、T3 拦截闭环、`attribution.required_fill`、七维覆盖校验**全部是空转代码**。写了、测了、但从没在真实数据上触发过。

**B2 · 维度供给天花板 4/7（P0）**

`decision_context_snapshot.supplied_dims` 分布：1(3) / 2(5) / 3(6) / 4(12)，无一条 ≥5。
而 `auditability.js:18` 设 `Q1_MIN_SUPPLIED_DIMS = 5`，`auditability.js:74` 判 pass 需 `supplied_dims >= 5`。
→ **Q1 恒 warn，可审计性上限锁死在 3/4**，无论代码怎么改。

**B3 · 业务结果零回写（P0）**

`decision.outcome` 0/12，`decision_outcome` 表 4 行有数据但**未回写主表列**。
→ J2 反馈回路、`applyOutcome`（`monitor/attribution.js:165-170`）、"决策通过率 vs 业务成功率"双环对比全部无输入。
→ **闭环回流三条腿全部无输入**：复盘（I4）/ 后见之明（I5）/ 证实性偏差（I6）全部空转。

**B4 · 记忆只有单层（P1）**

`memory_log` 36 行全部 `layer='L-Workspace'`，无 L-User（用户级）、无 L-Org（组织级）。`memory_note` 1 行、`memory_snapshot` 0 行。
→ 双轨记忆（append-only 日志 + curated 常驻笔记）只有日志轨在跑。

**B5 · 思维结构缺失 / 决策内容不完整（P0）**

`decision` 表 33 列，逐条比对八要素：
- 目的、假设、意涵、视角：**无任何列承载**
- 推论：`rationale` 12/12 有值，但是自由文本（实测多为探针文案），无结构
- 信息：完整（`conditions_evaluated` + 7 轴供给）
- 概念：完整（`methodology_ids`）

→ 八要素 2/8 完整、1/8 弱、4/8 无；九尺子没有评分对象。

---

## §3 顶层架构：K-M-D 三层管道 × 九尺子内嵌 × 闭环回流

### 3.1 三层职责

```
┌─ K 知识系统 ─ 用什么判 ─────────────────────────────┐
│  本体词汇 · 方法 SKILL · 场景卡 · 规则库 · 策略版本 · 字段约束   │
│  产出：判据（必填维 / 规则 / 阈值 / 方法论）             │
└──────────────────────┬──────────────────────────────┘
                       │ I1 判据注入（当前断裂）
┌─ M 记忆系统 ─ 记得什么 ─────────────────────────────┐
│  7 轴事实域（identity / structure /                    │
│  semantics / time_config / decision_history /          │
│  operational_state / governance）                      │
│  ↑ 供给侧分类口径，不占层 · 见 §3.4                    │
│  E1–E7 边 · L-User/Workspace/Org 三层记忆              │
│  产出：上下文快照（S1–S7 装配，已接线 ✅）                │
└──────────────────────┬──────────────────────────────┘
                       │ I2 上下文装配（已通）
┌─ D 决策层 ─ 判了什么 + 怎么想 + 好不好 ─────────────┐
│  ├─ 八要素内涵                                       │
│  │   目的 / 问题 / 信息 / 概念 / 假设 / 推论 / 视角 / 意涵 │
│  │   （信息 = 7 轴账本 + conditions_evaluated）        │
│  │   （概念 = methodology_ids）                       │
│  │   （其他 6 要素 = decision 表 6 个 JSONB 列）       │
│  ├─ 九尺子内嵌检查（确定性 6 + LLM 3）                  │
│  │   每条尺子同步产出：错误归因 chip + 评分              │
│  │   （输入不及时 / 维度不对 / 先例污染 / 字段不一致 / 边选择不对 / ...）│
│  └─ 决策四问审计（Q1 直接原因 / Q2 源头溯源 / Q3 冲突事实 / Q4 下游影响）│
└──────────────────────┬──────────────────────────────┘
                       │ I3 决策物化（含八要素 + 内嵌评分 + PROV-O）
                       ↓
┌─ 闭环回流：决策改写 K + M（三条腿，新设计核心）──────────┐
│  ├─ I4 复盘 → 新知识（错误假设 → 反面先例登记 / 新规则沉淀） │
│  ├─ I5 后见之明 → 改写记忆（成功强化 / failure 改写场景 tag）│
│  └─ I6 证实性偏差 → 一致性校验（决策时 vs 回看时比对）       │
└──────────────────────┬──────────────────────────────┘
                       └─ 回到 K / M（闭环）
```

### 3.2 九尺子位置：内嵌决策过程，不另起一视图

关键设计判断：九尺子**不**是 R 独立层，**不**是监控台单列视图，而是**D 决策层生成时同步触发的内嵌检查**。

| 尺子 | 内嵌位置 | 判定信号 | 产物 chip 示例 |
|---|---|---|---|
| 1 清晰性 | 决策生成时 | 目的/问题是否非空可阐述 | "目的不清" / "问题模糊" |
| 2 准确性 | 决策生成 + 业务结果回写 | `outcome_verified` 与事实校验 | "事实不准" / "未验证" |
| 3 精确性 | 决策生成 | 条件是否带具体数值/权重 | "条件粗略" |
| 4 深度 | 决策生成 + 复盘 | 根因是否探到、粒子三检 | "根因浅尝" |
| 5 相关性 | 决策生成 | 必填维与供给项映射度 | "维度不对" / "必填缺 1" |
| 6 逻辑性 | 决策生成 | 断言冲突检测 | "逻辑冲突" |
| 7 重要性 | 决策生成 | `business_tier` 业务分级 | "重要性误判" |
| 8 广度 | 决策生成 | 视角数 / 先例引用数 / 方法论数 | "边选择不对" / "视角单一" |
| 9 公平性 | 决策生成 + 复盘 | 反方证据是否检索、假设是否被质疑 | "先例污染" / "未检反方" |

**产物形式**：每个场景的尺子评分聚合为 chip 标签群（如截图中的「输入不及时 1」「维度不对 1」「先例污染 1」「字段不一致 1」「边选择不对 1」），落在场景列表的对应行；决策详情弹窗内下钻到「评分卡」折叠区展示每项明细。

### 3.3 三层与三个评估维度（**正交、不重叠**）

| 维度 | 本质 | 当前承载 | 与三层的关系 |
|---|---|---|---|
| **7 轴事实域** | 决策依据的 7 类上下文事实（是谁/长什么样/语义/时效/历史/运行态/治理） | `decision_context_snapshot.supplied_dims` | **不占层**：是 D 层「信息」要素的**结构化账本**，同时兼**写前门禁** |
| **八要素** | 决策的内部构造（怎么想的） | `decision` 表 8 列 JSONB | D 层内涵（其中「信息」要素的度量口径 = 7 轴） |
| **九尺子** | 决策的质量度量（想得好不好） | `decision.rubric` + `decision_rubric_score` | D 层内嵌检查（多项直接读 7 轴供给） |

三者**正交**：决策依据（7 轴事实域）→ 决策内部构造（八要素）→ 决策质量评估（九尺子）。

### 3.4 7 轴为何不可替代：六项运行时职责

> 用户追问（2026-09-02）："7 轴为何还需要保留？"
> 结论：**能力保留、层级取消**。7 轴不是"质量评估层"，是**供给侧事实域清单 + 写前门禁**。八要素是描述性的、九尺子是评估性的，两者都发生在决策**产生之后**；7 轴是唯一能在决策**产生之前**确定性说"不"的一层。

**六项运行时职责（均为真实调用点，非设计意图）**

| # | 职责 | 代码位置 | 生效时点 | 为何八要素/九尺子替代不了 |
|---|---|---|---|---|
| 1 | **写前准入闸门** | `decisionRepo.js:77` → `interception.js:17` | 写操作**前** | 八要素是描述、九尺子是评分，都不产生"拒写"动作；只有 `allowed=false` 能让写引擎返回 `missing_context` |
| 2 | **错误归因坐标系** | `decisionRepo.js:70` → `computeAttribution` | 写时 | 5 类 chip（维度不对/先例污染/字段不一致/边选择不对/输入不及时）的**分类依据就是 7 轴**；删掉后归因无坐标 |
| 3 | **可审计性 Q1 门槛** | `auditability.js:14,72-96` | 写后 | `supplied_dims ≥ 5/7` 是 Q1 的判据常量，无替代口径 |
| 4 | **降级留痕载体** | `assembleContextV2.js:174-190` → `decision_context_snapshot.supplied_dims` | 写时 | 记录"这次装配真跑到了几维"，是 fail-safe 降级留痕的唯一数值载体 |
| 5 | **装配完整性自检** | `supplySpec.js:31-51` `validateSupplySpec` | 装配时 | 强制 7 操作 × 7 维全覆盖，杜绝悬空操作/悬空维；`context-supply-7x7.test.js` 以此为准 |
| 6 | **页面级门禁** | `S07.schema.js:6`、`S06.schema.js:34` | 页面推进时 | 推进到 quoted/contracted 前触发拦截，属流程闸门 |

**判据（一句话）**：8 要素填得再全，也不能证明「查过先例」——`decision_history` 维的空值判定能；9 尺子评得再高，也拦不住「缺 identity 就落笔」——`governance/identity` 的 block 闸门能。

**7 轴的边界（同样要明确）**：它只判"有没有"，不判"对不对"。`identity` 维有值 ≠ 身份判定正确。所以**7 轴过了 ≠ 决策质量好**——那正是九尺子的位置。

### 3.5 空转不是"该删"，是"该修"

7 轴当前确实从未生效，生产库实测连锁反应如下（详见 §2）：

| 环节 | 实测 | 后果 |
|---|---|---|
| `decision_scenario.required_dims` | 12 场景：11 个 `[]` + 1 个 `{}` | 拦截引擎读不到任何必填维 |
| `sevenDimensionsCheck` | `required=[] → missing=[] → allowed` 恒 `true` | **从未 block 过一次** |
| `attribution.category` | 仅 `input_missing` 7 / `ok` 3 | 5 类归因退化为 1 类 |
| `supplied_dims` | 1(3) / 2(5) / 3(6) / 4(12)，峰值 **4/7** | Q1 门槛 5/7 无一条可达 |

**判定**：删 7 轴 = 拆掉闸门 + 拆掉归因坐标系 + 拆掉 Q1 判据，然后需要重建一套等价机制。**修**（T2-6 回填 `required_dims`）的成本远低于**删后重建**。

### 3.6 闭环回流三条腿（v2 新增）

| 腿 | 触发器 | 写入位置 | 用户文档对应 |
|---|---|---|---|
| I4 复盘 → 新知识 | 决策 outcome 落地 / 定时批量 | `decision_provenance.entry_type='RETRO'` + `decision_precedent_rel(negative_precedent=true)` | 认知文档"决策结果反馈 → 更新记忆与知识" |
| I5 后见之明 → 改写记忆 | 决策 success/failure 判定 | `memory_log` + `particles.tag`（`[verified]` / `[rewritten:hindsight]`） | 用户本轮明确"决策结果会重塑我们对过去记忆的解读" |
| I6 证实性偏差 → 一致性校验 | 决策时 vs 回看时 | `decision_provenance.entry_type='HINDSIGHT_CHECK'` | 用户本轮明确"决策的复盘，会生成新的知识" |

**纪律**：所有写入**append-only**，不 DELETE、不覆盖原内容；改写 tag 与原 tag 同存，靠检索时加权让新 tag 自然浮现。

---

## §4 三系统打通：七个接口契约

| 编号 | 接口 | 从→到 | 现状 | 契约内容 | 载体 |
|---|---|---|---|---|---|
| I1 | 判据注入 | K→M | ❌ 断裂 | 场景 `required_dims` 非空；规则库有行；`meta_attr` 有约束 | `decision_scenario.required_dims`、`decision_rule`、`meta_attr` |
| I2 | 上下文装配 | M→M | ✅ 已通 | S1–S7 并行装配、快照落库、PROV-O 留痕 | `assembleContextV2.js:161` |
| I3 | 决策物化 | M→D | ⚠️ 半通 | 八要素物化 + 九尺子内嵌打分 + 决策四问审计 + PROV-O | `decisionRepo.js:44` + `decision` 8 列 |
| **I4** | **复盘回流** | **D→K** | **❌ 断裂** | outcome/feedback → 场景/规则沉淀 → 反面先例登记 | `decision_provenance.entry_type='RETRO'` + `decision_precedent_rel` |
| **I5** | **后见之明改写记忆** | **D→M** | **❌ 断裂** | 成功强化原记忆 tag / failure 改写场景记忆 tag | `memory_log` + `particles.tag` |
| **I6** | **证实性偏差校验** | **D→D** | **❌ 缺失** | 决策时判定 vs 回看时判定一致性比对 | `decision_provenance.entry_type='HINDSIGHT_CHECK'` |
| I7 | 知识回写（高级闭环） | D→K | ❌ 断裂 | 处方生成 → 第 0 闸审批 → 落 `calibration_patch` → 改知识 | `calibration/knobs/index.js` |

### 4.1 I1 修复方案（知识注入，P0）

`decision_scenario.required_dims` 的 12 个场景按语义预设初值（存 `decision_scenario.required_dims` 列本身，**单一事实源**，可后台改，守**阈值配置化铁律**）：

| 场景 | 必填维 | 推导依据 |
|---|---|---|
| `LEAD_FOLLOW_UP` | `identity, structure, semantics, time_config` | 信息（客户业务/组织角色）+ 精确性（决策人/项目时间） |
| `OPP_QUALIFY` | `identity, structure, decision_history, operational_state` | 视角（四类角色）+ 问题（赢率→先例）+ 准确性 |
| `SOLUTION_VALUE` | `semantics, structure, decision_history` | 概念（刚需/期望/锦上添花）+ 深度 + 相关性 |
| `QUOTE_PRICING` | `semantics, time_config, operational_state, governance` | 精确性（预算/时间）+ 视角（毛利/法务/交付）+ 清晰性 |
| `SIGN_RISK` | `structure, operational_state, governance, decision_history` | 信息（反对者/交付/验收/预算审批）+ 广度 + 公平性 |
| `POST_CONTRACT` | `time_config, operational_state, governance` | 清晰性（合同内外边界）+ 逻辑性（回款节点） |
| `LOSS_REVIEW` | `decision_history, semantics, operational_state` | 深度（未来预算/痛点/内线）+ 重要性 |
| `CLIENT_STRATEGY` | `structure, operational_state` | 视角（客户内部角色地图） |
| 治理类 4 场景 | `[]` | 非业务场景，不参与七维拦截 |

`on_missing` 全部先设 `warn`（不阻断既有流程），稳定后再按场景逐个升 `block`。详见领域实例化文档 §4。

### 4.2 I4 修复方案（复盘回流，P0）

**触发链**：

```
决策 outcome 落地（业务结果回写，依赖 I3 决策物化时的 outcome_verified）
   ↓
定时或批量触发 retro（`src/decision/retro.js`）
   ↓
回看当初目的 / 信息 / 假设 / 推论
   ↓
找出错误假设与缺失信息
   ↓
写 decision_provenance.entry_type='RETRO'
   ├─ 错误假设 → 自动登记为反面先例（decision_precedent_rel, negative_precedent=true）
   └─ 知识更新提案 → 生成 calibration_patch 处方（待 I7 审批，AI 不直接改配置）
```

**纪律**：所有写入 append-only，不 DELETE、不覆盖原内容；provenance 作为决策的"审计追溯 + 学习轨迹"双重载体。

### 4.3 I5 修复方案（后见之明改写记忆，P1）

**机制**：
- 决策 success → 强化 `particles` 中对应场景记忆的 `tag`，写入 `memory_log.kind='HINDSIGHT_BOOST'`
- 决策 failure → 改写 `particles` 中场景记忆的 `tag`，写入 `memory_log.kind='HINDSIGHT_REWRITE'`
- tag 改写与原 tag 同存（append `tag_history` 字段），靠检索时加权让新 tag 自然浮现
- 写时向量化时携带新 tag，**让检索自然加权**

**与 B4（记忆只有单层）的关系**：I5 落地后会驱动 L-User / L-Org 分层（同一决策在 L-Workspace 是工作流、L-User 是个人偏好、L-Org 是组织模式）。

### 4.4 I6 修复方案（证实性偏差校验，P1）

**机制**：
- 决策时 vs 复盘时：同一决策的判定是否一致？
- 不一致 → 写 `decision_provenance.entry_type='HINDSIGHT_CHECK'`，记录偏差（哪一要素、何时判定、回看判定）
- **新知识生成**：偏差本身成为「公平性」尺子的反面证据，沉淀为场景知识（如 `required_dims` 调整、聚焦矩阵修订）
- 偏差率超过阈值（如 30%）→ 自动生成 calibration_patch 处方（待 I7 审批）

### 4.5 I7 修复方案（学习回写，P2）

```
retroTrigger（定时/批量） → retro.js 生成 draft_patches
                          ↓
                     管理员审批（决策第 0 闸，走 createDecision）
                          ↓
                  calibration_patch 落库（knob 策略执行）
                          ↓
                  config_store 变更 → 下次决策生效（K 层改变）
```

关键点：处方批准必须走 `createDecision` 真实决策行（项目既有约定，见工作记忆"处方批准走 createDecision 真实决策行（CALIBRATION_CHANGE）"），不新开写通道。

---

## §5 D 层设计：八要素内涵 + 九尺子内嵌 + 决策四问

### 5.1 八要素落地（`crm.decision`，8 个 JSONB）

| 列名 | 承载要素 | 结构 | 状态 |
|---|---|---|---|
| `intent` | 1 目的 + 2 问题 | `{ purpose, hidden_goal, question, sub_questions[] }` | **新增** |
| `assumptions` | 5 假设 | `[{ id, text, basis, falsifiable_by, risk_if_wrong }]` | **新增** |
| `inference` | 6 推论 | `{ chain: [{ evidence, via_assumption, conclusion }], conclusion }` | **新增** |
| `viewpoints` | 7 视角 | `[{ stance, holder, covered }]`——**单独建列**（视角是一等公民，并入 inference 会丢） | **新增** |
| `implications` | 8 意涵与后果 | `[{ type: positive/negative, text, probability, mitigation }]` | **新增** |
| `risk_register` | 三件套·风险清单 | `[{ risk, severity: high/mid/low, evidence, mitigation, owner }]` | **新增** |
| `stop_loss` | 三件套·止损条件 | `{ condition, deadline, trigger, owner, status: armed/triggered/released }` | **新增** |
| `rubric` | 九尺子评分物化 | `{ scores: {clarity:..}, weighted_total, level, degraded[], scored_at }` | **新增** |

**不新增列**（复用既有）：
- 3 信息 → `conditions_evaluated` + 7 轴供给（`decision_context_snapshot.supplied_dims`）—— **完整**
- 4 概念 → `methodology_ids` —— **完整**

**新增动机**（来自《销售自检》第四部分"决策三件套"）：
- `risk_register` / `stop_loss` 填补 `QUOTE_PRICING` / `SIGN_RISK` 已挂 `STOP_LOSS` 方法论却无字段承载的空洞
- 八要素列让九尺子有评分对象，让复盘回流（I4）有可对照的原始记录

### 5.2 迁移纪律（踩坑铁律，必须遵守）

> **禁止**把新列写进 `db/schema.sql:150` 的 `CREATE TABLE IF NOT EXISTS crm.decision (...)` 段内——旧库表已存在时**不会补列**。
> **必须**在 `db/migrate.js` 的向后兼容段（`migrate.js:50-82` 同模式）追加独立 `ALTER TABLE crm.decision ADD COLUMN IF NOT EXISTS ...`。
> 原因：`db/migrate.js` 是整文件单事务，一处报错导致全量迁移回滚（2026-08-31 生产库实测 `column "stable_key" does not exist`）。

### 5.3 写入口径

- 写入点：`createDecision`（`src/decision/decisionRepo.js:44`）主干内，与 `assembleContextV2` 调用同级，**fail-open**（物化失败仅 `emit trace` + `recordFailure`，不阻断决策）。
- 空值策略：允许 `null`，但评分时"无证据"计 0 分——**不静默、不用默认值美化**（BG-04 反假绿铁律）。
- 补齐通道：历史决策提供 `POST /api/decision/:id/thinking` 人工补录（不 DELETE、不覆盖，append 到 `decision_provenance` 留痕）。

### 5.4 九尺子内嵌检查器（确定性 6 + LLM 3）

**存储**：
- `crm.decision.rubric` JSONB 列——物化最新评分，供列表页快速读
- `crm.decision_rubric_score` 新表——append-only 评分历史（每次重评新增一行，不 DELETE）

**评分规则**（0–4 分，及格线存 `config_store['rubric-thresholds']`，**禁止硬编码**）：

| 尺子 | 评分方式 | 0 分 | 2 分（及格） | 4 分 | chip 关键词 |
|---|---|---|---|---|---|
| 1 清晰性 | LLM | 无 intent | purpose+question 齐 | 含子问题拆解 | "目的不清" / "问题模糊" |
| 2 准确性 | 确定性+LLM | 无 outcome | outcome_verified 有值 | 业务结果验证通过 | "事实不准" / "未验证" |
| 3 精确性 | 确定性 | 无条件 | 条件带权重且 ≥3 条 | 含具体数值与来源 | "条件粗略" |
| 4 深度 | 确定性 | 无 root_cause | root_cause 有值 | 三检通过且根因具体到字段 | "根因浅尝" |
| 5 相关性 | 确定性 | required_dims 空 | 必填维全覆盖 | 供给项与维度精准映射 | "维度不对" / "必填缺 1" |
| 6 逻辑性 | 确定性 | 有未决冲突 | 无未决冲突 | 无冲突且 PROV-O 链完整 | "逻辑冲突" |
| 7 重要性 | 确定性 | 无 tier | tier 有值 | 高风险匹配治理要求 | "重要性误判" |
| 8 广度 | 确定性 | 无视角无先例 | ≥2 方法论或 ≥1 先例 | ≥3 方法论 + 先例 + 反方证据 | "边选择不对" / "视角单一" |
| 9 公平性 | LLM | 无假设 | 有假设台账 | 假设被反方证据检验 | "先例污染" / "未检反方" |

**降级纪律**：LLM 不可用 → `degraded=true` + 该项标 `warn`，**不阻断、不静默、不用假分填充**（fail-safe 降级留痕）。

**与 attribution 的关系（正交，不合并）**：

| | `attribution` | `rubric` |
|---|---|---|
| 回答 | 输入齐不齐 | 思维好不好 |
| 时机 | 写时物化 | 决策生成时同步内嵌（可重跑） |
| 关系 | rubric 消费 attribution 作为证据之一 | — |

两者**不合并、不互相替代**。

### 5.5 决策四问（已有 `auditability.js`）

```
Q1 直接原因     ─ supplied_dims >= 5 ?
Q2 源头溯源     ─ decision_relation 上游可达 ?
Q3 冲突事实     ─ decision_precedent_rel 冲突未决 ?
Q4 下游影响     ─ decision_relation 下游可达 ?
```

**与九尺子的关系**：决策四问管"可审计性"（能不能查），九尺子管"思维质量"（好不好），两者正交。

---

## §6 闭环回流：决策改写 K + M（三条腿）

### 6.1 第一条腿：I4 复盘 → 新知识生成

文档第四部分第 5 步 + 认知文档「决策结果反馈 → 更新记忆与知识」。

**触发链**：

```
决策 outcome 落地（业务结果回写，依赖 5.1 八要素物化 + outcome_verified）
   ↓
定时或批量触发 retro（`src/decision/retro.js`）
   ↓
回看当初目的 / 信息 / 假设 / 推论
   ↓
找出错误假设与缺失信息
   ↓
写 decision_provenance.entry_type='RETRO'，payload：
   ├─ assumption_review: [{ assumption_id, verdict: held|falsified, evidence }]
   ├─ missing_information: [{ dim, what, would_have_changed }]
   ├─ conclusion_quality: 'as_expected' | 'better' | 'worse'
   └─ knowledge_update: [{ target, patch }]  ← 提案，不直接生效
   ↓
若 assumption_review 中出现 falsified → 自动登记为反面先例
   写 decision_precedent_rel(decision_id, precedent_id, negative_precedent=true)
   供九尺子 9 公平性 / 4 深度 在决策生成时检索反面证据
```

**与 I7 的边界**：本条腿**只生成知识更新提案**，必须经 I7 处方批准流程（`src/calibration/*`，走 createDecision 真实决策行 `CALIBRATION_CHANGE`）才落到 `decision_scenario`——**AI 不直接改生产配置**。

### 6.2 第二条腿：I5 后见之明 → 改写记忆

认知文档「后见之明」+ 用户本轮强调「决策结果会重塑我们对过去记忆的解读」。

**机制**：

| 决策结果 | 改写动作 | 写入位置 |
|---|---|---|
| 成功 (outcome=success) | 强化原记忆 tag | `memory_log.kind='HINDSIGHT_BOOST'` + `particles.tag += [verified]` |
| 失败 (outcome=failure) | 改写场景记忆 tag | `memory_log.kind='HINDSIGHT_REWRITE'` + `particles.tag += [rewritten:hindsight]` |
| 推翻（信息不实）| 标注存疑 | `memory_log.kind='HINDSIGHT_QUESTION'` + `particles.tag += [questioned:hindsight]` |

**纪律**：
- tag 改写**append 到 `tag_history`**，原 tag 不删除
- 检索时按 tag 时间加权（`weight = recency × boost_factor`），让新 tag 自然浮现
- 写时向量化时携带新 tag，**让检索自然加权**

**与 B4（记忆只有单层）的关系**：I5 落地后会驱动 L-User / L-Org 分层——同一决策的改写在 L-Workspace 是工作流、L-User 是个人偏好、L-Org 是组织模式。

### 6.3 第三条腿：I6 证实性偏差 → 一致性校验

认知文档「证实性偏差」+ 用户本轮强调「决策的复盘，会生成新的知识」。

**机制**：

```
决策时：记录 decision.disposition + decision.inference
   ↓
（时间推移，外部事实变化）
   ↓
复盘时：回看同一决策，产出新判定
   ↓
比对：决策时 vs 回看时 是否一致？
   ├─ 一致 → 写 decision_provenance.entry_type='HINDSIGHT_CHECK', verdict='consistent'
   └─ 不一致 → 写 decision_provenance.entry_type='HINDSIGHT_CHECK',
                payload={decision_disposition, retro_disposition, deviation_cause}
   ↓
偏差率 > 阈值（30%）→ 自动生成 calibration_patch 处方
   ├─ 偏差来源：八要素哪一项被高估 / 低估？
   ├─ 提案：required_dims 调整 / 聚焦矩阵修订 / 根因分类扩码
   └─ 待 I7 审批
```

**新知识生成**：偏差本身沉淀为场景知识（如 `required_dims` 加一项 `operational_state`），成为下次决策的输入——**闭环回路的最后一步**。

### 6.4 三条腿的统一纪律

| 纪律 | 说明 |
|---|---|
| append-only | 所有写入不 DELETE、不覆盖；改写走 `tag_history`、补录走 provenance |
| 失败降级留痕 | 任何腿触发失败 → `decision_provenance.entry_type='RETRO_FAILURE'` + emit trace |
| 反假绿 | 没有真实 outcome → 不触发 I4/I5/I6（避免空复盘污染） |
| 反 AI 编造 | 知识更新提案 ≠ 直接生效；必须经 I7 处方审批 |

---

## §7 监控台改造：从"空转展示"到"真实数据驱动"

### 7.1 现状（截图复核 2026-09-02）

`/sales-decision-monitor`（`src/web/sales-decision-monitor.html`，2026 行）当前已成型两个 UI 区域：

#### 7.1.1 场景列表

```
┌────────────────────────────────────────────────┐
│ SOLUTION_VALUE                                  │
│ 决策准确率 —    必填完整率 —    样本 0           │
│ 无错误归因                                       │
│ 钻取决策                                        │
├────────────────────────────────────────────────┤
│ QUOTE_PRICING                                   │
│ 决策准确率 0%   必填完整率 50%  样本 2          │
│ [输入不及时 1] [维度不对 1]   ← 九尺子内嵌产物 chip  │
│ 钻取决策                                        │
├────────────────────────────────────────────────┤
│ SIGN_RISK                                       │
│ 决策准确率 0%   必填完整率 100%  样本 2         │
│ [边选择不对 1] [先例污染 1]                     │
│ 钻取决策                                        │
└────────────────────────────────────────────────┘
```

**已成型**：chip 标签样式、九尺子分组、点击下钻。
**当前缺陷**：chip 标签**来自演示数据**，不是真实评分聚合；样本量为 0 的场景（如 SOLUTION_VALUE）chip 为空。

#### 7.1.2 决策详情弹窗

```
┌─ 决策网络 ─────────────────────────────┐
│ 根决策 c4384ad6...  链状态: —  上游 0 条, 下游 0 条 │
│ 可审计性 1/4  [!Q1] [!Q2] [✓Q3] [!Q4]               │
│ [当时的上下文 / Q1 直接原因 / Q2 源头溯源 / Q3 冲突事实 / Q4 下游影响] │
│ 三国闭环（K/M/J）                                  │
│ Q1 能否解释直接原因                                 │
│ 上下文维度供给档位 3/7, 未达门槛 5/7   ← 7 轴事实域  │
│ 直接原因 · 上游子图                                │
└────────────────────────────────────────┘
```

**已成型**：可审计性 Q1–Q4 状态（!✓）、7 轴供给档位（3/7 已供给、5/7 未达门槛）、三国闭环（K/M/J）、上下文维度与直接原因分 tab。
**当前缺陷**：Q1 恒 warn（因 B2 七维供给天花板 4/7 < 5）、3/7 与 5/7 是常量展示（实际未触发 `sevenDimensionsCheck`）。

### 7.2 改造目标：把"已成型 UI"升级为"真实数据驱动"

| 区域 | 改造项 | 改造方式 |
|---|---|---|
| 场景列表·chip | chip 必须由真实评分聚合，不是演示数据 | 接入 §5.4 九尺子评分器，按场景汇总 |
| 场景列表·准确率 | "决策准确率"必须有真实口径 | 接入 `decision.outcome_verified`，按场景聚合 |
| 场景列表·必填完整率 | "必填完整率"反映 `required_dims` 真实覆盖 | 接入 `decision_context_snapshot.supplied_dims` vs `decision_scenario.required_dims` |
| 决策详情·7 轴档位 | "上下文维度供给档位 3/7"必须真实反映 | 接入 `sevenDimensionsCheck`（I1 修复后才能真实触发） |
| 决策详情·Q1–Q4 | "可审计性 1/4"的 Q 状态必须有真实判定 | 接入 `auditability.js`（I1 + I3 修复后 B2 解锁） |
| 决策详情·思维卡 | 新增"思维卡"折叠区，展示八要素 fill 状态 | 接入 §5.1 八要素物化 |
| 决策详情·评分卡 | 新增"评分卡"折叠区，展示九尺子明细 + 证据 | 接入 §5.4 九尺子评分器 |
| 决策详情·复盘入口 | 新增"复盘"按钮，触发 I4 闭环回流 | 接入 §6.1 复盘 API |

### 7.3 接口清单（只读为主，对齐 `/api/monitor/*` 家族口径）

| 方法 | 路径 | 用途 | 鉴权 |
|---|---|---|---|
| GET | `/api/decision/:id/selfcheck` | 极简自检卡 7 问 | 与决策详情一致 |
| GET | `/api/decision/:id/rubric` | 九尺子评分明细 + 阶段加权 | 同上 |
| GET | `/api/decision/:id/thinking` | 八要素物化内容 | 同上 |
| GET | `/api/monitor/scenario-chips` | 场景列表 chip 聚合 | 与决策详情一致 |
| POST | `/api/decision/:id/thinking` | 人工补录思维要素（append 留痕） | 决策第 0 闸 + HITL |
| POST | `/api/decision/:id/retro` | 提交复盘（写 provenance RETRO） | 决策第 0 闸 + HITL |
| POST | `/api/decision/:id/hindsight-check` | 触发证实性偏差校验（写 provenance HINDSIGHT_CHECK） | 决策第 0 闸 + HITL |
| GET | `/api/config/stage-focus` | 阶段聚焦矩阵（读 `decision_scenario`） | sysadmin |
| PUT | `/api/config/stage-focus` | 修改聚焦矩阵/必填维 | sysadmin + 第 0 闸 |

**所有写操作必经决策第 0 闸 + HITL 确认**（零信任铁律）。

---

## §8 方案选型

| | 方案 A · 最小可评判 | 方案 B · 三层完整 + 九尺子内嵌（推荐） | 方案 C · B + 全闭环回流 |
|---|---|---|---|
| D 层 8 列 | ✅ | ✅ | ✅ |
| 确定性 6 尺子内嵌 | ✅ | ✅ | ✅ |
| LLM 3 尺子 | ❌ 标 N/A | ✅ 配置开关 | ✅ 配置开关 |
| 监控台 chip 真实化 | ⚠️ 部分 | ✅ | ✅ |
| 7 轴档位真实化（依赖 I1） | ⚠️ 部分 | ✅ | ✅ |
| I4 复盘 → 新知识 | ❌ | ✅ | ✅ |
| I5 后见之明改写记忆 | ❌ | ⚠️ 框架但未触发 | ✅ |
| I6 证实性偏差校验 | ❌ | ⚠️ 框架但未触发 | ✅ |
| I1 知识注入（required_dims 回填） | ❌ | ❌ | ✅ |
| I7 处方回写 | ❌ | ❌ | ✅ |
| 改动量 | 小 | 中 | 大 |
| 闭环完整度 | 无闭环 | 半闭环（I4 通，I5/I6 框架） | 全闭环 |

**推荐 B**：先把"九尺子内嵌决策过程"立起来，让场景列表的 chip 真实化、决策详情有评分；闭环回流的 I4（复盘）先做，I5/I6 只搭框架。完成后用真实评分驱动 C 的全闭环回流（I1 知识注入 + I7 处方回写）。

**落地顺序建议 B → C**：B 完成后系统具备"自我评判 + 复盘"能力，此时用真实评分暴露出"哪些场景的必填维最该补"，再用数据驱动 C 的知识回填——**用证据决定填什么，而不是凭空填**。

---

## §9 实施路线图（每 Task 一 commit）

### P0 · 打主干（D 层 + 监控台真实化）

- **T0-1** 迁移：`decision` 加 8 列（`intent/assumptions/inference/viewpoints/implications/risk_register/stop_loss/rubric`），走 `migrate.js` 独立 ALTER 段
- **T0-2** `createDecision` 接入八要素物化（fail-open，留痕不静默）
- **T0-3** 确定性 6 尺子内嵌检查器（纯函数，可单测） + chip 聚合接口
- **T0-4** 监控台 chip 真实化：场景列表接入真实评分聚合，决策详情 7 轴档位真实化
- **T0-5** 测试：迁移幂等 + 物化 + 评分 + 端点 + 空值降级

### P1 · 九尺子内嵌完整化 + 闭环回流 I4

- **T1-1** LLM 3 尺子评分器（配置开关 + degraded 降级）
- **T1-2** 及格线配置化（`config_store['rubric-thresholds']` / `rubric-weights`）
- **T1-3** 复盘 API：`POST /api/decision/:id/retro` → 写 `decision_provenance.entry_type='RETRO'` + 反面先例登记
- **T1-4** 监控台"自检卡"折叠区（七问读模型）+ 决策详情"评分卡"折叠区
- **T1-5** 测试：评分边界 + 降级路径 + 聚合口径 + 复盘触发链

### P2 · 闭环回流 I5/I6 + 知识回填 I1

- **T2-1** 后见之明改写记忆：success / failure 改写 tag（`memory_log.kind='HINDSIGHT_*'`）
- **T2-2** 证实性偏差校验：`POST /api/decision/:id/hindsight-check` → 写 `decision_provenance.entry_type='HINDSIGHT_CHECK'`
- **T2-3** `decision_scenario.required_dims` 回填 12 场景（§4.1 表）
- **T2-4** 场景卡后台编辑（复用配置中心 CONFIG_ITEMS 模式，三处同步）
- **T2-5** `meta_attr` 最小集登记（走 `setMetaAttr()` 正规入口，**绝不在生产库跑全量 seed**）
- **T2-6** 回填后回归：确认 `sevenDimensionsCheck` 在真实数据上触发、B2 七维天花板解锁

### P3 · 学习闭环 I7

- **T3-1** `retroTrigger` 定时接线（夜间批量复盘）
- **T3-2** 处方审批走 `createDecision`（CALIBRATION_CHANGE）经第 0 闸
- **T3-3** `calibration_patch` 落库 → `config_store` 生效 → 知识改变
- **T3-4** 记忆分层 L-User/L-Org 接线
- **T3-5** 闭环验证：一次处方从生成到生效全链路可追溯

### 验收口径

| 指标 | 当前 | P0 后 | P1 后 | P3 后 |
|---|---|---|---|---|
| 八要素完整承载 | 2/8 | 8/8 | 8/8 | 8/8 |
| 九尺子有评分 | 0/9 | 6/9 确定性 | 9/9 | 9/9 |
| 监控台 chip 真实化 | ❌ 演示态 | ✅ chip 真实驱动 | ✅ | ✅ |
| 监控台 7 轴档位真实化 | ❌ 常量展示 | ✅ 真实 | ✅ | ✅ |
| `supplied_dims` 峰值 | 4/7 | 4/7 | 4/7 | 7/7 |
| `decision.outcome` 回写率 | 0/12 | 0/12 | ≥50% | ≥80% |
| 复盘触发链（I4） | ❌ | ❌ | ✅ | ✅ |
| 后见之明改写（I5） | ❌ | ❌ | ❌ 框架 | ✅ |
| 证实性偏差校验（I6） | ❌ | ❌ | ❌ 框架 | ✅ |
| `calibration_patch` | 0 | 0 | 0 | >0 且可追溯 |
| 可审计性健康 | ≤3/4 | ≤3/4 | ≤3/4 | 4/4 可达 |

---

## §10 铁律遵守与风险

### 10.1 项目铁律核对

| 铁律 | 本设计遵守方式 |
|---|---|
| 设计先行，未批准不写代码 | ✅ 本文档即闸门 |
| 零 DELETE | ✅ 评分历史 append-only，历史决策只补录不覆盖 |
| 阈值配置化 | ✅ 九尺子及格线走 `config_store`，不硬编码 |
| 不静默吞错 | ✅ D 层物化与评分失败均 `emit trace` + `recordFailure` |
| 反假绿（BG-04） | ✅ 无证据计 0 分，不填充默认值；演示边不入分母 |
| 迁移：新增列走独立 ALTER | ✅ 明确禁止写进 `CREATE TABLE IF NOT EXISTS` 段 |
| 不在生产库跑全量 seed | ✅ `meta_attr` 走 `setMetaAttr()` 最小范围变更 |
| 写操作经第 0 闸 | ✅ 处方批准走 `createDecision`；复盘/补录/校验均经 HITL |
| UI 零硬编码色值 | ✅ 全走 tokens.css 语义变量 |
| 每 Task 一 commit | ✅ 路线图已按 Task 拆分 |

### 10.2 风险

| 风险 | 等级 | 缓解 |
|---|---|---|
| LLM 评分引入主观性与成本 | 中 | 默认关闭；确定性 6 项先上；LLM 项标 degraded |
| 12 场景必填维若由 AI 编造，会污染判定 | **高** | P2 的必填维初值需业务确认；先全设 `warn` 不阻断 |
| 迁移影响生产库 | 中 | 独立 `ADD COLUMN IF NOT EXISTS`，幂等；先在 `crm_native_test` 验证 |
| 九尺子分值与现有 audit-4q 口径冲突 | 低 | 两者正交：audit-4q 管可审计性，rubric 管思维质量 |
| 监控台页面膨胀 | 低 | 折叠区模式，不新增页面；复用既有 dnRender 弹窗 |
| 闭环回流 I5/I6 写入量大 | 中 | append-only + 批量；每决策最多 3 条 provenance |

---

## §11 选型决策（2026-09-02 用户授权 AI 自决 + 本轮用户明确）

| # | 问题 | 决策 | 生效方式 |
|---|---|---|---|
| Q1 | 12 场景 `required_dims` 初值 | **AI 按语义预设 + 用户事后复核** | 存储位置 = **`decision_scenario.required_dims` 列本身**（单一事实源），初值由《销售自检》七阶段聚焦矩阵推导，详见 `2026-09-02-sales-decision-selfcheck-instantiation.md` §4。`on_missing` 仍先全设 `warn` 不阻断 |
| Q2 | 视角（八要素 7）是否单独建列 | **单独 `viewpoints` 列** | D 层实为 **8 列**：`intent / assumptions / inference / viewpoints / implications / risk_register / stop_loss / rubric` |
| Q3 | LLM 评分默认开关 | **默认关** | P1 阶段确定性 6 项先跑，LLM 3 项标 N/A；开关存 `config_store['rubric-llm']` |
| Q4 | 空表 `decision_rule` / `policy_version` / `assertions` | **按「待填」处理，不在本轮判定废弃** | P2 阶段与 required_dims 一并回填；若最终确认废弃，需显式标 deprecated |
| Q5 | 方案 A / B / C | **方案 B（三层完整 + 九尺子内嵌 + I4 复盘）** | 完成后用真实评分数据驱动 C 的全闭环回流 |
| **Q6** | **三层 K-M-D 还是五层 K-M-T-J-R** | **三层 K-M-D** | **本轮用户明确**：T 并入 D 作为八要素内涵；R 并入 D 作为九尺子内嵌检查 |
| **Q7** | **九尺子独立视图 vs 内嵌决策** | **内嵌到 D 决策过程** | **本轮用户明确**：产物是错误归因 chip，落到场景列表与决策详情（截图样式） |
| **Q8** | **是否新增闭环回流三条腿** | **新增 I4 复盘 / I5 后见之明 / I6 证实性偏差** | **本轮用户明确**："决策反过来改写记忆与知识"——成功强化原记忆、失败改写场景记忆、复盘生成新知识 |

> 决策依据（用户长期偏好）：被追问时倾向不再澄清细节，直接让模型自行决策；技术选型 AI 自决。
> 上述任一项可随时推翻，推翻后需回到本文档改决策行再进实施。

---

## §12 领域实例化（2026-09-02 增补）

用户追加提供《2B销售全流程决策自检框架》，补齐了本设计缺的**领域语义层**。独立文档：
**`docs/2026-09-02-sales-decision-selfcheck-instantiation.md`**

### v2 三项同步修订

1. **T 层词全部改为 D 层**：文档内所有"思维层 T"、"T 层 5 列"、"T 层物化"等统一改为"D 层决策"、"D 层 8 列"、"D 层物化"。八要素是 D 决策的内涵，不是独立层（用户本轮明确）。
2. **九尺子从"独立 R 层"改为"内嵌 D 决策过程"**：九尺子不另起视图，产物是错误归因 chip（用户本轮明确）。截图样式作为 UI 落地点。
3. **新增第三条腿「闭环回流」**：在原 I6 学习回写之上补充 I4 复盘（已设计但未触发）、I5 后见之明改写记忆、I6 证实性偏差校验（用户本轮明确："决策反过来改写记忆与知识"）。

### 五项对本设计的领域补充

1. **阶段化加权**（新增）：文档为每个 2B 销售阶段指定 2–4 个聚焦要素与 2–4 把聚焦尺子 → 九尺子**不再平权**，改为「基础项（信息/推论，全阶段）×1.0 + 阶段重点项 ×1.5 + 其余 ×1.0」。权重与及格线走 `config_store`。
2. **`required_dims` 初值与存储**（修订 Q1）：由七阶段聚焦矩阵推导出 8 个业务场景的必填维，存回 `decision_scenario.required_dims` 列本身（非 config_store）。
3. **D 层从 5 列扩到 8 列**（修订 Q2）：新增 `risk_register`（风险清单）、`stop_loss`（止损条件）、`rubric`（评分物化）——前两者来自文档第四部分「决策三件套」，其中 `stop_loss` 填补了 `QUOTE_PRICING`/`SIGN_RISK` 已挂 `STOP_LOSS` 方法论却无字段承载的空洞。
4. **极简自检卡 7 问 → 读模型**：不新增列，做成 `GET /api/decision/:id/selfcheck` 读模型，复用现有字段。
5. **复盘闭环接上游 I4**：决策 outcome → provenance RETRO → 错误假设自动登记反面先例 → 公平性尺子引用反面证据。

### 顺带照出的 P0 真缺陷（已修复）

`src/action/seed-actions.js` 的 `STAGE_SCENARIO` 自 S3 起整体错位一格且缺 S8 键，导致方案阶段决策被记成报价决策、丢单决策退回机会评估。详见领域实例化文档 §2.3。

---

**HARD-GATE：以上为设计稿，未获批准前不写任何实现代码。**
> 例外：`STAGE_SCENARIO` 错位修复属 bug 修复，已完成并通过回归（47/47）。