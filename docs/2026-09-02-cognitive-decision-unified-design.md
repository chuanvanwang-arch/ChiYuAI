# 认知驱动决策子系统 · 统一设计（五文档合并重评版）

- 版本：**v3（统一版）**
- 日期：2026-09-02
- 合并源（5 份，均已归档至 `docs/archive/`）：
  1. `2026-09-02-cognitive-decision-framework-audit.md`（认知框架审计 · 缺口清单）
  2. `2026-09-02-cognitive-architecture-redesign.md`（K-M-D 三层架构 v2）
  3. `2026-09-02-sales-decision-selfcheck-instantiation.md`（2B 销售自检 · 领域实例化）
  4. `2026-09-02-kmd-integration-detailed-spec.md`（K-M-D 贯通 · 字段级规格）
  5. `2026-09-02-design-landing-audit.md`（全量设计落地审计）
- 重评输入（本轮新增，非合并源）：
  - `docs/2026-09-02-lightfield-memory-decision-study.md`（Lightfield 8 篇原文研究：反向数据流 / 图与故事分工 / Knowledge·Skill 分离 / 确定性评分 / 复合效应）
  - 本轮并行任务的四条执行教训（L3 执行层实证 / 测试隔离完整性 / 定时预热 / 反静默吞错）
- 实测库：`crm_native`（PG 5433，schema `crm`）——**本文所有行数、列结构、维度命中率均为 2026-09-02 直连生产库实测**
- 状态：**设计稿，未批准 → 不写实现代码**（HARD-GATE）

---

## §0 执行摘要：重评结论

### 0.1 一句话结论

**五份文档的主干判断全部成立（八要素缺 6 项、九尺子零落地、闭环末端零运行），但其中三条关键归因是错的，且实施顺序整体排反了。**

三条错因 + 一个顺序问题，构成本次重评的全部价值：

| # | 原文判断 | 重评裁定 | 证据 |
|---|---|---|---|
| **R1** | 「Q1 恒 warn / 可审计性 21%」源于 `required_dims` 全空 | ❌ **错分**。`required_dims` 空导致的是**拦截引擎空转**与**相关性尺子无对象**；Q1 恒 warn 的真根因是 **S2/S3/S4 三个供给操作在生产零命中** | 26 条快照：`semantics` 0/26、`governance` 0/26、`decision_history` 0/26 |
| **R2** | 「概念（八要素#4）已由 `methodology_ids` 完整承载」 | ⚠️ **降级**。`methodology_ids` 只是 ID 数组；`methodology_dimension` 34 行（带 `weight`+`required`）**零调用点**，权重从未参与任何判定 | `methodology_dimension` 34 行，全仓无消费点 |
| **R3** | 「九尺子需 LLM 3 项（清晰/准确/公平）」 | ✅ **收紧为 1 项**。`methodology_dimension.weight` 为「重要性」提供现成量化信号；「准确性」「公平性」可由故事线证据三态确定性判定 | Lightfield C4 同构：决策质量必须靠 Determinism |
| **R4** | 实施顺序 = 先建 D 层 8 列 + 九尺子 + 监控台 | ❌ **顺序排反**。无 L0 原料（events 0 行）则假设无可验证对象、故事线三源三空、backfill 归零；无供给层复通则九尺子 8 项确定性评分全部恒 0 分 | `events` 0 行；`supplied_dims` 峰值 4/7 |
| **R5** | （并行任务）阶段 A 已实施 = L0 已就绪 | ⚠️ **代码已实施，生产未生效**。回归 2424 全绿，但生产库 `crm.events` 仍 0 行、`crm.memory_log` 无 `entity_id` 列（迁移未跑）⇒ 下游全部依旧空转 | `information_schema` 直查 + 行数复测 |

### 0.2 重排后的实施主轴

```
P-1  供给层代码缺陷复通（bug 豁免）  S4 动作名错配 + S7 声明顶包（S2/S3 属数据真空归 P0；双轨已闭合）
 ↓
P0   L0 原料层（Lightfield C1）    events 常驻 + 客户锚点 + 故事源激活 + backfill
 ↓
P1   结构层（D 层内涵 + 九尺子）    9 列迁移 + 8 确定性评分 + 场景配置 + 监控台真实化
 ↓
P2   闭环回流（决策改写 K+M）      复盘 / 后见之明 / 偏差校验 → 处方审批
 ↓
P3   知识沉淀与作用域              Knowledge 注入 + Skill 三层作用域 + 语义向量 + 记忆分层
```

**判据**：先让「喂进去的东西」真的供得上、留得下，再谈「思维好不好」。否则九尺子建出来就是一台恒输出 0 分的空转机器。

### 0.3 五份源文档处置

| 源文档 | 评估 | 处置 |
|---|---|---|
| 认知框架审计 | 缺口清单与根因盲区仍有效；「方案 A 先做」被 R4 取代 | 并入 §2、§6；原文归档 |
| K-M-D 架构 v2 | 主干（三层 + 九尺子内嵌 + 闭环三条腿）保留；R1/R2/R3 三处修正 | 并入 §3、§5；原文归档 |
| 销售自检实例化 | 阶段聚焦矩阵与 required_dims 推导保留；修正 `stage` 列已存在、初值两版冲突 | 并入 §7；原文归档 |
| KMD 贯通规格 | **最新最细，升格为主干**；顺序按 R4 重排 | 并入 §4、§5、§8、§9；原文归档 |
| 全量落地审计 | 结论（L3 教训 / 闭环 0 数据 / 30 文件未提交）有效，被 §2 新证据深化 | 并入 §2、附录 A；原文归档 |

---

## §1 设计输入

### 1.1 《人类知识、记忆与决策的关系》两条主线

**闭环**（L20）：`记忆 → 形成知识 → 做出决策 → 决策结果反馈 → 更新记忆与知识`。

**八要素**：1 目的 / 2 问题 / 3 信息 / 4 概念 / 5 假设 / 6 推论 / 7 视角 / 8 意涵与后果。

### 1.2 九尺子编号与术语 —— **统一裁定（三份文档三套顺序，此处定案）**

> 源文档内部不一致：认知文档标题行为「清晰·准确·精确·相关性·深度·广度·逻辑·重要·公平」，其 1–9 展开段为「清晰·准确·精确·深度·相关性·逻辑·重要·广度·公平」；架构文档取展开段，KMD 规格与 Lightfield 研究取标题行。

**裁定：以标题行枚举顺序为准**（标题是显式锚点，且与 Lightfield 评分表一致）。术语一律用「**相关性**」，禁用「关联性」。

| # | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 |
|---|---|---|---|---|---|---|---|---|---|
| 尺子 | 清晰性 | 准确性 | 精确性 | 相关性 | 深度 | 广度 | 逻辑性 | 重要性 | 公平性 |
| key | clarity | accuracy | precision | relevance | depth | breadth | logic | significance | fairness |

**本文之后所有编号、字段、配置键、UI 展示均以此为准**（单一事实源落 `src/decision/rubricSpec.js`，禁止在 SQL / HTML / 配置里散落字面量）。

### 1.3 《2B 销售全流程决策自检框架》
七阶段 → 八要素/九尺子的阶段聚焦，是 `required_dims` 与聚焦矩阵的推导依据（§7）。第四部分「决策三件套」（结论 / 风险清单 / 止损条件）→ `risk_register` / `stop_loss`。第五部分极简 7 问 → 自检卡读模型。

### 1.4 Lightfield 五条硬结论（本轮重评的主要依据）

| # | 结论 | 对本设计的约束 |
|---|---|---|
| **C1** | 数据流方向是反的：raw 轨迹先落 → schema 后贴 → story 派生；摘要/字段/看板都是**派生视图** | **P0 必须补 L0 原料层**。我们 `meta_attr` 写时自适应登记是"断根的半成品"——能后贴 schema，但无 backfill，而回填前提是 raw 常驻（events 0 行 → 能力归零） |
| **C2** | 图没被弃用，只换了角色：**图=寻址，故事=推理** | 处置判据一句话：**如果这条边的值会因为一次对话而改变，它就不该是边**（§3.4） |
| **C3** | Knowledge / Skill 是可分离两件，判据「给新人讲过三遍=Skill；每次都要重复讲的公司背景=Knowledge」 | 阈值（BANTCC/21 条/TAORAN）+ `methodology_dimension` = **Knowledge**；阶段推进/复盘 = **Skill**。二者当前**均未注入决策前链路** |
| **C4** | 决策质量靠确定性（LLM-only 三局限：Scale / Determinism / Output fidelity） | 九尺子 **8 项必须走代码判定**，否则同一决策每周跑出不同分，趋势与复合效应无从测量 |
| **C5** | 复合效应可测量：「Skills run better on month-three data than day-one data」 | 新增反假绿指标 **Q(Skill, T)**：90 天窗口内质量分不提升即判空转 |

Lightfield 五测试自评：**0.5 / 5**（capture ❌ / synthesis ❌ / why ⚠️空壳 / query ⚠️降级 / action ⚠️部分）——这是本设计的外部标尺。

### 1.5 本轮并行任务的四条执行教训（已写入设计约束）

| 教训 | 落到本设计 |
|---|---|
| **L3 执行层实证**：机制存在 ≠ 跑得通（三 SKILL 内 `crm.particle` 单数表名恒抛 + 空 catch 吞掉） | 每个 Task 的验收必须含**真实库实证**，不得只靠单元测试（§11.2） |
| **测试隔离完整性**：按范围删必须「子表→主表」清 | 新增表 `decision_rubric_score` 后，相关测试跑 `npm run audit:isolation`；`crm.decision` 被 **9 张表外键引用** |
| **定时无预热**：setInterval 首触发需等满周期，重启后恒空 | 新增定时器（批量评分 / retro / Q 采样）必须**注册即预热一次** |
| **反静默吞错**：禁裸 `.catch(()=>{})` | 本文所有 fail-open 处一律 `emit('trace')` + `recordFailure()` 留痕 |

---

## §2 现状重评：生产库实测（2026-09-02）

### 2.1 基线实测

| 层 | 载体 | 行数 | 判定 |
|---|---|---|---|
| **L0 原料** | `events` / `tasks` | **0 / 0** | ❌ **生产零数据**——阶段 A 代码已实施但**迁移未跑**（见 §2.8） |
| 记忆 M | `particles` / `edges` | 71 / 20 | ⚠️ 审批域占 45 行；业务实体 ACCOUNT 1 / CONTACT 1 / DEAL 5 |
| 记忆 M | `memory_log` | 38 | ⚠️ layer 全 `L-Workspace`，**无客户锚点**（topic 仅 `event:*` 32 / `decision:*` 6） |
| 记忆 M | `memory_note` / `memory_snapshot` | 1 / 0 | ❌ 长期记忆通道空转 |
| 知识 K | `methodology_template` / `methodology_dimension` | 11 / **34** | ⚠️ **有知识，零调用点**（F2） |
| 知识 K | `decision_scenario` / `skill_registry` | 12 / 24 | ✅ 场景齐备 |
| 知识 K | `decision_rule` / `policy_version` / `assertions` | 0 / 0 / 0 | ❌ 规则层空 |
| 决策 D | `decision`（**33 列**） | 12 | ⚠️ `outcome` 0/12、`trigger_context` 非空仅 4/12、`confidence` 3/12 全 0.6 |
| 决策 D | `decision_context_snapshot` | 26 | ⚠️ 其中 **14 条 decision_id 为 NULL**（调试端点产物） |
| 决策 D | `decision_provenance` / `decision_outcome` / `decision_precedent_rel` | 8 / 4 / 4 | ⚠️ 稀疏 |
| 学习 | `calibration_patch` / `decision_retro_report` | 0 / 0 | ❌ 闭环末端零运行 |
| 治理 | `meta_attr` / `config_store` | 0 / 1 | ⚠️ 配置仅 `decision-context-guard` 一键 |

### 2.2 【新发现 N1】供给层：3 个操作零命中，但**病因分三类**（落地前必须分清）

`decision_context_snapshot.dim_coverage` 是 jsonb（每维 `{ops[], supplied}`），`supplied_dims` 是**整数计数**（非数组）。26 条快照实测：

| 维度 | supplied / 26 | 供给操作 | 操作实况 |
|---|---|---|---|
| identity | 23 | S1 | hit 23 / empty 3 |
| structure | 23 | S1 | 同上 |
| operational_state | 21 | S5, S6 | S5 hit 12、S6 hit 9 |
| time_config | 12 | S5 | S5 hit 12 / empty 14 |
| **semantics** | **0** | S3 | **0 hit（无冲突数据可召回）** |
| **governance** | **0** | S3, S4 | **S3 0 hit；S4 0 hit（动作名错配）** |
| **decision_history** | **0** | S2 | **0 hit（先例库真空）** |

> **关键修正（2026-09-02 复验代码 + 并行会话进度）**：S2/S3/S4/S7 零命中**不是同一种缺陷，落在不同层**。笼统归为"供给层缺陷"会误导落地——S4 改一行代码即可复通，S2/S3 改代码毫无意义（库里没数据），S7 是声明冗余。本轮已逐条核实源码与契约。

| 操作 | 病因分类 | 代码位置（已核实） | 能否靠改代码复通 | 正确修复归属 |
|---|---|---|---|---|
| **S4 规则校验** | **代码缺陷（确定性）** | 装配调 `ruleEngine.check('CRM_DEAL','context-assembly', ctx.trigger_context, …)`（`assembleContextV2.js:88`）；内置/DB 规则 `match` 仅认 `action==='advance'`（`ruleEngine.js:11/24`、`match_type='CRM_DEAL.advance'`），且 `patch` 传入 `trigger_context`（无 `from/to` 键）→ 双重错位 | ✅ **改代码即可** | **P-1 T2（bug 修复豁免）** |
| **S2 决策史检索** | **数据真空**（非代码缺陷） | 检索路径形态已修（确定性向量兜底，`assembleContextV2.js:71-73`）；零命中因 `crm.decision` 仅 12 行且 scenario 分散、`decision_precedent_rel` 4 行 → 无同场景先例可召回（`coverage=0`） | ❌ 代码已对，改代码无效 | **P0（灌 L0 原料 + 真实决策流量）** |
| **S3 冲突探测** | **数据真空**（非代码缺陷） | `detectConflicts` 形态已修（`assembleContextV2.js:82`，`cf?.assertions \|\| []`）；零命中因 `crm.assertions` **0 行** → 无冲突断言可召回 | ❌ 代码已对，改代码无效 | **P0（assertions 有原料）** |
| **S7 溯源捕获** | **声明缺陷**（校验器被顶包） | `supplySpec.js:23` 声明 `serves_dims: 全 7 维`，但装配期恒 `{items:[]}`（`assembleContextV2.js:107`）；`computeDimCoverage` 已改"仅 runtime hit 才算 supplied"→ **不再污染 supplied 判定**，但 `validateSupplySpec` 因 S7 顶着全 7 维会**掩盖其它操作未覆盖的真空洞**（删掉 S3 仍报 valid） | ✅ 改声明即可 | **P-1 T3（bug 修复豁免）** |

> 补充：F4 双轨（`autonomyEngine.js:102` 事前装配 + `precedents` 注入 + `decisionRepo.js:152` 冻结）已由并行会话修复，已核实。N5 当前 **已闭合**，不列入 P-1。

### 2.3 【新发现 N2】Q1 恒 warn 的真根因（纠正 R1）

`auditability.js` 判 Q1 pass 需 `supplied_dims >= 5`。实测峰值 4/7，且：

- 可达的只有 4 维（identity / structure / operational_state / time_config，靠 S1 / S5 / S6）
- 其余 3 维（semantics / governance / decision_history）**恒 false**：其中 S4 是确定性代码缺陷（动作名错配，P-1 T2 可修），S2/S3 是数据真空（库无原料，需 P0）；S7 空壳兜底不产生 `hit`（P-1 T3 修声明）

⇒ **Q1 恒 warn、可审计性实测 21%、九尺子「相关性/深度/广度/公平性」无信号源，三者同源，都在供给层。**

**与 `required_dims` 的边界（不可再混为一谈）**：

| 缺陷 | 真根因 | 修复动作 |
|---|---|---|
| 七维拦截引擎从未 block（B1） | `decision_scenario.required_dims` 12/12 全 `[]` | P1 回填（§7） |
| 「相关性」尺子无评分对象 | 同上（供给项 ∩ 必填维无交集可算） | 同上 |
| **Q1 恒 warn / 供给上限 4/7** | **S2/S3/S4 零命中 + S7 空壳** | **P-1 修复（§11.1）** |

### 2.4 【新发现 N3】L0 缺失使「假设可验证」与 backfill 同时归零

- `events` 0 行、`tasks` 0 行 ⇒ 故事线四源中 `events`/`tasks` 两源空，`memory_log` 源因无客户锚点恒空（`timelineSource.js:95` 查 `topic='account:<id>'`，库里 topic 全为 `event:*`/`decision:*`）⇒ **四源三空**。
- 后果链：假设的 `evidence_ref` 无处可指 → 九尺子「准确性」三态判定（grounded / contradicted / unsupported）无法落地 → 复盘时「假设是否成立」无证据 → 闭环回流无输入。

### 2.5 【新发现 N4】Knowledge 存在但零注入

`methodology_dimension` 34 行（含 `weight`、`required`），全仓**无消费点**；`config_store['sales-thresholds']` 等阈值键未预置（代码靠 `readThreshold()` 出厂默认兜底）。按 Lightfield C3，这是标准 Knowledge，当前**从未在决策前注入**。

### 2.6 【新发现 N5】装配双轨（F4）：决策依据与审计留痕不同源

`autonomyEngine.js:60-89` 在调 `createDecision` **之前**已自行完成 `buildConditions`（知识注入）+ `searchPrecedents`（先例检索）并据此算置信度；随后 `createDecision` 内的 `assembleContextV2`（`decisionRepo.js:107`，位于 INSERT 之后）**又把 S2 跑一遍**。

- **主害（可审计性失效）**：两次检索独立执行，中间若有新决策入库，结果即不同 → 出现"决策时参考了 A，留痕里却是 B"，审计追问"你当时到底看了什么"无法回答。
- **次害**：同一决策内重复检索，且两遍结果都不落到八要素字段上。

> **状态更新（2026-09-02 复验代码）**：F4 双轨已由并行会话修复——`autonomyEngine.js:102` 事前装配并将 `precedents` 注入 `assembleContextV2`，`decisionRepo.js:152` 落库阶段改为「冻结」（`pre_context`）而非二次检索（双批先例不同源问题消除）。**N5 已闭合，不列入 P-1。**

### 2.7 保留的原诊断（仍然成立）

| 原编号 | 诊断 | 状态 |
|---|---|---|
| B1 | `required_dims` 12/12 空 → 七维拦截从未触发 | ✅ 成立（但仅影响拦截，不影响 Q1） |
| B3 | `decision.outcome` 0/12 → 业务结果零回写，闭环三条腿无输入 | ✅ 成立 |
| B4 | 记忆只有 L-Workspace 单层，`memory_note` 1 / `memory_snapshot` 0 | ✅ 成立 |
| B5 | 八要素仅「信息/概念」2 项有落点，其余 6 项无字段 | ✅ 成立（概念降为"有 ID 无物化"，见 R2） |
| C5 | 根因七类 `layer` 全落供给层 → 推理缺陷被误判为数据缺陷 | ✅ 成立 |
| — | 闭环 0 数据（calibration_patch / rule_hit / retro / agent_sla）机制无缺陷=从未运行 | ✅ 成立（SLA 预热已修，补录后 25 行） |

### 2.8 【新发现 N6】阶段 A（L0 原料层）代码已实施，但**生产库未生效**

并行任务已按 Lightfield 方案实施 A1–A4 并通过全量回归（344 files / 2424 tests）。代码位置确认：

| 动作 | 代码位置 | 生产库状态（2026-09-02 复测） |
|---|---|---|
| **A1** 交互统一落 `events` | `src/events/recordEvent.js:55`（写入形态 `payload.entity_id`） | ❌ `crm.events` **仍 0 行**（新通道无业务动作触发） |
| **A2** `memory_log` 客户锚点 | `db/migrate.js:72-80`（`ALTER TABLE crm.memory_log ADD COLUMN IF NOT EXISTS entity_id TEXT` + 索引） | ❌ `crm.memory_log` **无 `entity_id` 列** ⇒ **迁移未在生产库执行** |
| **A3** 故事线锚点对齐 | `src/context/timelineSource.js:58-75`（锚点由 `account_id` 改 `entity_id`，双形态兼容） | ⚠️ 代码就绪，但依赖 A1/A2 生效 |
| **A4** backfill 通道 | `src/ontology/backfill.js` | ⚠️ 代码就绪，但依赖 events 有原料（`backfill.js:11` 自注：A1 之前 events 恒 0 行） |

**判定**：这是「测试全绿 ≠ 生产可用」铁律的又一次实证——**回归全绿证明代码正确，不证明生产已生效**。

**后果**：若不补跑生产迁移，本设计的 P0 全部下游（假设可验证性、故事三构件、backfill、九尺子「准确性」）依旧空转。

**所需授权（生产写操作，待用户批准）**：
1. 跑 `PGDATABASE=crm_native node db/migrate.js`（幂等，A2 段为 `ADD COLUMN IF NOT EXISTS`）
2. 触发首批真实业务动作以产生 `events`（拜访/报价/合同推进）

**规程化教训（写入 §11.6）**：任何"已实施"的设计，验收必须包含 `information_schema` / 行数的**生产库直查**，不得仅凭回归全绿判定完成。

---

## §3 顶层架构（合并版）

### 3.1 五段视图

```
┌─ L0 原料层（新增，Lightfield C1）────────────────────────┐
│  events（交互原话/原始轨迹）· tasks · memory_log(entity_id)   │
│  铁律：Reality first，字段/摘要/看板全部是派生视图             │
└──────────────────────┬──────────────────────────────────┘
                       │ A: 捕获 + 客户锚点 + 故事源 + backfill
┌─ K 知识系统（用什么判）─────────────────────────────────┐
│  Knowledge：methodology_dimension(34) · 阈值(config_store)    │
│            · decision_scenario.required_dims · decision_rule   │
│  Skill：decision_scenario(12) · method-* SKILL（三层作用域）   │
└──────────────────────┬──────────────────────────────────┘
                       │ I1 判据注入（Pre，当前断裂）
┌─ M 记忆系统（记得什么）─────────────────────────────────┐
│  7 轴事实域（供给账本，不占层）· E1–E7 边（仅寻址）           │
│  故事三构件：characters / dynamics / trajectory（新增）        │
└──────────────────────┬──────────────────────────────────┘
                       │ I2 上下文装配（Pre/In，已通但需复通）
┌─ D 决策层（判了什么+怎么想+好不好）────────────────────┐
│  ├ 八要素内涵（9 个 JSONB 列，§5）                           │
│  ├ 九尺子内嵌检查（8 确定性 + 1 LLM，§6）                    │
│  └ 决策四问（Q1–Q4，auditability.js）                        │
└──────────────────────┬──────────────────────────────────┘
                       │ I3 决策物化
┌─ 闭环回流（决策改写 K + M）──────────────────────────────┐
│  I4 复盘→新知识 / I5 后见之明→改写记忆 / I6 偏差校验           │
│  I7 处方审批（第 0 闸 + HITL，AI 不直接改配置）               │
└──────────────────────────────────────────────────────────┘
```

### 3.2 四套度量的正交性（不可互相替代）

| 度量 | 本质 | 回答 | 载体 |
|---|---|---|---|
| **7 轴事实域** | 决策依据的供给账本 | 查过哪些抽屉 | `decision_context_snapshot.dim_coverage` + `supplied_dims`（整数） |
| **八要素** | 决策的内部构造 | 这次怎么想的 | `decision` 9 个 JSONB 列 |
| **九尺子** | 决策的质量度量 | 想得好不好 | `decision.rubric` + `decision_rubric_score` |
| **Q(Skill,T)** | 系统的复合效应 | 记忆有没有在变好 | 新增采样（§9.5） |

7 轴是**唯一能在决策产生之前确定性说"不"的一层**（写前门禁 + 归因坐标系 + Q1 判据 + 降级留痕 + 装配自检 + 页面闸门，六项运行时职责见架构文档 §3.4）。它只判"有没有"，不判"对不对"——**7 轴过了 ≠ 决策质量好，那正是九尺子的位置**。

### 3.3 九尺子：内嵌决策过程，不另起一层/一视图

内嵌于 D 决策生成时同步触发，产物 = **错误归因 chip + 评分**：

- chip 落在 `/sales-decision-monitor` 场景列表（截图样式：`输入不及时 1` / `维度不对 1` / `先例污染 1` / `字段不一致 1` / `边选择不对 1`）
- 评分明细落在决策详情抽屉的「评分卡」折叠区

与 `attribution` 正交：**attribution 回答"输入齐不齐"（写时物化），rubric 回答"思维好不好"（生成时内嵌，可重跑）**，不合并。

### 3.4 图 vs 故事（Lightfield C2）→ `edges` 处置判据

**判据一句话：如果这条边的值会因为一次对话而改变，它就不该是边。**

| 谓词（`particleModel.js:278-287`） | 性质 | 处置 |
|---|---|---|
| `belongs_to` / `owned_by` / `part_of` / `member_of` | 结构归属，不变 | **保留为边**（寻址） |
| `referenced_in` / `evidenced_by` / `sourcedFrom` | 引用证据 | **保留为边**（服务于"找到原话"） |
| `instanceOf` / `governs` / `has_technical_proposal` / `priced_by` / `used_in` / `named_assignment` | 元模型 / 制品归属 / 治理 | 保留 |
| **`relationship_strength` / `champion_strength`** | **会变的判断** | **迁出边**，进故事（malleability） |
| **`key_contact`** | 半结构半判断 | 结构归属留边，强度部分进故事（现仅 1 行） |
| `temporallyFollows` | 时序 | 由故事 **Chronology** 取代 |
| `transitionedBecause` | 因果 | 由故事 **Causality** 取代 |
| `explains` | 概念语义 | ⚠️ 这正是被弃的 classical graph 用法 → 并入故事，观察一期 |

### 3.5 Knowledge / Skill 分离与三层作用域

| 类别 | 判据 | 本项目载体 | 现状 |
|---|---|---|---|
| **Knowledge** | 每次都要重复讲的公司背景 | 阈值 `config_store['sales-thresholds']`、`methodology_dimension` 34 行、`decision_rule` | ✅ 有载体，❌ 未注入决策前 |
| **Skill** | 给新人讲过三遍的可重复工作流 | `decision_scenario` 12 + method-* SKILL | ⚠️ 有定义，❌ 未接 Knowledge |
| **作用域** | System / Workspace / User | 现只有全局一层 | ❌ 缺个人试跑 → 推广团队的路径 |

---

## §4 数据模型（统一后单一版本）

### 4.1 `crm.decision` 新增 **9 列**（R2/R3 裁定后为 9，非 8）

| 列名 | 承载 | 结构 |
|---|---|---|
| `intent` | 1 目的 + 2 问题 | `{ purpose, hidden_goal, question, sub_questions[] }` |
| `assumptions` | 5 假设 | `[{ id, text, basis, falsifiable_by, evidence_ref[], risk_if_wrong }]` |
| `inference` | 6 推论 | `{ chain: [{ evidence, via_assumption, conclusion }], conclusion }` |
| `viewpoints` | 7 视角（一等公民，不并入 inference） | `[{ stance, holder, covered }]` |
| `implications` | 8 意涵与后果 | `[{ type: positive/negative, text, probability, mitigation }]` |
| `risk_register` | 三件套·风险清单 | `[{ risk, severity, evidence, mitigation, owner }]` |
| `stop_loss` | 三件套·止损条件 | `{ condition, deadline, trigger, owner, status: armed/triggered/released }` |
| **`concept_refs`** | **4 概念（物化，R2）** | `[{ methodology_id, dimension_key, weight, required, hit }]` |
| `rubric` | 九尺子评分物化 | `{ scores:{…}, weighted_total, level, degraded[], scored_at }` |

**不新增列**：3 信息 → `conditions_evaluated` + `dim_coverage`；6 推论保留 `rationale` 为自由文本但不作为评分对象。

### 4.2 `crm.decision_scenario` 新增 **5 列**

| 新增列 | 类型 | 内容 |
|---|---|---|
| `stage_code` | TEXT | S1–S8 机器键。**注意：表内已有 `stage` 列（中文显示标签，如「一、线索」，被 `sevenDimRender.js:67` 消费）→ 保留不动，另加 `stage_code`** |
| `focus_elements` | JSONB | 聚焦八要素子集（带权重） |
| `focus_rulers` | JSONB | 聚焦九尺子子集（带权重） |
| `rubric_pass_line` | REAL | 九尺子加权及格线 |
| `retro_required` | BOOLEAN | 是否强制复盘 |

`required_dims` 列**已存在**（jsonb，12 场景全 `[]`），P1 回填，不新建。

### 4.3 新表 `crm.decision_rubric_score`（append-only）

```sql
CREATE TABLE IF NOT EXISTS crm.decision_rubric_score (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id  UUID NOT NULL,
  rubric_key   TEXT NOT NULL,
  score        SMALLINT NOT NULL,
  max_score    SMALLINT NOT NULL DEFAULT 4,
  level        TEXT NOT NULL,
  weight       NUMERIC(4,2) NOT NULL DEFAULT 1.0,
  evidence     JSONB,
  scorer       TEXT NOT NULL,          -- 'rule' | 'llm'
  degraded     BOOLEAN NOT NULL DEFAULT false,
  scored_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 4.4 其它变更

| 对象 | 变更 | 用途 |
|---|---|---|
| `crm.decision_precedent_rel` | `negative_precedent BOOLEAN DEFAULT false` | 反面先例登记（C2 通道） |
| `crm.memory_log` | `entity_id UUID` + 索引 | 客户锚点（A2），使故事线 memory 源不再恒空 |
| `crm.config_store` | `rubric-thresholds` / `rubric-weights` / `rubric-llm` / `retro-config` | 阈值配置化铁律，禁硬编码 |

### 4.5 迁移纪律（踩坑铁律）

> **禁止**把新列写进 `db/schema.sql` 的 `CREATE TABLE IF NOT EXISTS` 段内——旧库表已存在时不补列，后续依赖该列的索引会让**整文件单事务的 `db/migrate.js` 全量回滚**。
> **必须**在 `db/migrate.js` 向后兼容段追加独立 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`（既有 `skill_registry.updated_by`、`particles.stable_key` 同模式）。
> 迁移后须 `information_schema` 直查生产库确认已应用（测试全绿 ≠ 生产可用）。

---

## §5 八要素 × 供给源 × 目标字段（统一表）

| # | 要素 | 供给操作 | 七维 | 现状字段 | 判定 | 目标字段 |
|---|---|---|---|---|---|---|
| 1 | 目的 | — | — | 无 | ❌ | `intent.purpose` + `hidden_goal` |
| 2 | 问题 | — | — | `scenario_id` + `trigger_context`（4/12 非空） | ⚠️ 弱 | `intent.question` + `sub_questions[]` |
| 3 | 信息 | S1/S3/S5/S6 | identity, structure, semantics, time_config, operational_state | `conditions_evaluated` + `dim_coverage` | ⚠️ **供给存在但跑在写后** | 不变 + Pre/In 前置 |
| 4 | 概念 | 知识层（非 7×7） | — | `methodology_ids`（仅 ID 数组） | ⚠️ **有数据、零注入**（R2） | **`concept_refs[]`** |
| 5 | 假设 | S2 | decision_history | 无 | ❌ | `assumptions[]`（Pre 由先例生成草稿） |
| 6 | 推论 | — | — | `rationale`（自由文本，实测为探针文案） | ⚠️ 无结构 | `inference.chain[]` |
| 7 | 视角 | S1/S3 | structure, semantics | `decider_role`（仅"谁决策"） | ❌ | `viewpoints[]` |
| 8 | 意涵 | S5/S6 | operational_state, time_config | 无 | ❌ | `implications[]` + `risk_register[]` + `stop_loss` |

**汇总**：完整承载 0 项、部分 3 项（信息/概念/推论）、完全缺失 5 项。

### 5.1 写入口径

- 写入点：`createDecision`（`src/decision/decisionRepo.js:44`）主干内，与装配调用同级，**fail-open**（物化失败仅 `emit trace` + `recordFailure`，不阻断决策，但必须留痕）。
- 空值策略：允许 `null`，评分时"无证据"计 0 分——**不静默、不用默认值美化**（BG-04 反假绿）。
- 补齐通道：`POST /api/decision/:id/thinking` 人工补录，append 到 `decision_provenance` 留痕，**不 DELETE、不覆盖**。
- **物化率不靠调用方自觉**：Pre 阶段生成**草稿**（先例推导假设、方法论推导概念清单），调用方只需确认/修改。

---

## §6 九尺子评分器（8 确定性 + 1 LLM，R3 裁定后）

### 6.1 评分规则（0–4 分，及格线走 `config_store['rubric-thresholds']`）

| # | 尺子 | 信号源 | 判定 | 依赖 | LLM |
|---|---|---|---|---|---|
| 1 | **清晰性** | `intent.question` + `assumptions[].text` 措辞明确性 | 非空且无模糊词（确定性代理）；精确判定需语义 | 目的/问题/假设 | ✅ 默认关 |
| 2 | **准确性** | `assumptions[].evidence_ref` 命中故事线条目 | grounded / contradicted / unsupported 三态确定性 | 信息/假设 | ❌ |
| 3 | **精确性** | `conditions_evaluated[].value` 具体度（非"大概/可能"） | 类型+单位+时点校验 | 信息 | ❌ |
| 4 | **相关性** | 供给项 ∩ `required_dims` 命中率 | 集合运算 | 信息 | ❌ |
| 5 | **深度** | `inference.chain` 层数 ≥2 且触及根因 | 结构校验 | 推论 | ❌ |
| 6 | **广度** | `viewpoints` 立场多样性（≥3 且含反方） | 计数校验 | 视角 | ❌ |
| 7 | **逻辑性** | `chain` 每条同时有 `evidence` + `via_assumption`；依赖图无环 | 结构校验 | 推论 | ❌ |
| 8 | **重要性** | `concept_refs[].weight` 加权命中率 | **34 行 methodology_dimension 已带 weight，现成量化信号** | 概念 | ❌ |
| 9 | **公平性** | 反面先例被 S2 检索到**且被消费**（非只召回） | 检测 contradicted 条目是否进入 rationale | 视角/假设 | ❌ |

**与 Lightfield C4 同构**：8 项走代码判定，保证 Determinism——同一决策重跑得分一致，趋势与复合效应才有意义。第 1 项 LLM 默认关闭，`config_store['rubric-llm']` 控制。

### 6.2 阶段加权三档

```
基础项（信息 / 推论，全场景）  × 1.0
本场景 focus 项                × 1.5
其余项                        × 1.0   ← 加权 ≠ 豁免，非聚焦项仍计入，不归零（防质量盲区）
```

### 6.3 降级与反假绿纪律

| 情形 | 处置 |
|---|---|
| LLM 不可用 | `degraded=true` + 该项标 `warn`，**不阻断、不静默、不用假分填充** |
| 无证据 | 计 **0 分**，不填默认值 |
| `edges` 不足 / 故事线空 | 「广度」「准确性」标 `degraded`，**不假填充** |
| 监控台 chip | 必须真实评分聚合，**禁止演示数据**（BG-04 双口径） |

---

## §7 阶段聚焦矩阵与 `required_dims` 初值（统一裁定）

### 7.1 三原则（解决两版初值冲突）

1. 只列**本阶段聚焦要素真正依赖的事实域**，不搞全维平推。
2. **不列该阶段几乎必然为空的维**——恒 warn = 制造噪声，属反向假绿。
3. 每场景 **3–4 维**；**不得靠堆必填维去凑 Q1 的 5/7 门槛**（Q1 靠 P-1 供给复通解决）。

### 7.2 统一初值表（覆盖 selfcheck §4 与 KMD §5.2 两版冲突）

| 阶段 | scenario_id | 已绑方法论 | focus_elements | focus_rulers | **required_dims（裁定）** |
|---|---|---|---|---|---|
| S1 线索发掘 | `LEAD_FOLLOW_UP` | BANT, MEDDICC, OPP_MATRIX | 假设·问题·信息 | 相关性·重要性·精确性 | `identity, structure, semantics, time_config` |
| S2 需求确认 | `OPP_QUALIFY` | MEDDICC, OPP_MATRIX, ROLE_MAP | 假设·视角·信息 | 深度·广度·准确性 | `identity, structure, semantics, decision_history` |
| S3 方案匹配 | `SOLUTION_VALUE` | OPP_MATRIX, RISK_TRADEOFF | 假设·概念·意涵 | 相关性·深度·逻辑性 | `structure, semantics, operational_state, decision_history` |
| S4 报价谈判 | `QUOTE_PRICING` | RISK_TRADEOFF, STOP_LOSS | 假设·意涵·推论 | 重要性·精确性·逻辑性 | `identity, structure, operational_state, governance` |
| S5 合同确认 | `SIGN_RISK` | RISK_TRADEOFF, STOP_LOSS | 意涵·视角·假设 | 深度·广度·公平性 | `structure, operational_state, governance, decision_history` |
| S6 赢单移交 | `POST_CONTRACT` | RISK_TRADEOFF, OPP_MATRIX | 意涵·信息·目的 | 准确性·逻辑性·相关性 | `identity, time_config, operational_state, governance` |
| S7/S8 输单丢单 | `LOSS_REVIEW` | FACT_VS_TALK, OPP_MATRIX | 假设·推论·视角 | 公平性·深度·广度 | `identity, semantics, decision_history` |
| 跨阶段（绑 S2） | `CLIENT_STRATEGY` | ROLE_MAP, FACT_VS_TALK, MEDDICC | 视角·假设 | 广度·公平性 | `structure, operational_state` |
| 治理类 4 场景 | `ATTR_SCHEMA_CHANGE` / `CALIBRATION_CHANGE` / `EXTERNAL_ENRICHMENT` / `TRACE_DBG_SCEN` | — | — | — | `[]`（保持空，不参与七维拦截与质量评分） |

**与两版原文的差异说明**：
- S1 采 selfcheck 版（含 `semantics`、`time_config`）：KMD 版含 `decision_history`，但线索阶段无先例，硬设必填 ⇒ 100% warn（违反原则 2）。
- S2 采 KMD 版（含 `semantics`、`decision_history`）：selfcheck 版含 `operational_state`，需求确认早期运行态常空 ⇒ 剔除。
- S3/S6 为两版并集后按原则 2 收敛（S3 剔 `identity`，上游已保证且与方案无关；S6 剔 `semantics`，回款节点属时间/治理域）。
- `on_missing` **一律先设 `warn`**，跑满一个评分周期后按真实数据逐个升 `block`（守"修缺陷不放大约束"教训）。

**纪律**：初值标注「**待业务复核**」，且全部可后台改（单一事实源 = `decision_scenario` 列本身，不进 `config_store`，避免双源）。

---

## §8 Pre / In / Post 三阶段注入 + 消除双轨

### 8.1 三阶段定义

```
Pre  (K → D)  知识先问：这次该问什么、该看哪些维度、边界在哪
In   (M → D)  记忆再答：实际是什么、有无冲突、时序如何、现在什么状态
      ↓ 决策落定
Post (D → K/M) 冻结留痕（不重跑检索）+ 闭环回流调度
```

| 阶段 | 触发 | 执行 | 产物 | 失败策略 |
|---|---|---|---|---|
| Pre | 决策表单打开 / Agent 起意 | S2 + S4 + Knowledge 注入（概念清单） | `PreContext` | fail-open，标 `degraded` |
| In | 实体选定 / 条件变化 | S1 + S3 + S5 + S6 | 信息填充 + 视角素材 | fail-open |
| Post | INSERT 成功后 | S7 溯源 + 快照冻结 + 回流调度 | 快照 + PROV-O | fail-open（已实现） |

### 8.2 Post 语义变化（易踩错）

> **不是把 Post 挪到 Pre，而是新增 Pre/In，Post 保留但语义改变。**

| | 现状 Post | 目标 Post |
|---|---|---|
| 做什么 | 重新装配 S1–S7 | **冻结** Pre/In 已有结果 |
| 重跑检索 | 是 | **否** |
| 目的 | 事后补一份上下文 | 证明"决策当时看到的就是这份" |

PreContext 带 `assembled_at` + `content_hash` 落库，审计时以此为准，不重新查询 ⇒ **可审计性反而更强**，同时消除 N5 双轨。

### 8.3 接口改动（最小面）

| 改动 | 说明 |
|---|---|
| `assembleContextV2(input)` 增 `phase: 'pre'\|'in'\|'post'` | 缺省 `'post'`，向后兼容 |
| `createDecision` 增 `pre_context` 入参 | 传入则不重复 Pre 计算 |
| 新增 `GET /api/decision/pre-context?scenario_id=&entities=` | 前台渲染决策表单骨架 |
| 新增 `GET /api/decision/:id/rubric` | 九尺子评分明细 |

**降级路径**：`createDecision` 未带 `pre_context` → 在 INSERT **之前**自动补跑 `assembleContextV2({phase:'pre'})`。保证 UI / 校准 `store.js:47` / 各处 action / `autonomyEngine:124,144` 四类存量调用方零修改受益。

---

## §9 闭环回流：决策改写 K + M

落库策略：**单决策复盘写 `decision_provenance`（`entry_type='RETRO'`，append-only）；批量聚合写 `decision_retro_report`（已有表，0 行）**。前者是原子事实，后者是周期性洞察。

### 9.1 复盘字段 7 组

A 结果事实（`outcome_type` / `vs_expected` / `verified_at` / `verified_by`）· B 假设核验（`assumption_review[]`）· C 信息缺口（`missing_information[]`）· D 归因（`root_cause` / `hindsight_delta`）· E 知识产出（`knowledge_update[]`）· F 记忆影响（`memory_impact[]`）· G 元信息。

### 9.2 三通道分流（判据：增量 vs 覆盖）

| 通道 | 内容 | 审批 | 依据 |
|---|---|---|---|
| **C1 自动直写** | A/B/C/D/G 事实类 | 否 | append-only 事实记录，不可逆改、不污染配置 |
| **C2 自动登记** | B 中 `verdict='falsified'` → 反面先例（`decision_precedent_rel.negative_precedent=true`） | 否 | 是**新增**先例，不覆盖既有知识；下次 S2 作为反方证据，喂尺子 9 |
| **C3 处方审批** | E 中**改配置**的 patch（`required_dims` / `focus_rulers` / 权重 / 阈值） | **必须**（第 0 闸 + HITL，走 `createDecision({scenario_id:'CALIBRATION_CHANGE'})`） | 改规则影响后续所有决策，**AI 不直接改生产配置** |
| **C3′ 仅留痕** | F 记忆影响 | 否 | 记忆不可篡改 |

### 9.3 后见之明（I5）：原始记忆永不覆盖

| 结果 | 动作 | 落库 |
|---|---|---|
| 成功 | `reinforce`：`memory_log{kind:'HINDSIGHT_REINFORCE'}`，原记忆打 tag `verified` | 新增行 + `tag_history` append |
| 失败 | `rewrite`：`memory_log{kind:'HINDSIGHT_REWRITE', payload:{original, reinterpretation, reason}}`，打 tag `rewritten:hindsight` | 同上，**原 payload 不动** |

**为什么不让 AI 改原始记忆**：一旦改写，复盘就失去"当时怎么想的"基准，证实性偏差会自我巩固（越改越觉得自己当初对）。保留原始层 + 新增解读层，才能算偏差率。

### 9.4 证实性偏差校验（I6）

决策时写 `decision_provenance{entry_type:'HINDSIGHT_CHECK', payload:{belief_at_decision, confidence_at_decision}}`；复盘算 `hindsight_delta`；窗口内 `|delta| > 30%` 占比 = 偏差率；超阈值（走 `config_store`）→ 生成 `calibration_patch` 处方（C3）。

**闭环终点**：批准后的 patch 落 `decision_scenario` → 下次 Pre 装配读新配置 → **新知识真正成为下一次决策的输入**。

### 9.5 复合效应测量（新增，Lightfield C5）

定义 `Q(Skill, T)` = 该 Skill 在时刻 T 的输出质量分（复用九尺子加权总分）。每个 Skill 每场景采样一次，落 `decision_retro_report.clusters`。

**反假绿判据**：90 天窗口内 `Q(T+90d)` 不显著优于 `Q(T0)` ⇒ **记忆没有在复合，系统名义存在、实际空转**。

---

## §10 接口清单（统一）

| 方法 | 路径 | 用途 | 鉴权 |
|---|---|---|---|
| GET | `/api/decision/pre-context` | Pre 装配骨架（必填维/概念清单/先例建议） | 与决策详情一致 |
| GET | `/api/decision/:id/selfcheck` | 极简自检卡 7 问（读模型，不新增列） | 同上 |
| GET | `/api/decision/:id/rubric` | 九尺子评分明细 + 阶段加权 | 同上 |
| GET | `/api/decision/:id/thinking` | 八要素物化内容 | 同上 |
| GET | `/api/monitor/scenario-chips` | 场景列表 chip 聚合（真实评分驱动） | 同上 |
| POST | `/api/decision/:id/thinking` | 人工补录（append 留痕） | 第 0 闸 + HITL |
| POST | `/api/decision/:id/retro` | 提交复盘（写 RETRO） | 第 0 闸 + HITL |
| POST | `/api/decision/:id/hindsight-check` | 触发偏差校验 | 第 0 闸 + HITL |
| GET | `/api/config/stage-focus` | 聚焦矩阵 / 必填维 | sysadmin |
| PUT | `/api/config/stage-focus` | 修改聚焦矩阵 / 必填维 | sysadmin + 第 0 闸 |

---

## §11 实施路线图（重排后，每 Task 一 commit）

### 11.1 **P-1 · 供给层代码缺陷复通**（bug 修复豁免，仅含"改代码即有效"的两项；S2/S3 见 P0）

> 重排依据（§2.2 N1）：S2/S3 零命中是**数据真空**（库无原料），改代码无效，已移出 P-1；N5 双轨已由并行会话闭合，亦移出。P-1 仅剩两个确定性代码缺陷。

| Task | 内容 | 验收（**必须真实库实证**） |
|---|---|---|
| **T2** | 修 S4 动作名错配（**确定性缺陷**）：装配期不应调写闸 `check('CRM_DEAL','context-assembly',…)`，而应**供给治理边界清单**。新增 `ruleEngine.applicableRules(type, action?)` 接口（返回该类型相关规则的"边界"条目，不执行拦截），S4 retriever 改调 `applicableRules('CRM_DEAL')`；`patch` 位原传 `trigger_context`（无 from/to）→ 改传 `{}` 或真实待推进 patch | 造 1 条启用的 `decision_rule` → S4 返回边界条目，`governance` 维 `supplied=true`，`rule_hit` 有行（blocked 与否取决于真实 patch） |
| **T3** | S7 声明缺陷：从 `supplySpec.js:23` 的 `serves_dims` 去掉"全 7 维"顶包，改为只声明它真正产生的 `PROV-O` 边（不占用任何语义维）；同步修 `validateSupplySpec` 的"7 维全覆盖"校验改为"**7 维须有**至少一个**实体操作**（S1–S6）**覆盖，S7 的溯源边不算维度覆盖" | 删 S3 后 `validateSupplySpec` 必须报"semantics 维未覆盖"；快照 `ops[]` 中 S7 不再伪装覆盖语义维 |

> **P-1 验收边界（重要）**：T2/T3 修复后，`supplied_dims` 峰值仍为 **4/7**（identity/structure/operational_state/time_config），不会变 5/7。要突破 4/7 使 Q1 可达，必须 P0 灌 L0 原料让 S2/S3 有数据——**不要误以为 P-1 能消掉 Q1 warn**，那是 P0 的活。

### 11.2 **P0 · L0 原料层**（Lightfield C1）—— **代码已实施，生产未生效，本阶段目标 = 让它真跑起来**

| Task | 内容 | 代码状态 | 剩余动作 | 验收 |
|---|---|---|---|---|
| **A1** | 交互统一落 `events`，收敛原 2 处裸 INSERT；payload 必含 `entity_id` + `raw_text` | ✅ `src/events/recordEvent.js:55` | 触发真实业务动作 | 连续 1 周每次拜访/报价/合同推进后 `events` 有行且 `raw_text` 非空 |
| **A2** | `memory_log` 加 `entity_id` + 索引 + topic 同写 `account:<id>` | ✅ `db/migrate.js:72-80` | **跑生产迁移（待授权）** | `information_schema` 直查 `crm.memory_log.entity_id` 存在；客户相关记忆按 `entity_id` 可查 |
| **A3** | 修故事线 memory 源恒空（锚点改 `entity_id`，双形态兼容） | ✅ `timelineSource.js:58-75` | 依赖 A1/A2 生效 | 故事线四源中 memory 源有数据 |
| **A4** | `backfillAttribute({attrKey, since})` | ✅ `src/ontology/backfill.js` | 依赖 A1 有原料 | 选 1–2 个关键属性做样本验证，可从 raw 文本重算 |

> **本阶段第一顺位动作 = 授权跑生产迁移 + 产生首批 events**。在此之前，A1/A3/A4 的验收一律判「未达成」，不得计入完成。

### 11.3 **P1 · 结构层（D 层内涵 + 九尺子）**

| Task | 内容 | 依赖 | 验收 |
|---|---|---|---|
| **B1** | `decision` 9 列迁移（`migrate.js` 独立 ALTER 段） | — | `information_schema` 直查生产库确认 42 列 |
| **B2** | `createDecision` 八要素物化（fail-open + 留痕） | B1 | 新建决策 `intent`/`assumptions` 非空率 > 0 |
| **B3** | 九尺子评分器 `rulerScore.js`（8 确定性 + 1 LLM 默认关）+ `decision_rubric_score` | B1, P-1 | 确定性 8 项在零 LLM 下全部有分；无证据计 0 不假填充 |
| **B4** | `decision_scenario` 5 列 + 12 场景 `required_dims` 回填 + 聚焦矩阵 | — | 业务场景 `required_dims` 非空率 100%；拦截引擎真触发（warn 模式留痕） |
| **B5** | 故事三构件（characters / dynamics / trajectory）+ 每条输出 `element_ref` + `dim_ref` | A3 | 时间线从流水账升级为证据链 |
| **B6** | 监控台真实化：chip / 7 轴档位 / 思维卡 / 评分卡 / 复盘入口 | B2, B3 | chip 与档位来自真实评分与 `dim_coverage`，非演示数据 |
| **B7** | 自检卡 API + 折叠区（7 问读模型） | B2 | 7 问均返回 pass/warn/fail + 证据指针 |

### 11.4 **P2 · 闭环回流**

| Task | 内容 | 验收 |
|---|---|---|
| **C1** | `POST /retro` + 三通道分流 + 反面先例登记 | RETRO 行产生，falsified 假设生成 `negative_precedent=true` |
| **C2** | 后见之明 reinforce / rewrite（append-only，原 payload 不动） | `memory_log.kind='HINDSIGHT_*'` 有行，原记忆未被覆盖 |
| **C3** | 偏差校验 + `hindsight_delta` + 阈值处方 | HINDSIGHT_CHECK 行产生，超阈值生成处方 |
| **C4** | 处方审批链（第 0 闸 + HITL）→ `config_store` 生效 | 一次处方从生成到生效全链路可追溯 |
| **C5** | `Q(Skill,T)` 采样 + 90 天窗口复合判据 | 采样任务有数据；定时器**注册即预热** |

### 11.5 **P3 · 知识沉淀与作用域**

| Task | 内容 |
|---|---|
| **D1** | Knowledge 注入：`methodology_dimension` 34 行接进 Pre 装配（**须在 T4 消除双轨之后**，否则依据与留痕仍不同源） |
| **D2** | Skill 三层作用域（system / workspace / user）+ 个人试跑→推广路径 |
| **D3** | 可插拔 embedding（`hash` / `siliconflow`，未配置默认 hash 并留痕）+ V3 概念向量；切换前跑 A/B 召回质量对比 |
| **D4** | 记忆分层 L-User / L-Org + 30 天蒸馏任务接线 |

### 11.6 每 Task 的三条硬约束

1. **L3 实证**：每个 Task 的验收必须包含一次真实库运行证据（不止单元测试）。停在 L2「契约存在」会把执行层缺陷误判为已落地。
2. **隔离审计**：新增/修改测试后跑 `npm run audit:isolation`；`crm.decision` 被 9 张表外键引用，按范围删必须「子表→主表」清。
3. **定时器预热**：任何新增 setInterval 注册后立即手动跑一次。
4. **生产生效 ≠ 回归全绿**：每个 Task 完成后必须 `information_schema` 直查生产库确认列已加/表已建/行数已动（N6 教训：阶段 A 回归 2424 全绿，但生产 `memory_log.entity_id` 列不存在）。迁移属生产写操作，需单独授权。

---

## §12 验收口径与风险

### 12.1 验收硬指标

| 指标 | 当前（2026-09-02 实测） | P-1 后 | P0 后 | P1 后 | P2/P3 后 |
|---|---|---|---|---|---|
| 供给维命中（semantics / governance / decision_history） | **0 / 0 / 0**（共 26 快照） | 三维均可命中 | 同上 | 同上 | 同上 |
| `supplied_dims` 峰值 | **4/7** | ≥5/7 | ≥5/7 | 7/7 可达 | 7/7 |
| `auditability_pct` | **21%** | measurable 提升 | 同上 | 同上 | 4/4 可达 |
| 八要素完整承载 | 0/8（部分 3/8） | — | — | **8/8 + concept_refs** | 8/8 |
| 九尺子有真实评分 | 0/9 | 0/9（无对象） | — | **9/9**（8 确定性 + 1 LLM 默认关） | 9/9 |
| `required_dims` 非空 | 0/12 场景 | — | — | **8/8 业务场景** | 8/8 |
| 拦截引擎真触发 | 0 次 | — | — | ✅（warn 模式留痕） | 逐步升 block |
| `events` 行数（L0） | **0**（A1 代码就绪，迁移/动作未执行） | 0 | **连续 1 周有增量** | 同上 | 同上 |
| 故事线可用源 | 1/4（仅 decision） | — | **≥3/4** | 4/4 | 4/4 |
| `decision.outcome` 回写率 | 0/12 | — | — | ≥50% | ≥80% |
| `calibration_patch` | 0 | 0 | 0 | 0 | **>0 且可追溯** |
| Lightfield 五测试自评 | **0.5/5** | — | 2.5/5 | 3.5/5 | 4.5/5 |

### 12.2 铁律核对

| 铁律 | 遵守方式 |
|---|---|
| 设计先行、未批准不写代码 | 本文即闸门；仅 T0–T5 的"修复既有运行时缺陷"可按 bug 修复豁免逐项报批 |
| 零 DELETE | 评分历史 append-only；补录走 provenance；记忆改写走 `tag_history` |
| 阈值配置化 | 及格线/权重/LLM 开关/偏差阈值全走 `config_store`，禁硬编码 |
| 单一事实源 | 聚焦矩阵与必填维落 `decision_scenario` 列；取值域落 `src/decision/rubricSpec.js` |
| 反假绿（BG-04） | 无证据计 0 分、LLM 降级标 `degraded` 不填充、chip 禁演示数据、Q(Skill,T) 复合判据 |
| 不静默吞错 | 所有 fail-open 处 `emit('trace')` + `recordFailure()`，禁裸 catch |
| 迁移纪律 | 全部走独立 `ALTER TABLE ADD COLUMN IF NOT EXISTS`，禁写进 `CREATE TABLE IF NOT EXISTS` 段 |
| 不在生产库跑全量 seed | `meta_attr` 走 `setMetaAttr()` 最小变更 |
| 写操作经第 0 闸 | 处方批准走 `createDecision`（CALIBRATION_CHANGE）；复盘/补录/校验均经 HITL |
| UI 一致性 | 颜色 100% 走 `tokens.css` 语义变量，布局复 `common.css`，零硬编码色值 |
| 每 Task 一 commit | 路线图已按 Task 拆分；禁 `git add -A` |

### 12.3 风险

| 风险 | 等级 | 缓解 |
|---|---|---|
| **供给层不先修，九尺子建出来恒 0 分** | **高** | P-1 前置；B3 验收要求确定性 8 项在真实数据上出分，否则该 Task 不判完成 |
| `required_dims` 初值由 AI 推导，与业务实际不符 | 高 | 全设 `warn` 不阻断；标注待复核；跑满一周期按真实数据校准 |
| `events` 捕获依赖业务动作触发，物化率可能长期为 0 | 高 | A1 已收敛为 `recordEvent.js` 唯一入口；验收卡"连续 1 周有增量"，做不到即判假绿；**并须先授权跑生产迁移**（N6） |
| LLM 评分主观性 | 中 | 仅 1 项且默认关；开启须留 `scorer='llm'` + `evidence`，可人工覆写 |
| 迁移影响生产库 | 中 | 独立 ALTER 幂等；先在 `crm_native_test` 验证 |
| 八要素 9 列靠调用方自觉 | 中 | Pre 阶段生成草稿，调用方只确认；监控物化率 |
| 改 `edges` 谓词影响既有 20 行边 | 中 | 强度类谓词现均 0 行，迁出无数据风险；结构边保留 |

---

## 附录 A · 五份源文档处置

| 源文档 | 处置 | 保留于本文的位置 |
|---|---|---|
| `2026-09-02-cognitive-decision-framework-audit.md` | 归档至 `docs/archive/` | 缺口清单 → §2.7；根因盲区 → §2.7 |
| `2026-09-02-cognitive-architecture-redesign.md` | 归档 | 三层主干 → §3；7 轴六职责 → §3.2；闭环三条腿 → §9 |
| `2026-09-02-sales-decision-selfcheck-instantiation.md` | 归档 | 聚焦矩阵 → §7；三件套 → §4.1；自检 7 问 → §10 |
| `2026-09-02-kmd-integration-detailed-spec.md` | 归档（主干来源） | 八要素映射 → §5；九尺子信号源 → §6；Pre/In/Post → §8；复盘三通道 → §9 |
| `2026-09-02-design-landing-audit.md` | 归档 | L3 教训 → §1.5；闭环 0 数据 → §2.1 |

**已完成的既有修复**（不重复实施）：`STAGE_SCENARIO` 错位（S3–S8）+ 三核心 method-\* steps 补齐 + `crm.particle` 单数表名 P0 修复 + SLA 预热。

## 附录 B · 术语与编号统一（全项目强制执行）

| 项 | 统一取值 |
|---|---|
| 九尺子顺序 | 1清晰 2准确 3精确 **4相关性 5深度** 6广度 7逻辑 8重要 9公平 |
| 禁用词 | 「关联性」→ 一律写「相关性」 |
| D 层列数 | **9**（含 `concept_refs`） |
| 九尺子 LLM 项 | **1**（清晰性），8 项确定性 |
| `decision_scenario` 新增列 | **5**（`stage_code` / `focus_elements` / `focus_rulers` / `rubric_pass_line` / `retro_required`）；既有 `stage` 列（中文标签）保留不覆盖 |
| `supplied_dims` | **整数计数**；逐维明细在 `dim_coverage`（jsonb） |
| 取值域同源 | 八要素/九尺子/七轴 key 单一事实源 `src/decision/rubricSpec.js` |

## 附录 C · 合并后待决问题（去重，原 15 项 → 6 项）

| # | 问题 | 建议 |
|---|---|---|
| Q1 | P-1（供给层复通）是否先于一切？ | **是**。无供给则九尺子恒 0 分、Q1 恒 warn |
| Q2 | `required_dims` 初值（§7.2）是否照单全收？ | 先按初值全 `warn` 上线，跑一个评分周期后按真实数据校准 |
| Q3 | `relationship_strength` / `champion_strength` 是否按 §3.4 从边迁出到故事？`temporallyFollows` / `transitionedBecause` / `explains` 是否废弃？ | 是，迁出/废弃（现均 0 行，无数据风险）；`explains` 观察一期 |
| Q4 | 语义 embedding 切换时点？ | P3；切换前先跑 A/B（hashVector vs 语义向量在同一批先例上的召回质量） |
| Q5 | `decision_rule` / `policy_version` / `assertions` 三张空表：废弃还是待填？ | 待填（T2 补装规则集）；若最终确认废弃，需显式标 deprecated，避免"空表伪装成模块" |
| Q6 | 止损到期未处理是否自动触发工作流？自检卡是否开放给销售一线自助？ | P1 只做"可观测 + 告警"，不自动改商机状态；自检卡 P1 只读，写入仍走第 0 闸 + HITL |

---

**HARD-GATE：以上为设计稿，未获批准前不写任何实现代码。**
> 例外：§11.1 P-1 的 T0–T5 属**修复既有运行时缺陷**（S2/S3/S4/S7 零命中、装配双轨），可按 bug 修复豁免逐项报批后实施。
