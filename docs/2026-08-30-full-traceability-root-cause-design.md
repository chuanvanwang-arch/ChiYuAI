# 全链路溯源与根因归因设计（K/M/J 框架深化）

> 承接 `2026-08-30-decision-quality-closed-loop-redesign.md`（闭环骨架）
> 与 `2026-08-30-j2-j3-comprehensive-design.md`（J2/J3 四维度改造）。
> 本文聚焦两件事：**① 四层全链路溯源（J→M→K→粒子库）**；**② J3 根因归因分类器（含业务反馈 J2 全面采集）**。
> 命名体系：K 知识系统（原 Universal Context L1–L4）/ M 记忆系统（L1–L7 维度 + E1–E7 边）/ J 决策脊柱（J1 上下文图谱 / J2 反馈回路 / J3 校准层）。

---

## §0 现状证据（为什么必须做"深入溯源"）

| 层 | 现状 | 证据 |
|---|---|---|
| **J 脊柱** | `decision.attribution` 仅维度级 + 3 态 category | `attribution.js:14-21`：`required_fill.missing` 只记缺失维度；`category ∈ {ok, input_missing, inference_bias}` |
| **M 记忆** | 7 维有物化；7 边只落 `REFERENCED_PRECEDENT` 1 类，且只有 PG 单类型镜像表 | `schema.sql:191-196` `decision_precedent_rel`；`ageGraph.js` 声明 7 类仅落 3 类 |
| **K 知识** | `crm.particles`（L1 粒子平面，`payload JSONB`+`embedding`+`fts`）+ `crm.edges`（`edge_type` 受控谓词） | `schema.sql:11-45` |
| **粒子库** | 字段语义由 `crm.meta_attr`（粒子属性元模型，`particle_type+attr_slug`）定义 | `schema.sql:322-344` |
| **J3 校准** | `calibration_patch.knob ∈ {threshold, weight, required_dims}`，**无 edge_binding / 无数据质量 knob** | `schema.sql:414`；`store.js:16` `KNOBS` |
| **J2 反馈** | `decision.outcome TEXT` 松散；`outcome_verified` 仅占位；**无"可用/不可用、重大偏差"结构化采集** | `schema.sql:167-168`；`attribution.js:18,40` |

**结论**：当前归因只能回答"维度缺没缺"，**回答不了**"字段不一致 / 信息不完整 / 输入不及时 / 边选错 / 参考先例污染"——而这些正是业务能直接改善的"真正原因"。必须下钻到 M→K→粒子库 做字段级溯源。

---

## §1 四层全链路溯源模型

溯源链：**J 决策脊柱 → M 记忆系统 → K 知识系统 → 粒子库（crm.particles 行）**。每一跳都是可查询、可降级（AGE 挂了不丢）的 PG 事实。

```
J (decision + attribution)
  │  ① 读 attribution.required_fill(L1-L7) + decision_relation(E1-E7)
  ▼
M (记忆系统：七维度物化 + 七边快照 + memory_log)
  │  ② involved_entities → 关联粒子 id 列表
  ▼
K (知识系统：particles + edges 受控谓词图)
  │  ③ 读粒子 payload + 关联边 + effective_policy_version
  ▼
粒子库 (crm.particles 行 + meta_attr 字段定义)
     ④ 字段级 diff：payload 实际字段 vs meta_attr 期望字段
```

### §1.1 各跳的数据与判定

| 跳 | 取数来源 | 可诊断的根因 |
|---|---|---|
| ① J→M | `decision.attribution`、`decision_relation`（T2 落地后） | 维度缺(L) / 边缺(E) → 维度不对 / 边选择不对 |
| ② M→K | `decision.involved_entities`（JSONB 装粒子 id+type） | 决策"针对"的实体是否解析正确（E1 针对） |
| ③ K 内部 | `particles.payload`、`edges`（edge_type） | 图谱关系断裂(L2) / 语义错(L3) |
| ④ K→粒子库 | `particles.payload` × `meta_attr`（`particle_type,attr_slug,enabled`） | **字段不一致 / 信息不完整 / 输入不及时** |

### §1.2 粒子库层三类根因的字段级检测（核心）

新增 `traceRootCause(decisionId)` 后端函数，④ 跳做三检：

| 根因 | 检测逻辑 | 
|---|---|
| **字段不一致** | `particles.payload` 的 key 集合 与 `meta_attr`（该 `particle_type` 且 `enabled=true`）的 `attr_slug` 集合**命名不一致**（如 payload 用 `cust_no` 而 meta 期望 `customer_no`）→ 映射错配 |
| **信息不完整** | `meta_attr` 标记 `required=true` 的 `attr_slug` 在 payload 中**缺失或为空** → 字段空缺 |
| **输入不及时** | `particles.updated_at`（或状态变更事件时间）距 `decision.decided_at` **超过时效阈值**（按 `particle_type` 配置，如商机 24h、报价 1h）→ 数据陈旧 |

> 这三类是**业务最能直接改善**的真原因（"客户主数据字段名不统一""商机阶段没及时回写""报价过期还在用"），必须从 J 一层层追到粒子库字段才看得见。

---

## §2 J2 业务反馈全面采集（决策结果反证）

当前 `outcome` 只是松散 TEXT。需结构化采集"业务侧可用性 + 偏差严重度"，这是 J3 归因的**必要输入之一**。

### §2.1 反馈表单字段

| 字段 | 类型 | 含义 |
|---|---|---|
| `usable` | bool | 决策结果**可用 / 不可用**（业务能否直接采用） |
| `major_deviation` | bool | 是否**重大偏差**（造成业务损失/客户投诉/合规风险） |
| `actual_outcome` | enum | `won` / `lost` / `partial` / `paid` / `none`（原 outcome） |
| `deviation_note` | text | 偏差描述（自由文本，供 A9/NLP 抽取） |
| `reporter_role` | text | 谁反馈（销售/售前/经理），用于权重 |

### §2.2 与既有字段映射

- `usable=false` ∪ `major_deviation=true` → `accuracy_signal='inaccurate'` 且触发**强制归因**（不可跳过 J3）。
- `usable=true` ∪ `actual_outcome='won'` → `accuracy_signal='accurate'`，J3 仅做"正向强化"建议（如提升相关边权重）。
- 仍保留 `human_disposition`（人工推翻/确认）作为即时判，与滞后业务判形成**金律 18 双信号**（即时人工 + 滞后业务）。

### §2.3 采集入口

1. 作战室 L2 区「业务结果回写」卡片（决策→业务结果）；
2. 巡检卡底部「业务可用性」一行；
3. MCP `crm_decision_outcome_set`（外部系统回写，如 CRM 成交回写事件）；
4. 事件总线 `domain='approval'/'payment'` 的**业务结果自动 ingestion**（见 J2 文档 `outcomeIngester.js`）。

---

## §3 J3 根因归因分类器（本文核心）

### §3.1 分类树（优先级自上而下，命中即止）

输入 = { **B**=J2 业务反馈, **A**=M 层 attribution(L+E), **T**=④ 粒子库三检结果 }。

```
R0 若 B.usable=false 且 B.major_deviation=true：
   ├─ 若 T.字段不一致 → 根因=【字段不一致】(FIELD_MISMATCH)
   ├─ 若 T.信息不完整 → 根因=【信息不完整】(INFO_INCOMPLETE)
   ├─ 若 T.输入不及时 → 根因=【输入不及时】(INPUT_STALE)
   ├─ 若 A.L 缺失（维度不齐） → 根因=【维度不对/缺维度】(DIM_MISSING)
   ├─ 若 A.E 缺失（应有边未连） → 根因=【边选择不对】(EDGE_MISSING)
   └─ 否则（L+E 都齐但仍重大偏差）→ 根因=【数据质量·参考先例/标杆】(DATA_QUALITY_PRECEDENT)
R1 若 B.usable=false 但偏差不重大：
   ├─ 同 R0 子树，但标 severity=minor
   └─ 若 L+E 齐 → 疑似【优化次序/补齐维度】(NEED_DIM_ORDER) 或 推理偶偏
R2 若 B.usable=true：
   ├─ 正向强化：若 A.E 含参考先例且实际 won → 提升该先例 similarity（蒸馏正向）
   └─ 若系统性同类偏差 low → 无需干预
R3 未知 → 标记 UNKNOWN，进人工归因队列（A9 闭环）
```

### §3.2 七类根因 → 修复靶点 → 校准处方(knob)

| # | 根因（中文） | 修复靶点层 | 校准处方 knob（扩展后） | 具体建议方案 |
|---|---|---|---|---|
| 1 | **字段不一致** FIELD_MISMATCH | 粒子库 / meta_attr | `META_ATTR_MAP` | 修正 `meta_attr` 字段映射或写通道字段名，使 payload key 与元模型一致 |
| 2 | **信息不完整** INFO_INCOMPLETE | 粒子库 / K 边 | `PARTICLE_ATTR_ADD` / `K_EDGE_ADD` | 补录粒子缺失必填属性；或补 K 层图谱边（如商机缺"负责人"边） |
| 3 | **输入不及时** INPUT_STALE | 粒子库 / 事件总线 | `SOURCE_REFRESH` / `EVENT_SUBSCRIBE` | 触发源系统刷新或订阅状态变更事件，缩短时效阈值 |
| 4 | **维度不对** DIM_MISSING | M/seven-dim | `REQUIRED_DIMS`（已有） | 调整该场景 `required_dims`，把被漏判的维度纳入必填 |
| 5 | **边选择不对** EDGE_MISSING | M/edge_bindings | `EDGE_BINDING`（新增） | 调整 `edgeDimensionSpec`，让该决策应连的 E 边被强制写出 |
| 6 | **优化次序/补齐维度** NEED_DIM_ORDER | M/K 配置 | `DIM_ORDER` / `REQUIRED_DIMS` | 重排维度评估次序，或补一个此前未建的维度/边 |
| 7 | **数据质量·参考先例/标杆** DATA_QUALITY_PRECEDENT | K 历史决策 / precedent_rel | `PRECEDENT_DISTILL` | 对造成误导的参考先例/标杆做降权或软标记（禁删，走蒸馏），避免后续决策复用 |

> **关键洞察**：第 7 类正是你说"维度和边都没问题，是数据质量"的情形——L1-L7 全齐、E1-E7 全连，但**连到的参考先例本身被推翻/低质**，污染了本次决策。这是最隐蔽的一类，必须由 `decision_precedent_rel.similarity` + 先例自身的 `outcome_verified` 反查才能发现（见 §3.3）。

### §3.3 第 7 类的检测算法（参考先例污染）

```
对每个 decision d：
  for p in d.referenced_precedents (decision_precedent_rel):
     if p.outcome_verified IN ('REVERSED','lost') OR p.human_disposition IN ('OVERRIDDEN','CORRECTED'):
        pollution_score += p.similarity * weight(p.age)
  if pollution_score > THRESHOLD 且 d.usable=false:
     根因 = DATA_QUALITY_PRECEDENT，建议 = PRECEDENT_DISTILL(对 p 降权)
```
复用既有 `decisionRepo.js:250-257` 的 30 天蒸馏逻辑，扩展为"被推翻先例触发的共性降权"。

---

## §4 建议方案生成（concrete suggestion）

J3 自动建议卡内容结构（供作战室浮卡 + MCP 输出）：

```yaml
root_cause:
  code: DATA_QUALITY_PRECEDENT        # 七类之一
  layer: K                            # J/M/K/粒子库
  severity: major                     # major/minor
  evidence:                           # 可追溯证据链
    - "decision:d123 attribution.L 全齐 / E 全齐"
    - "referenced_precedents=[p88] 且 p88.outcome_verified='REVERSED'"
    - "pollution_score=0.82 > 0.6"
suggestion:
  patch_knob: PRECEDENT_DISTILL
  patch_params: { precedent_id: p88, action: downweight, factor: 0.5 }
  expected_effect: "后续同类决策不再优先引用 p88，预计同类偏差率下降"
  requires_gate: true                 # 经第0闸 produceDecision 写回
```

建议卡支持：一键批准（经第0闸写回 K/M）→「去重跑场景」→ 再监控，闭环可见。

---

## §5 字段属性改造（承接 J2/J3 文档并扩展）

| 对象 | 变更 | 说明 |
|---|---|---|
| `crm.decision` | 新增 `feedback jsonb`（装 §2.1 结构化反馈） | 替代松散 `outcome` 文本；保留 `outcome` 向后兼容 |
| `crm.decision` | 新增 `root_cause jsonb`（装 §3 分类结果：code/layer/severity/evidence） | J3 归因落库，可重查 |
| `crm.decision_relation` | 落地（T2）：`rel_type` enum(E1-E7) + `serves_dimension` + `props` | M 层 7 边权威表 |
| `crm.meta_attr` | 新增 `required bool`、`source_refresh_sla interval` | 支撑 §1.2「信息不完整 / 输入不及时」检测 |
| `crm.particles` | 复用 `updated_at`（已有） | 支撑时效检测 |
| `calibration_patch.knob` | 扩枚举：`+ EDGE_BINDING + META_ATTR_MAP + PARTICLE_ATTR_ADD + K_EDGE_ADD + SOURCE_REFRESH + DIM_ORDER + PRECEDENT_DISTILL` | 支撑七类根因的处方 |
| `config_store['seven-dim']` | 新增 `edge_bindings`（E1-E7 × 维度 × direction）+ `root_cause_thresholds` | 边规范 + 归因阈值可配 |
| `attribution` jsonb | 扩 `edge_compliance`（E1-E7 应存/实存/缺）+ `category` 扩为 7 态（对应 §3.2 七类） | M 层边合规 + 精细归因 |

---

## §6 页面改造（作战室 sales-decision-monitor.html）

| 区 | 新增/改造 | 内容 |
|---|---|---|
| **溯源面板（新增 T 区）** | 点任一决策 → 四层溯源抽屉 | J 节点 → M(L1-L7 七维 + E1-E7 七边) → K(粒子 + 受控谓词边) → 粒子库行（字段级 diff 高亮：⚠不一致/❌缺失/⏰陈旧） |
| **L2 业务反馈卡** | 巡检卡 / 作战室 L2 区 | §2.1 表单（可用/不可用、重大偏差、实际结果、偏差描述） |
| **J3 根因归因条** | 巡检卡底部 / 建议浮卡 | 显示 root_cause.code + layer + severity + evidence 链 |
| **自动建议浮卡** | 偏差即浮 | 七类之一 → 具体 patch 方案 → 一键批准/去重跑 |
| **seven-dim 边绑定页签** | 配置页扩展 | E1-E7 × 维度 绑定 + 归因阈值（A 方案：单页页签） |

---

## §7 MCP 改造（src/mcp/tools.js 增量）

| 工具 | 方向 | 说明 |
|---|---|---|
| `crm_decision_trace` | 读 | 输入 decisionId，返回 J→M→K→粒子库 四层溯源链（含字段 diff） |
| `crm_decision_root_cause` | 读 | 返回 §3 分类结果（code/layer/severity/evidence）+ 建议 patch |
| `crm_decision_outcome_set` | 写（第0闸） | 结构化回写 §2.1 业务反馈 |
| `crm_root_cause_list` | 读 | 按根因类别/层/严重度聚合，供 A9 共性问题发现 |
| `crm_calibration_*` | 写（第0闸） | 既有 6 工具扩展 knob 至七类 |

复用现有 MCP 身份网关两阶段 + 第0闸，不新增鉴权模型。

---

## §8 SKILL 修改边界（铁律：不污染 10 SKILL 基线）

| SKILL | 改动 | 形式 |
|---|---|---|
| `ai-feedback-loop` | 金律 19 四象限 → 升级为「七类根因归因」中性示例 | 仅加中性示例（"一个决策被推翻，溯源发现是参考先例被推翻所致"），不写 CRM 业务名词 |
| `ai-memory-lifecycle` | 记忆三构件新增"溯源下沉到粒子库字段级"中性示例 | 中性示例 |
| `ai-context-layering` | K 知识系统（原 L1-L4）↔ M 维度/边 对照加中性示例 | 中性示例 |
| 10 大 ai-* 基线 | **不增删改编号、不加领域专有词** | 维持审计可复现 |

---

## §9 验收口径

| 项 | 验收 |
|---|---|
| 四层溯源 | 任选 1 条 decision，`crm_decision_trace` 返回 J/M/K/粒子库 全链，④ 跳能标出字段不一致/缺失/陈旧 |
| 业务反馈 | `crm_decision_outcome_set` 落 `feedback` 且驱动 `accuracy_signal` |
| 七类归因 | 构造 7 类样例决策，分类器各命中 1 类且 evidence 链可追 |
| 第 7 类 | 构造"参考先例被推翻"样例，自动归因 DATA_QUALITY_PRECEDENT 并建议 PRECEDENT_DISTILL |
| 处方闭环 | 七类建议各可一键批准经第0闸写回 K/M，重跑后同类偏差率下降 |
| 铁律 | 全程零 DELETE（蒸馏降权非删）；UI 零硬编码色值；10 SKILL 不污染 |

---

## §10 任务拆分（承接 T1-T24）

| Task | 内容 | 承接 | 状态 |
|---|---|---|---|
| **T25** `traceRootCause()` + `crm_decision_trace` | 四层溯源链 + §1.2 三检 | 新 | ✅ 已落地 |
| **T26** `decision.feedback` + `outcome_set` + J2 表单 | §2 结构化反馈 | 接 T15 | ✅ 已落地 |
| **T27** `rootCauseClassifier()` + `crm_decision_root_cause` | §3 七类分类 | 新 | ✅ 已落地 |
| **T28** `calibration_patch.knob` 扩枚举 + `KNOBS` + rules R11-R17 | 七类处方 | 接 T16 | ✅ 已落地 |
| **T29** `attribution` 扩 `edge_compliance` + `category` 七态 | M 层精细归因 | 接 T1/T3 | ✅ 已落地（含 T29-b 三元组接线：`computeEdgeCompliance` 三调用方补 `required_dims` 来源→`requiredEdges` 推导，EDGE_MISSING 真正可触发；`edge_missing_rate` 聚合改三元组） |
| **T30** 作战室溯源面板 + J3 归因条 + 自动建议浮卡 | §6 UI | 接 T12/T14 | ✅ 已落地 |
| **T31** `meta_attr` 加 `required`/`source_refresh_sla` + 种子数据 | §1.2 检测基础 | 新 | ✅ 已落地 |
| **T32** `config_store.edge_bindings` + `root_cause_thresholds` + seven-dim 页签 | §5 配置 | 接 T1b | ✅ 已落地 |
| **§7** `crm_root_cause_list` 聚合工具 | 按 code/layer/severity 聚合，供 A9 共性问题发现 | §7 | ✅ 已落地（`seed-actions.js` read 工具 + 暴露断言 + 聚合语义测试） |

> 文档体系衔接：`redesign.md`(闭环骨架) → `j2-j3-comprehensive-design.md`(四维度改造) → **本文**(全链路溯源 + J3 根因归因) → writing-plans 逐 Task 落地。

---

*未批准不写实现代码（铁律）。本文为设计基线，需用户本地 commit（沙箱无私有库凭证）。*
