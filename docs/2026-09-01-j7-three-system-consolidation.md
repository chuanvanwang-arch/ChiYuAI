# J7 决策七轴 × 三系统（K/M/J）统一设计

> 配套文档：`2026-09-01-top-architecture-three-systems.md`（三系统纵切）、`2026-09-01-story-graph-fusion-design.md`（融合机制）、`2026-09-01-traceability-three-systems-design.md`（Semantica 4 阶段追溯）、`2026-09-01-bug-verdict-and-tetrad-7dims-7edges-mapping.md`（四元组/七维/七边辨析）。  
> 本篇为**术语与依赖关系的唯一收口**：把"知识系统 / 记忆系统 / 决策系统"与既有代码命名 **K / M / J** 对齐，给出"一追到底"的三条对象链。



---

## §0 结论（先给答案）

你的理解**总体正确**，且与代码库既有命名体系**完全一致**——`src/decision/edgeDimensionSpec.js:1-3` 已经写明：

```
命名体系：K 知识系统 / M 记忆系统（L1–L7 维度 + E1–E7 边）/ J 决策脊柱
```

三处精炼（非纠错，是补边界，避免"追到底"断链）：

| # | 你的表述                    | 精炼为                                                                                                         | 依据                                                                                                                     |
| - | ----------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 1 | 七维+七边=记忆系统，建上下文图谱+叙事时间线 | **七维(L1–L7) 与 七边(E1–E7) 都归 M（记忆系统）**，按代码约定；**上下文图谱 = 七边 over 七维实体**；**叙事时间线 = M 的 WHEN 轴装配件，被 J 消费**（自身不存储） | `edgeDimensionSpec.js:6` DIMENSIONS、`edgeDimensionSpec.js:17` EDGES；`insightService.js:244` `loadTimelineSources` 只读派生 |
| 2 | 七维/七边依赖知识系统（身份↔XXX）     | **知识系统(K) = 粒子图，已存在**（`crm.particles` + `stable_key`）；身份(七维之一)↔粒子 `stable_key`，不重造知识图谱                      | `mintId.js:36/42/59`；`constants.js:5-13`                                                                               |
| 3 | J7=决策系统七轴               | **J7 = 决策脊柱 J**，消费 M+K 产出；七问非全强制，按决策类型分级校验                                                                  | `edgeDimensionSpec.js:1-3` 命名；本篇 §4                                                                                    |

依赖链一句话：**K(粒子:有什么) → M(七维分类+七边关系:记得什么/怎么连) → J(七问决策脊柱:决策时回答什么)**。

---

## §1 J7 决策七轴（决策脊柱 J）定义

J7 不是"记忆轴"，是**完整决策必须能回答的 7 个问题**。它对应 `edgeDimensionSpec.js:1-3` 的 **J 决策脊柱**，是决策的"完整性检查表"。

| 轴           | 决策须回答      | 由 M 供给                                                                 | 由 K 供给                                     | 强制级别*     |
| ----------- | ---------- | ---------------------------------------------------------------------- | ------------------------------------------ | --------- |
| **WHAT**    | 决策对象/内容是什么 | M·七维 identity/structure/semantics                                      | `crm.particles`（CRM_ACCOUNT/CONTRACT/DEAL） | 必答        |
| **WHO**     | 谁决策/谁归因    | M·七维 governance + identity 归因                                          | identity 粒子 + `rootCauseClassifier`        | 策略决策可 N/A |
| **HOW**     | 如何执行/机制    | M·七边 CAUSED/INFLUENCED 传播                                              | DSM 阶段、漏斗分区（`funnelQuality`）               | 必答        |
| **BECAUSE** | 依据/理由      | M·七边 REFERENCED_PRECEDENT / DERIVED_FROM_EXCEPTION / ESTABLISHES_FRAME | 决策七边 `decision_relation`                   | 必答（含先例）   |
| **WHEN**    | 何时生效/时序    | M·叙事时间线（WHEN 轴）                                                        | `loadTimelineSources` 四源                   | 时效决策必答    |
| **THEN**    | 结果/后果      | M·七维 operational_state + M·七边 CAUSED 前向                                | 决策边后果 + 预测指标                               | 必答        |
| **WHERE**   | 范围/场景/租户   | 配置 `context-routing.scene_matrix` + 租户/角色                              | 场景路由 + 租户隔离                                | 路由决策必答    |

\* 强制级别由 `validateJ7Completeness(decisionType, record)` 按决策类型分级（见 §4）。

### §1.1 J7 与 Lightfield 四元组的关系

J7 = 四元组 **chronology / attribution / causality / state** 的展开版：

- **chronology** → WHEN（时序）
- **attribution** → WHO（归因）
- **causality** → HOW + BECAUSE（机制 + 理由）
- **state** → WHAT（决策前态）+ THEN（决策后态）

外加 **WHERE（范围）** 是四元组未显式覆盖的"作用域"维度，本平台用租户/场景/角色承载。所以 J7 不是新本体，是**四元组 + 作用域 + 前/后态拆分**的可用化。

---

## §2 七维（M·内容分类）与知识系统(K)的依赖映射

七维即 Oleg 七维度（`src/sevenDimensions/constants.js:5-13`、`edgeDimensionSpec.js:7 DIMENSIONS`），是**记忆系统对"一个实体该记住什么"的分类法**。每一维都依赖 K 的粒子实体落地：

| 七维                          | 含义                 | 依赖的 K 实体/粒子                                            | 当前承载代码                                           |
| --------------------------- | ------------------ | ------------------------------------------------------ | ------------------------------------------------ |
| **identity（身份）**            | 客户/商机跨系统唯一身份一致     | `crm.particles` `stable_key`（CRM_ACCOUNT/CONTACT/DEAL） | `mintId.js:36/42/59` 幂等定址                        |
| **structure（结构）**           | 客户-商机-报价-合同-订单图谱可达 | 粒子关系 `crm.edges` / `decision_relation`                 | `traceRootCause.js:158`                          |
| **semantics（语义）**           | 赢单/丢单/有效商机等术语一致    | `meta_attr` 术语配置                                       | `config_store` 阈值配置                              |
| **time_config（时间与配置）**      | 决策生效时间窗/版本         | `crm.decision.created_at` + `config_store`             | `decisionRepo.js`                                |
| **decision_history（决策历史）**  | 历史否决/先例被检索         | `crm.decision` + `crm.decision_relation`               | `assembler.js:72` `SELECT ... FROM crm.decision` |
| **operational_state（运行状态）** | 当前销售运行态            | `crm.particles.state` + `agent_health`                 | `assembler.js:82`                                |
| **governance（治理）**          | 谁可批/谁负责/边界         | `rbac_roles` + `config_store`                          | `injector.js:5-9`                                |

> **关键**：`identity` 这一维就是"知识系统↔记忆系统"的接口——K 用 `stable_key` 定址实体，M 用 `identity` 维引用它。两者通过 `stable_key` 一追到底（见 §6 示例一）。

---

## §3 七边（M·关系图）与决策依据

七边即 `edgeDimensionSpec.js:18-26 EDGES`（E1–E7），是**决策之间的关系谓词**，构成上下文图谱的"边"。每条边服务若干七维（`edgeDimensionSpec.js:30-38`）：

| 七边                         | 中文    | 含义       | 服务的七维                        | 当前落地                                                  | 缺口          |
| -------------------------- | ----- | -------- | ---------------------------- | ----------------------------------------------------- | ----------- |
| **DECIDED_ON**             | 针对    | 决策作用于某实体 | identity, structure          | `decisionRepo.js:106` **仅 AGE 写 PG**（FK 拒收其它实体，BG-03） | 结构/商机类决策边丢失 |
| **REFERENCED_PRECEDENT**   | 参考先例  | 引用历史先例   | decision_history             | `decisionRepo.js:143/157` **已双写权威表**                  | —           |
| **DERIVED_FROM_EXCEPTION** | 由异常触发 | 告警升级     | operational_state            | `decisionRepo.js` trackEntry 已落 PROV-O                | —           |
| **ESTABLISHES_FRAME**      | 确立标杆  | 新判定框架    | semantics, governance        | 部分落地                                                  | —           |
| **OVERRIDES**              | 推翻翻案  | 覆盖本决策    | governance, decision_history | `decisionRepo.js:307` **漏接权威表**                       | 翻案边不可追      |
| **CAUSED**                 | 直接引发  | 引发下游     | time_config                  | 部分落地                                                  | —           |
| **INFLUENCED**             | 间接影响  | 弱影响      | time_config                  | 部分落地                                                  | —           |

> **上下文图谱 = 七边(E1–E7) over 七维实体(L1–L7)**。它既是 M 的产出，也是 J 脊柱 BECAUSE/THEN 轴的供给源。BG-03/BG-05 的根因（FK 结构 + 装弹含 identity 致 DECIDED_ON 写不进）直接削弱此图的可追溯性。

---

## §4 J7 完整性校验（落地接口草稿，待 writing-plans 批准）

```js
// src/decision/j7Spec.js（建议新增）
// 决策类型 → 必答 J7 轴 映射（配置化，不硬编码；覆盖 config_store['j7-required']）
const J7_BY_DECISION_TYPE = {
  pricing:        ['WHAT','WHO','BECAUSE','THEN'],      // 折扣：需人/依据/后果
  routing:        ['WHAT','WHERE','HOW'],               // 路由：需范围/机制
  strategy:       ['WHAT','HOW','BECAUSE','THEN'],      // 策略：WHO/WHERE 可 N/A
  retrospective:  ['WHAT','WHEN','BECAUSE','THEN'],     // 复盘：需时序
};

export function validateJ7Completeness(type, record) {
  const required = J7_BY_DECISION_TYPE[type] || Object.keys(J7_BY_DECISION_TYPE.pricing);
  const missing = required.filter((axis) => !hasAxis(record, axis));
  return { ok: missing.length === 0, missing, type };
}
```

设计约束：映射表走 `config_store['j7-required']`（遵循 `configCenter.js:33` 禁硬编码铁律）；`hasAxis` 从 `record`（决策+七边+叙事时间线）抽取各轴是否已填。

---

## §5 三层依赖链 K → M → J（一追到底）

```
┌─────────────────────────────────────────────────────────────┐
│ Semantica 横切：Ingestion → Processing → Intelligence → Application │
└─────────────────────────────────────────────────────────────┘
        │ 数据生命周期主轴（任何对象可沿此回追到源）
═══════════════════════════════════════════════════════════════
 K 知识系统（有什么）          M 记忆系统（记得什么/怎么连）        J 决策脊柱（回答什么）
 crm.particles                七维(L1–L7) 分类                     J7 七问
 + stable_key 定址      ──▶   七边(E1–E7) 关系              ──▶   validateJ7Completeness
 │                           上下文图谱 + 叙事时间线(WHEN)        消费 M+K 产出
 │                           │                                   │
 │  identity↔stable_key 接口  │  BECAUSE/THEN 供 J               │  WHO/WHERE 供场景路由
 ▼                            ▼                                   ▼
 写入：req.body+actor    Processing 校验(七维)              Application: prompt 注入 + 路由
```

任意对象用 `(阶段, 系统, 消费层)` 三元组定位，沿 Semantica 主轴回追到 Ingestion 源数据。

---

## §6 三个可追溯示例（file:line 级，一追到底）

### 示例一：事实 / 客户实体（K 系统）

```
prompt 中 "中科曙光" 实体
  ← injector.js:11 formatForPrompt(layers.L1) 输出 "相关知识"
  ← assembler.js:41 retrieveL1(particleType) 按 stable_key 检索
  ← crm.particles.stable_key = 'crm:account:中科曙光'   (K 定址)
  ← Processing：七维 identity 校验（constants.js:6）
  ← Ingestion：POST /api/account 入参 req.body + actor=alice
```

### 示例二：记忆 / 叙事时间线（M 系统 · WHEN 轴）

```
prompt【叙事时间线】块
  ← injector.js（本设计新增 narrative 块，当前缺失=BG-01）
  ← assembler.bundle.narrative（当前未装配=BG-01）
  ← narrative.assembleNarrative(scope)  （派生视图，不写存储）
  ← 四源 SELECT（insightService.js:244-278）：
       crm.events / crm.tasks / crm.decision / crm.memory_log
  ← 各事件 PROV-O（decisionRepo.js:114-128 trackEntry 已落）
```

### 示例三：判断 / 折扣决策（J 系统 · 七问）

```
prompt【图谱上下文·决策】块（BECAUSE/THEN 轴）
  ← injector.js（当前丢弃 rationale=BG-01 实证：assembler.js:72 SELECT rationale 但 injector.js:17-18 只输出 scenario_id:disposition）
  ← assembler.bundle.graph_context.decision_edges
  ← crm.decision_relation（七边 E1–E7）
  ← decisionRepo.js 写边（DECIDED_ON 仅 AGE=BG-03；REFERENCED_PRECEDENT 双写=已修；OVERRIDES 漏接=BG-03）
  ← validateJ7Completeness('pricing', record)  （§4，待落）
  ← Ingestion：POST /api/decision 入参 req.body + actor=alice
```

---

## §7 与既有文档关系 & Q 裁决

| 项                                         | 处置                                       |
| ----------------------------------------- | ---------------------------------------- |
| `story-graph-fusion §1.5` "六轴模型"          | **已改为 J7 决策七轴**（本轮回改）                    |
| `traceability §9` Q1（采纳三维正交架构）            | **采纳**（Semantica×三系统×L1–L4）              |
| `traceability §9` Q2（术语）                  | **统一为 J7**（对齐 K/M/J 命名）                  |
| `traceability §9` Q3（WHERE 归 Application） | **确认**（消费路由层，不与 WHEN 并列记忆层）              |
| `traceability §9` Q4（追溯工程立项）              | 维持 **B：与 BG-06(PROV-O) 合并**（独立任务，用户另行启动） |
| `traceability §9` Q5（追溯浏览器页）              | 维持 **B：暂不需要**（先 API）                     |

---

## §8 落地步骤（writing-plans 待批准，非本轮回写代码）

| Task | 内容                                                       | 文件                                  | 上游依赖           |
| ---- | -------------------------------------------------------- | ----------------------------------- | -------------- |
| T1   | J7 常量 + `validateJ7Completeness`                         | `src/decision/j7Spec.js`（新增）        | 无              |
| T2   | identity↔particle `stable_key` 强制映射校验                    | `mintId.js` + `meta_attr`           | 无              |
| T3   | `/api/trace/:type/:id` 追溯 API（复用 `loadTimelineSources`）  | `src/http/routes.js` + `src/trace/` | T1             |
| T4   | 修 BG-01：叙事时间线(WHEN) + rationale(BECAUSE) 接 `injector.js` | `src/context/injector.js`           | BG-01 设计       |
| T5   | 修 BG-03：DECIDED_ON 实体类扩展 + OVERRIDES 接权威表                | `decisionRepo.js` + `schema.sql`    | BG-03 设计（独立任务） |

> 铁律：以上 T1–T5 属实现代码，须经 **brainstorming→writing-plans→实现** 闸门；本回仅完成术语收口与接口草稿，未写实现代码。

---

## §9 风险与边界

1. **J7 非全强制**：WHERE/WHO 对纯策略决策 N/A，`validateJ7Completeness` 按类型分级，避免误报。
2. **不重造知识图谱**：K 已存在为粒子系统（`crm.particles`+`stable_key`）；强化 identity↔stable_key 映射即可，勿新建图存储。
3. **叙事时间线是派生视图**：（`loadTimelineSources` 只读）不是记忆资产；可存储、可版本化的是"叙事合成洞察"（AI 周期总结，归 `memory_log`/`note`，带 `superseded_by`）。两者勿混淆。
4. **BG 系列仍独立**：T4/T5 与 `2026-09-01-bugfix-design.md` 的 BG-01/BG-03 同源，用户已另启任务，本回不越界实现。

---

*文档未提交 git（沙箱无凭证铁律），由用户本地 commit。本回改动：新增本篇 + 回改 `story-graph-fusion §1.5` + 更新 `traceability §9` Q2/Q3 处置。*
