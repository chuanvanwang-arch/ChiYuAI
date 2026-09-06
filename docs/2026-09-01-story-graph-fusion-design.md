# 故事线 × 上下文图谱 融合设计（CRM-ai-native）

> 状态：**设计待批准**（brainstorming P4 → P5 闸门）  
> 依赖文档：`docs/2026-09-01-bug-verdict-and-tetrad-7dims-7edges-mapping.md`（缺陷判定）、`docs/2026-09-01-bugfix-design.md`（8 项缺陷修复，含 BG-01/BG-03/BG-08）、`docs/2026-09-01-top-architecture-three-systems.md`（三系统顶层划分）  
> 非目标：不写实现代码、不新增"第四系统"、不改动 10 大 ai-* SKILL 基线、不引入 SPARQL/OWL/SHACL。



---

## §0 结论摘要（先看这）

1. **场景划分用一条规则，不是拍脑袋**：`目标=理解(why/演变) ∨ 事件=混合(含非决策) ∨ 时间敏感(序列/密度/沉默) → 故事线为主`；`目标=验证(审计/事实) ∧ 事件=纯决策 ∧ 时间不敏感 → 上下文图谱为主`；其余两者都要。
2. **融合在 CONTEXT 层（L1–L4 装配器+注入器）完成**，不是二选一。模型拿到的是**三段式上下文束**：`【叙事】`（then 轴）+ `【图谱上下文】`（because 轴，带 provenance，作为锚点事实而非硬约束）+ `【结构化】`（确定性指标）。`method-fact-vs-script` 升为叙事权重规则（事实稳、话术可被覆盖）。
3. **架构不需要重新设计**，只做**三处定向调整**，全部落在已有的三系统模型内：
   - **上下文层（WHEN 轴，关键修正）**：叙事时间线本质是**跨系统读取时派生视图**（`insightService.js:244 loadTimelineSources` 读 `crm.events`/`tasks`/`decision`/`memory_log` 四源、`buildTimelineRows` 只读不写），应作为**上下文层 WHEN 轴**直接装配（新增 `src/context/narrative.js assembleNarrative(scope)`），**不提升为记忆系统存储资产**；它与 `narrative`/`graph_context`/`structured` 三块束一起由 `assembler` 产出、`injector` 三段式注入（修复 BG-01）。
   - **上下文层（L1–L4）**：`assembler.js` 产出三块束、`injector.js:11-18` 改为三段式格式（修复 BG-01）；场景→轨道画像由 `config_store['context-routing']` 配置驱动（代码仅 `src/context/routing.js` 加载+回退，见 §1.4），**不硬编码**。
   - **写入横切（Semantica 启发）**：补冲突检测+实体合并（`src/pipeline/conflict.js`），根除 BG-04 假绿根因。
   - 知识系统（实体图 `crm.edges`）+ 决策系统（决策因果图）**不搬迁**，只被检索消费。

---

## §1 场景分类：哪些走故事线、哪些走上下文图谱

### §1.1 理论 backbone：事实/解释二分 + because/then

前几轮已论证（见 `bug-verdict...md` §2.5b）：**边是因果谓词，时间是坐标系**。这给出干净的划分轴：

| 轴  | 故事线承载                                                             | 上下文图谱承载                              |
| -- | ----------------------------------------------------------------- | ------------------------------------ |
| 语义 | **解释**（随对话演变：客户为何犹豫、CISO 立场反转、话术与事实冲突）                            | **事实**（不随对话变：谁签了什么、A 推翻 B、MANT、漏斗分区） |
| 时间 | **then**（全序时间轴、事件密度、沉默期）                                          | **because**（决策间偏序、先例链、翻案链）           |
| 粒度 | 混合事件（events/tasks/memory_log 3/4 非决策，`insightService.js:244-278`） | 决策↔决策 / 实体↔实体                        |

> Lightfield 实验结论（"graphs really got in the way"）只否证了**把解释硬写成图**——本设计不这么做，图只载事实，解释交给叙事。这正是"融合"而非"选边"。

### §1.2 分类判定算法（初始启发式 + 数据驱动）

> **诚实评估**：下面三分支是**初始启发式**，逻辑自洽但维度集（goal / event_mix / time_sensitivity）是我据本平台功能**拍脑袋定的封闭集**，粒度偏粗（goal 枚举、event/time 二元），且未经真实场景数据校准。它适合作为**出厂默认**，但**必须可演进**——这正是本节改写为配置化的原因（见 §1.4）。算法骨架保留在代码（`classifyScene`），但**输入维度集与场景取值全部来自配置**，不直接写死。

```
classifyScene(sceneId, sceneMatrix, dimDefs, thresholds):
  scene  = sceneMatrix[sceneId]                    # 配置：该场景各维度取值 + track 权重
  score  = Σ dimDefs[d].weight * mapValue(scene.dims[d], dimDefs[d].scale)
  if score >= thresholds.graph:  return GRAPH_PRIMARY
  if score <= thresholds.story:  return STORY_PRIMARY
  return BOTH
```

- `dimDefs`：判定维度定义（**配置，可增补**）——每维含 `{id, type, scale, weight}`。
- `sceneMatrix`：场景→维度取值 + `track_weights`（**配置，可增删改**）。
- `thresholds.graph / thresholds.story`：路由边界（**配置**，仿 `sales-thresholds`），不硬编码。
- 旧式 `goal==UNDERSTAND ...` 三分支等价于 `dimDefs` 仅含 3 个布尔/枚举维、阈值取中点的特例；配置化后该特例由 seed 默认矩阵还原，算法无需改。


### §1.3 本平台场景矩阵（逐项归位）

| #  | 场景（现模块/路由）                                             | 主载体     | 次载体     | 判定依据                                          |
| -- | ------------------------------------------------------ | ------- | ------- | --------------------------------------------- |
| 1  | 客户 360 洞察 `account-insight.html` / `insightService.js` | **故事线** | 图谱+结构化  | 理解全貌+混合事件+时间敏感 → BOTH（叙事为主）                   |
| 2  | 销售决策监控 `sales-decision-monitor`                        | **图谱**  | —       | 合规/审计 + 纯决策 → GRAPH_PRIMARY                   |
| 3  | 会前 Brief（规划中）                                          | **故事线** | 结构化     | "上次聊到哪/现在状态"需时间线 → STORY_PRIMARY              |
| 4  | 交易诊断/复活 `crm-deal-analyze`                             | **故事线** | 图谱      | 停滞归因靠密度；补 IT 联系人靠 `method-role-map` 图谱 → BOTH |
| 5  | 决策复盘 `decision-retrospective`                          | **图谱**  | 故事线(背景) | 因果边为主 → GRAPH_PRIMARY                         |
| 6  | 校准处方 `calibration`                                     | **图谱**  | —       | 证据链+confidence → GRAPH_PRIMARY                |
| 7  | 漏斗/阶段推进 `method-stage-progression`                     | 结构化     | 图谱      | 确定性计算（`funnelQuality.js`）→ 结构化为主              |
| 8  | 拜访行为达标 `behavior-standard`                             | 结构化     | —       | 阈值计算 → 结构化                                    |
| 9  | 命名客户跟踪 `named-accounts`                                | **故事线** | 结构化     | 进展跟踪靠时间线 → STORY_PRIMARY                      |
| 10 | 智能体派发 `agentLoop`                                      | **图谱**  | —       | 能力/技能映射 → GRAPH_PRIMARY                       |
| 11 | 决策回执（规划中）                                              | **图谱**  | —       | 证据固化 → GRAPH_PRIMARY                          |
| 12 | 停滞归因（规划中）                                              | **故事线** | —       | 沉默期靠时间线 → STORY_PRIMARY                       |

**关键修正（呼应前轮）**：`sales-decision-monitor` 等纯审计场景**不应注入叙事**——这正是当前 `injector.js:18` 只给 `scenario:disposition` 的部分合理性；但 `account-insight` 等**必须**注入叙事，而当前也被同样压扁了（BG-01）。所以修复不是“全量加叙事”，而是**按场景画像差异化注入**。

### §1.3.1 场景矩阵即出厂默认配置（非代码事实）

> §1.3 上表**不是代码里的常量**，而是 `config_store['context-routing'].scene_matrix` 的**出厂默认 seed**（由 `scripts/seed-context-routing.mjs` 写入，仿 `seed-seven-dim.mjs`）。管理员经配置中心可在不碰代码的情况下：调整任一场景的 `track` 权重、修改维度取值、新增场景行。算法 `classifyScene` 对它一视同仁。

---


### §1.4 配置化与可演进性（回答「如何支持持续调整」）

**承载位置**：单一配置键 `config_store['context-routing']`，三个子键：

| 子键             | 内容                 | 形态示例                                                                                                                                                                                          |
| -------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dims`         | 判定维度定义（可增补）        | `[{id:'goal',type:'enum',scale:['verify','understand'],weight:0.4}, {id:'event_mix',type:'enum',scale:['pure_decision','mixed'],weight:0.3}, {id:'time_sensitivity',type:'bool',weight:0.3}]` |
| `scene_matrix` | 场景→维度取值 + track 权重 | `{'account-insight':{dims:{goal:'understand',event_mix:'mixed',time_sensitivity:true}, tracks:['narrative','graph_decision','graph_entity','structured']}, ...}`                              |
| `thresholds`   | 路由边界               | `{graph:0.6, story:0.4}`                                                                                                                                                                      |

**读写路径（复用平台既有范式，零新基础设施）**：

- 读：`const cfg = (await readConfig('context-routing',{tenantId:'system'}).catch(()=>null))?.value || DEFAULT_ROUTING;`（`src/context/routing.js`），仿 `agentLoop.js:37` / `contractMonitor.js:61`。
- 写：配置中心新增一项（建议 id 35，「故事线/图谱路由配置」，`endpoint /api/config/context-routing`，写经决策第0闸 + sysadmin），仿 `configCenter.js:8-38` 与 `sales-thresholds`（`configCenter.js:34`）。
- 代码只保留：`src/context/routing.js` = `loadRouting()`（读配置+回退默认）+ `classifyScene()`（加权聚合）+ `resolveTracks(sceneId)`（取该场景 `tracks` 列表）。**不含任何场景名或维度名的硬编码常量**。

**持续调整的四类操作（均不碰代码）**：

| 操作            | 怎么改                                                         | 算法是否动                                     |
| ------------- | ----------------------------------------------------------- | ----------------------------------------- |
| ① 增补判定维度      | `dims` 加一条 `{id,type,scale,weight}`；`scene_matrix` 各场景补该维取值 | **零改动**——`classifyScene` 遍历 `dims` 自动纳入加权 |
| ② 调整某场景分类     | 改 `scene_matrix[sceneId].tracks` 或某维取值                      | 零改动                                       |
| ③ 新增场景        | `scene_matrix` 加一行                                          | 零改动                                       |
| ④ 算法升级（加权→ML） | 替换 `classifyScene` 实现                                       | 输入输出契约不变，仅此函数变                            |

**兜底与安全**：

- 配置缺失 / 维度不全 / 场景不在矩阵 → 回退 `tracks = ['narrative','graph_decision','graph_entity','structured']`（即 BOTH 全轨，安全默认），不抛错、不中断装配。
- 配置保存时做**一致性自检**：场景引用的维度必须全部已在 `dims` 定义（仿 BG-05a `WRITABLE_EDGES` 自检思路），否则拒绝并返回可读提示——避免「引用了未定义维度」的静默误路由。
- **算法核心逻辑与三段式束格式不可配置**：配置化只覆盖「路由决策」（哪个场景走什么轨道），不把 `bundle` 结构或 `injector` 三段式模板暴露给配置——过度配置会侵蚀可观测性。

**与平台铁律呼应**：`configCenter.js:33` 明确「业务数值不得硬编码」，路由矩阵属于同类「业务判定」，原 T5 的 `profiles.js` 硬编码**已修正为本节配置化**；出厂默认仍由 seed 提供（SKILL/seed 承载建议值，管理员可改），与 `sales-thresholds` 完全一致。

"全量加叙事"，而是**按场景画像差异化注入**。

---

## §2 融合机制：三段式上下文束

### §1.5 J7 决策七轴（决策脊柱 J）：完整决策必须回答的 7 个问题

用户指出本平台已有 WHAT / HOW / WHO / BECAUSE / THEN 五条语义轴，补齐 **WHEN（时序）** 与 **WHERE（范围/场景）** 后共七条。这七条**不是记忆轴，而是决策脊柱 J（J7）**——即"要决策一件事，必须能回答哪 7 个问题"，对应 `src/decision/edgeDimensionSpec.js:1-3` 既有命名体系 **K 知识系统 / M 记忆系统 / J 决策脊柱** 中的 **J**。叙事时间线（WHEN）与上下文图谱（BECAUSE/THEN）是 **M 系统产出、被 J 脊柱消费**的装配件（见 §3.1 与统一设计文档 `docs/2026-09-01-j7-three-system-consolidation.md`）。

| 轴(J7) | 决策须回答 | 由 M 的哪部分供给 | 当前承载 | 上下文层装配位置 |
| -- | ---- | ------ | ----- | ------------ |
| **WHAT** | 决策对象/内容是什么 | M·七维 identity/structure/semantics | `crm.particles`（CRM_ACCOUNT/CONTRACT/DEAL） | L1 知识底座 |
| **WHO** | 谁决策/谁归因 | M·七维 governance + identity 归因 | identity 粒子 + `rootCauseClassifier` | L1/L2 |
| **HOW** | 如何执行/机制 | M·七边 CAUSED/INFLUENCED 传播 | DSM 阶段、漏斗分区、`funnelQuality` | L1 |
| **BECAUSE** | 依据/理由 | M·七边 REFERENCED_PRECEDENT/DERIVED_FROM_EXCEPTION/ESTABLISHES_FRAME | 决策七边 `decision_relation` + 实体图 `crm.edges` | `graph_context` 块 |
| **WHEN** | 何时生效/时序 | M·叙事时间线（WHEN 轴装配） | **叙事时间线（`loadTimelineSources` 四源派生）** | `narrative` 块 |
| **THEN** | 结果/后果 | M·七维 operational_state + M·七边 CAUSED 前向 | 决策边后果 + 结构化预测指标 | `graph_context`+`structured` 块 |
| **WHERE** | 范围/场景/租户 | 配置 `context-routing.scene_matrix` + 租户/角色 | 场景路由 + 租户隔离 | Application 阶段消费路由 |

> 关键澄清（2026-09-01 收口）：① J7 是**决策脊柱**，不是记忆轴；它消费 M(七维+七边) 与 K(粒子) 的产出，自身不存储。② WHEN 与 THEN 互补不重合（WHEN=何时发生，THEN=导致什么）。③ 旧称"六轴模型"已废弃，统一为 **J7**；WHERE 不与 WHEN 并列记忆层，而归 Application 阶段消费路由。④ 并非每类决策都强制 7 问全答——WHERE/WHO 对纯策略决策可能 N/A；J7 是"完整性理想"，由 `validateJ7Completeness()` 按决策类型分级校验（见统一设计文档 §4）。

---

### §2.1 装配产物（bundle 形状）

`assembler.js` 在现有 `layers{L1..L4}` 之外，新增三个**语义块**（互不替代）：

```js
bundle = {
  layers: { L1..L4 },              // 保留：知识底座/决策/执行态/角色（现有）
  narrative: NarrativeBlock,       // 新增：来自上下文层 src/context/narrative.js assembleNarrative(scope)（WHEN 轴，消费三系统源）
  graph_context: GraphContextBlock,// 新增：decision_relation + crm.edges（带 provenance）
  structured: StructuredBlock,      // 新增：MANT/漏斗/阈值（确定性计算）
  degraded, missing, scopeModel
}
```

- `NarrativeBlock`：`{ entries: [{ts, actor, source, summary, superseded_by?}], scope }`，全序、带版本化。
- `GraphContextBlock`：`{ decision_edges: [...], entity_edges: [...], provenance: {src, rule, decision_id} }`，**作为锚点事实呈现，不强制约束**。
- `StructuredBlock`：`{ mant, funnel_stage, thresholds_hit }`，确定性。

### §2.2 注入格式（修复 BG-01，`injector.js:11-18` → 三段式）

```js
// 替换现有 11-18 行
if (bundle.narrative?.entries?.length)
  parts.push(`【叙事时间线】\n` + bundle.narrative.entries
    .map(e => `- ${e.ts} ${e.actor}: ${e.summary}${e.superseded_by ? ' (已被后续覆盖)' : ''}`)
    .join('\n'));
if (bundle.graph_context?.decision_edges?.length)
  parts.push(`【图谱上下文·决策】\n` + bundle.graph_context.decision_edges
    .map(e => `- ${e.rel_type}: ${e.from}→${e.to} (来源:${e.provenance.src})`).join('\n'));
if (bundle.structured) parts.push(`【结构化指标】...`);
```

模型据此**跨三段推理**：叙事给"然后"、图谱给"因为"、结构化给"刻度"。

### §2.3 权重规则：`method-fact-vs-script` 升为叙事权重

`method-fact-vs-script`（识别事实条目稳定、话术条目可被覆盖）直接复用为权重规则：

- 来自 `graph_context`/`structured` 的**事实** → 高权重、持久；
- 来自 `narrative` 的**解释/话术** → 中权重、**可被后续事实覆盖**（而非删除，靠 `superseded_by`）。

这把 Lightfield 的"动态重加权"做成**可解释规则**而非黑箱，且复用既有 SKILL。

### §2.4 双轨版本化（不可删、可覆盖）

| 载体   | 版本化字段                 | 来源                                             |
| ---- | --------------------- | ---------------------------------------------- |
| 合成叙事洞察（记忆系统 curated note） | `superseded_by` | 记忆系统 `src/memory/note.js`，复用 `decision_provenance` 模式；**原始时间线条目是派生视图，不加版本化字段** |
| 决策边  | `valid_from/valid_to` | 与 BG-03 结构扩容（`bugfix-design.md` §7）合并窗口        |

> 前轮已证：七边承载不了 chronology（偏序≠全序、无密度、粒度错配）。版本化让"图"有了时间有效性，"叙事"有了可追溯性——两者互补，缺一不可。

### §2.5 场景上下文画像（差异化注入，配置驱动）

场景→轨道画像**不再硬编码为代码常量**，改为 `src/context/routing.js` 从 `config_store['context-routing'].scene_matrix` 读取（§1.4）。代码只保留加载与回退：

```js
// src/context/routing.js —— 仅加载+回退，无场景名/维度名硬编码
import { readConfig } from '../config/configStore.js';
const DEFAULT = { tracks:['narrative','graph_decision','graph_entity','structured'], L:['L1','L2','L3','L4'] };

export async function resolveTracks(sceneId) {
  const cfg = (await readConfig('context-routing',{tenantId:'system'}).catch(()=>null))?.value;
  const row = cfg?.scene_matrix?.[sceneId];
  return {
    tracks: row?.tracks ?? DEFAULT.tracks,   // 缺失→全轨安全默认
    L:      row?.L      ?? DEFAULT.L,
  };
}
```

`assembler.js` 据 `intent.scenario` 调 `resolveTracks()` 选轨；配置缺失某场景时回退全轨，不报错（§1.4 兜底）。

---

## §3 架构调整：不重设计，三处定向调整

### §3.1 与三系统模型的关系（承接 `top-architecture-three-systems.md`）

```
                ┌──────────────── 三系统（纵切·对象性质）────────────────┐
   知识系统      │ 粒子图 crm.edges / 本体 / 蓝图 / agent 注册 / 配置      │
   记忆系统      │ 双轨 + 三层 + 蒸馏 + 【叙事源 memory_log/events + 合成洞察 note】 │
   决策系统      │ 决策事件 + 七边 + 复盘根因 + 治理闸门                   │
                └────────────────────────────────────────────────────────┘
        ▲ 消费横切 L1–L4（assembler+injector，三段式束）   ▲ 写入横切（Semantica：冲突/合并）
```

- 故事线（WHEN 轴）→ **上下文层装配**（新增 `src/context/narrative.js`），消费记忆系统（memory_log/events）+ 决策系统（decision）+ 事件系统的源；**不是记忆系统存储资产**（时间线只读不写，是派生视图）。
- 记忆系统 → 保留叙事的**源**与**合成洞察**（curated note，带 `superseded_by`），供 WHEN 轴装配消费。
- 上下文图谱 → **横跨知识系统（实体图）+ 决策系统（因果图）**，不在第三系统。
- 融合点 → **上下文层（L1–L4）**，新增三块束（含 WHEN 轴）+ 场景画像。


### §3.2 调整清单（file:line 精确）

| 序号 | 类型 | 文件                                                                                                | 改动                                                                                                            | 对应缺口            |
| -- | -- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------- |
| A1 | 新增 | `src/context/narrative.js`                                                                         | 从 `insightService.js:105 buildTimelineRows` 提升；加 `superseded_by` 版本化 + 源事件 id；导出 `assembleNarrative(scope)`      | 叙事未进上下文层（BG-01 实质） |
| A2 | 改  | `src/account/insightService.js`                                                                   | `buildTimelineRows` 标记 deprecated，改调 `narrative.assembleNarrative`                                               | A1 收口           |
| A3 | 改  | `src/context/assembler.js`                                                                        | 在 `layers` 外新增 `narrative`/`graph_context`/`structured` 三块（现有 `:72` 已 SELECT rationale、`:76` 取 memories，接上即可） | BG-01           |
| A4 | 改  | `src/context/injector.js:11-18`                                                                   | 改为三段式格式（§2.2）                                                                                                 | BG-01           |
| A5 | 新增 | `src/context/routing.js` + `config_store['context-routing']` + `scripts/seed-context-routing.mjs` | 路由加载+回退（§2.5/§1.4）；seed 写出厂默认 `dims`/`scene_matrix`/`thresholds`；配置中心新增 id 35                                 | 差异化注入（配置化，禁硬编码） |
| A6 | 改  | `src/context/assembler.js`                                                                        | 接入 `routing.resolveTracks(intent.scenario)` 选轨；并接 `configCenter.js` 新增 id 35 的写路径依赖                           | A5              |
| A7 | 新增 | `src/pipeline/conflict.js`                                                                        | 写入前冲突检测+实体合并（Semantica 启发），拦截重复决策/边                                                                           | BG-04 根因        |
| A8 | 改  | `src/decision/decisionRepo.js`                                                                    | 写入决策/边前调用 A7 的 conflict 检查                                                                                    | BG-04           |

### §3.3 不调整项（明确边界）

- 10 大 ai-* SKILL 基线：不变。
- L1–L4 作为消费横切概念：不变，仅扩展束内容。
- Oleg 七维作为齐全性校验：不变（仍按场景归属三系统，见 `top-architecture` §5）。
- 七决策边作为证据学横切：不变（BG-02/03/05 修复后归位）。
- 知识系统实体图 `crm.edges`、决策系统 AGE+PG 因果图：不搬迁，仅被 A3 检索消费。
- BG-03 结构扩容（`decision_entity_relation` 或 `to_type`）、BG-08 时间基准统一：沿用 `bugfix-design.md`，本设计不重复，仅标注依赖。

### §3.4 依赖与顺序

```
D4 接线（bugfix 上游依赖，另立项）
   └─→ A3/A4 注入层修复（BG-01）       ← 叙事/图谱进模型的前提
BG-03 结构扩容（bugfix）               ← 图谱边可写权威表
   └─→ A7/A8 冲突检测（BG-04 根因）
A1/A2 叙事轴（上下文层 WHN 轴）
   └─→ A3/A5/A6 场景差异化注入
```

**最高 ROI 序**：先 A3+A4（修 BG-01，一个格式串 + 接束，立刻让 account-insight 拿到叙事）→ 再 A1/A2（提升叙事为资产）+ A5/A6（画像）→ 并行 A7/A8（冲突检测）+ BG-03。

---

## §4 落地任务分解（含可监控生命契约）

> 每个任务带 `contract-yaml`（§A）。`agent` 取运行时消费方（注册表 key），实现由 writing-plans 子代理承接。

### §4.1 任务 T1 — 叙事时间线作为上下文层 WHEN 轴（非记忆资产）

```contract-yaml
- task: "叙事时间线提升为上下文层 WHEN 轴（非记忆存储资产）"
  contract_task_id: ct-followup
  agent: followup-agent
  skills: [method-followup-engine, data-particle-read]
  memory: [followup-agent]
  knowledge_scope: { layers: [L1, L2], max_hops: 2 }
  success: "src/context/narrative.js 导出 assembleNarrative(scope) 消费三系统源（events/tasks/decision/memory_log）产出时间序 WHEN 轴；不新建存储表、不加 superseded_by；insightService.buildTimelineRows 标记 @deprecated 并改调之；account-insight 与 named-accounts 经 assembleContext 拿到 WHEN 轴"
```

### §4.2 任务 T2 — 双轨上下文束（assembler 增加 narrative + graph_context）

```contract-yaml
- task: "assembler 产出三段式上下文束"
  contract_task_id: ct-followup
  agent: followup-agent
  skills: [data-particle-read, method-followup-engine]
  memory: [followup-agent]
  knowledge_scope: { layers: [L1, L2], max_hops: 2 }
  success: "assembleContext 返回 bundle.narrative 与 bundle.graph_context（decision_relation+crm.edges 带 provenance）；account-insight 场景两束非空"
```

### §4.3 任务 T3 — 注入器三段式格式化（修复 BG-01）

```contract-yaml
- task: "injector 三段式格式化修复 BG-01"
  contract_task_id: ct-followup
  agent: followup-agent
  skills: [data-particle-read]
  memory: [followup-agent]
  knowledge_scope: { layers: [L2], max_hops: 1 }
  success: "formatForPrompt 输出【叙事时间线】【图谱上下文】【结构化指标】三独立块，不再仅输出 title/scenario:disposition；test/context.test.js 断言三块均存在"
```

### §4.4 任务 T4 — 场景上下文画像 + 差异化注入

```contract-yaml
- task: "场景上下文画像与差异化注入"
  contract_task_id: ct-intake-route
  agent: intake-router
  skills: [method-intake-routing, data-particle-read]
  memory: [intake-router]
  knowledge_scope: { layers: [L1, L2], max_hops: 2 }
  success: "config_store['context-routing'].scene_matrix 落 ≥12 场景出厂默认（sales-decision-monitor 仅 graph+structured、account-insight 全轨）；src/context/routing.js 读配置+缺失回退全轨；assembler 据 intent.scenario 调 resolveTracks 选轨；配置中心 id 35 可改"
```

### §4.5 任务 T5 — 写入横切冲突检测（Semantica 启发，根除 BG-04）

```contract-yaml
- task: "写入横切冲突检测与实体合并"
  contract_task_id: ct-review-gate
  agent: review-gate
  skills: [method-review-gate, data-particle-read]
  memory: [review-gate]
  knowledge_scope: { layers: [L2], max_hops: 1 }
  success: "src/pipeline/conflict.js 在 decisionRepo 写入决策/边前检测重复实体与冲突并留痕；seed 假绿（同决策二次写入未治理）被拦截且 recordFailure 可见"
```

---

## §5 与既有文档的关系

| 文档                                               | 关系                                                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `top-architecture-three-systems.md`              | 本设计是其**细化**：三系统模型不变，故事/图谱融合定位到"上下文层 WHN 轴 + 三块束 + 写入横切补冲突"；记忆系统仅保留叙事源与合成洞察（见 §2.4/§3.1）"
| `bug-verdict-and-tetrad-7dims-7edges-mapping.md` | 提供 §1 理论 backbone（事实/解释二分、because/then、边承载不了 chronology）                                               |
| `bugfix-design.md`                               | 本设计 A3/A4=BG-01、A7/A8=BG-04 根因、A3 依赖 BG-03 结构扩容；BG-08 时间基准统一随 A1 的 `COALESCE(decided_at,created_at)` 做 |

---

## §6 待裁决项（批准前请确认）

| #      | 问题                                                                            | 选项              | 建议                                                                        |
| ------ | ----------------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------- |
| **Q1** | 是否采纳"三系统 + 三段式束 + 写入横切"作为正式融合架构                                               | 采纳 / 仅做注入层修复    | **采纳**——与 `top-architecture` 一致，一次性定位                                     |
| **Q2** | 叙事时间线归属：**上下文层 WHN 轴**（`src/context/narrative.js`，派生视图） 还是 记忆系统存储资产（`src/memory/narrative.js`） | 上下文层轴 / 记忆资产 | **上下文层轴**——`buildTimelineRows` 只读不写、跨 4 系统派生，性质是视图不是资产；记忆系统只保留源（memory_log/events）与合成洞察（curated note，带 superseded_by）                                                  |
| **Q3** | 冲突检测是否独立建 `src/pipeline/`（Semantica 横切）还是并入 `decisionRepo`                    | 独立子目录 / 并入      | **独立**——写入横切是跨系统契约，不应绑死决策                                                 |
| **Q4** | `method-fact-vs-script` 权重规则何时落地                                              | 随 T2/T3 一起 / 后续 | **随 T2/T3**（成本低，且是融合语义的关键一环）                                              |
| **Q5** | D4 智能体接线是否并行裁决                                                                | 是 / 否           | **是**——A3/A4 收益以 SKILL 真调用为前提（见 `bugfix-design` 依赖）                       |
| **Q6** | 场景分类矩阵与判定维度是否采用配置化（`config_store['context-routing']`，§1.4）而非硬编码 `profiles.js` | 配置化 / 硬编码       | **配置化**——平台铁律 `configCenter.js:33` 禁硬编码业务判定，且配置化是「持续调整」的前提（本设计原 T5 已据此修正） |

---

## §7 风险与回退

- **风险 R1**：三段式束拉长 prompt，小模型可能噪声化。→ 回退：`resolveTracks()`（§2.5）按配置裁剪（纯审计场景关叙事，§1.3 已区分）；裁剪规则在 `config_store['context-routing']` 改，不碰代码。
- **风险 R2**：`narrative.js` 提升为上下文层轴后 `insightService` 两处调用遗漏。→ 回退：保留 `buildTimelineRows` 转发一层（@deprecated 改调 `assembleNarrative`），测试断言双路径一致。
- **风险 R3**：冲突检测误伤合法翻案（OVERRIDES）。→ 回退：冲突检查白名单排除 `OVERRIDES`/`REFERENCED_PRECEDENT` 类意图明确的边。

---

## §A 生命契约汇总（机器可校验）

见 §4.1–§4.5 五个 `contract-yaml` 块。字段自检（P7）：每任务含 `agent+skills+memory+success`；`agent ∈ {followup-agent, intake-router, review-gate}`（注册表可解析）；`skill ⊆ agent.skillCalls`（`agentSpec.js` 校验：followup-agent⊇method-followup-engine/data-particle-read；intake-router⊇method-intake-routing/data-particle-read；review-gate⊇method-review-gate/decision-retrospective）；`memory ∈ agent.memory.read`。结构校验：`node scripts/validate-contract.mjs docs/2026-09-01-story-graph-fusion-design.md`。
