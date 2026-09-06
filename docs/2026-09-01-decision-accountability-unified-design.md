# 决策问责体系统一设计：缺陷修复 + 决策监控台重新设计（上下文构成逻辑真正落地）

> 日期：2026-09-01　作者：WorkBuddy
> 目标页：`http://localhost:3000/sales-decision-monitor`（`src/web/sales-decision-monitor.html`，1682 行）
> 外部输入：三篇 Semantica 文章（`ViaPl3gce` 决策问责账 / `3Lsnnon_` 图原生上下文基座 / `40Q2fXJf` 决策链实战教程）
> 内部实证：`src/context/*`、`src/decision/*`、`src/agent/agentLoop.js`、`src/account/insightService.js`、`db/schema.sql`、生产库 `plm` 直查
> 性质：**设计文档，已批准 —— 本文档为「决策问责体系」唯一批准目标**。两份拆分稿已归档（非删除）至 `docs/archive/`，实施以本文为准；写操作仍须走决策第 0 闸（HARD-GATE）。
>
> **本文档取代（已归档，非删除 —— 遵循项目「绝对禁止 DELETE」铁律，保留可追溯性）**：
> - `docs/archive/2026-09-01-sales-decision-monitor-redesign-design.md`（监控台前后台重新设计）
> - `docs/archive/2026-09-01-bugfix-design.md`（决策子系统缺陷修复）
>
> 两文档是同一问题的两面：缺陷文档回答「**为什么断**」，重新设计文档回答「**怎么修**」。本统一文档把根因审计与战略解法合并为单一批准目标与单一实施计划。拆分稿归档后，`docs/` 下仅余本文件承载该议题。

---

## §0 执行摘要（先结论）

### 0.1 一句话定位

本平台的「决策问责」目前**既断链又假绿**：后端上下文装配的产物被整体丢弃（断链），前端因果图/巡检卡却显示「七类边齐备」（假绿）。修复 = **接线既有模块 + 落库真实供给 + 修掉结构性缺陷 + 前台重排为问责主线**，不是新增第 8 个能力。

### 0.2 结论清单

| # | 结论 | 性质 | 来源 |
|---|---|---|---|
| 一 | **上下文构成逻辑是一条断链，不是弱链**。`agentLoop.js:28` 把 `assembleContext` 产物拍平成标签列表塞进 prompt 后整体丢弃——不落库、不带来源、不做冲突检测、不查先例、不校验规则。生产库 9 条决策 8 条 `trigger_context={}`（空率 89%），`decision` 表 32 列无任何快照列、无快照表。 | 断链 | A-§1 |
| 二 | **「七类边全绿」是手工演示数据**。`decision_relation` 7 类边各恰 1 条、`source` 全 `seed-script`、`created_at` 全 2026-08-31，零条运行时产出。看板全绿 ≠ 回路通。 | 假绿 P0 | B-BG04 |
| 三 | **2/7 边结构性不可写**（BG-03 P0 架构偏离）。`DECIDED_ON`/`DERIVED_FROM_EXCEPTION` 的靶子不是 decision，但 `decision_relation` 两端外键都钉死为 decision——表自我矛盾，且实现方在注释中自我承认偏离但未回告评审。 | 架构偏离 P0 | B-BG03 |
| 四 | **装弹后系统性 `EDGE_MISSING` 误报**（BG-05 P0 逻辑炸弹）。6 个已装弹场景含 `identity`/`structure` → 应连边恒含 `DECIDED_ON` → 因 BG-03 永不可写 → 每条真实决策必误报。当前不爆仅因真实决策仅 9 条，业务数据一进即爆且看板同期显示"边齐备"——**自相矛盾**。 | 逻辑炸弹 P0 | B-BG05 |
| 五 | **修复不是新造模块，而是接线 5 个「造好未接线」的模块 + 落库快照 + 修结构性缺陷**。`searchPrecedents`/`detectConflicts`/`ruleEngine`/`buildTimelineRows`/`trackEntry` 已实现有测试，只是不在装配链。 | 工作量定性 | A-§1.3 |
| 六 | **架构收敛为「7 维（校验）× 供给操作（机制）× 7 边（结构）」，供给侧按真实运行模块命名、与维度多对多**（S1–S7）。原初稿把供给侧定义成「供给主题」逐词镜像 7 维（C1–C7），已修正——S1 服务 2 维、S5 服务 2 维、S3 服务 2 维、S7 跨全部，与 7 维正交不重复。 | 架构修正 | A-§3 |
| 七 | **上下文快照落库是 BG-04「数据可信度」的正确解法**：用"每次装配真实供给了什么"的运行时证据，取代 seed 边伪造的"全绿"。快照表 `decision_context_snapshot` + `decision.context_snapshot_id` 是平台级问责资产。 | 关键洞察 | 本文新增 |
| 八 | **前台从「7 块平铺」重构为「三层一屏」**（平台健康头含全新「上下文供给健康」→ 可筛决策清单 → 单决策问责档案五页签抽屉）。7×7 每格回跳具体供给操作及其状态。 | 前台 | A-§4 |

### 0.3 统一缺陷总表（来自 B，按严重度）

| 编号 | 缺陷 | 分级 | 性质 | 与 A 的关系 |
|---|---|---|---|---|
| **BG-01** | 注入层丢弃已装配的叙事字段（rationale/memories/timeline） | P1 | 真 BUG | **RESOLVED**（T1 `injector.js` 消费 rationale/memories/narrative，clip 截断；BUDGET 用模块常量出厂默认见 §3.3 注） |
| **BG-02** | `OVERRIDES` 边漏接权威表（只写 AGE） | **RESOLVED** | 真 BUG（纯遗漏） | **T3 修复**：`decisionRepo.js:330` 经 `linkDecisions` 落权威表 `decision_relation` + AGE 双写，权威写失败 `.catch` 留痕不阻断（B1–B4） |
| **BG-03** | `DECIDED_ON`/`DERIVED_FROM_EXCEPTION` 外键结构性不可写 | **P0** | 架构偏离 | **RESOLVED**（方案 B 已落地，无新表；`to_id` 无 FK 实测 + 写入点已存在） |
| **BG-04** | 种子数据伪装为运行时产出（看板假绿） | **RESOLVED** | 数据可信度 | **Phase 5 双口径根治**：seed 边 `props.demo=true` 软标记 + `source` 双排除 + 前端虚线；`relation.js:78 runtimeOnly` 不计入供给健康分母，假绿根除 |
| **BG-05** | 装弹后系统性 `EDGE_MISSING` 误报 | **P0** | 逻辑炸弹 | **RESOLVED**（T4 装弹自检闭环 + T7 误报清零：prod 14 场景 0 风险，`hasRealEdgeMissing` 守卫 + BG-03 RESOLVED） |
| **BG-06** | 边写降级无留痕（AGE 不可用静默丢边形态） | P2 | 可观测性 | **RESOLVED**（T2 `edgeWrite.js` mirrorEdge 三重留痕 + fail-open，与 S7 操作级 PROV-O 互补） |
| **BG-07** | L1 用哈希向量，非语义向量 | **RESOLVED** | 有意识设计（非缺陷） | **Q3=② 裁决**：hashVector 零依赖兜底（`embedding.js:1-2` 注释"生产可注入真模型"），真 embedding 另立任务，非目标 §11.4；S2 `status='empty'` 诚实暴露，不伪装成功 |
| **BG-08** | 叙事时间线 / L2 装配 / 决策边 时间基准不一致 | **RESOLVED** | 时间语义 | **Q4=② 已落地**：`DECISION_TIME_BASIS='COALESCE(decided_at,created_at)'` 单一事实源（`timelineSource.js:11`），叙事时间线(:75)/L2装配(:75)/先例列表(`insightService.js:244`)三处排序均引用；时态边(`valid_from/to`)按 Q4=② 延后，非目标 |

### 0.4 建议执行顺序（合并，详见 §6）

```
Phase 0  BG-04  数据可信度隔离（双口径，零 DELETE）        ← 先决定"怎么算绿"
Phase 1  BG-01a 注入层补已装配字段（最低风险最高 ROI）
          BG-01b+BG-08 叙事时间线进注入层 + 时间基准统一
Phase 2  BG-06 边写降级留痕 → BG-02 OVERRIDES 接线
          → BG-05a 装弹自检闸门 → BG-03 结构扩容(待裁决 Q1)
          → BG-03b 写入点补齐 → BG-05b 误报清零
          ───── 以上修复"断链的根因"，无结构变更可一次交付 ─────
Phase 3  A-T1 供给操作规范 → A-T2 schema 迁移(快照)
          → A-T3 装配器 V2 接线 5 模块 → A-T4 快照落库+PROV-O
          → A-T5 分层注入形态
Phase 4  A-T6 前台三层一屏（Layer0 双口径供给健康）
Phase 5  A-T7 真实数据验收闸门（清理 7 条 seed 边走软标记，零 DELETE）
```

每个 Task 一 commit，不做 `git add -A`。

---

## §1 实证诊断：上下文构成逻辑为何「没落地」（统一根因）

### 1.1 断链位置：产物被丢弃

```js
// src/agent/agentLoop.js:24-29
export async function buildContextBlock(task, ctx) {
  const bundle = await assembleContext({ actor, intent, query })
    .catch(() => ({ layers: {}, degraded: true, missing: {}, scopeModel: 'all' }));
  return { block: formatForPrompt(bundle), bundle };   // ← bundle 返回后无任何持久化
}
```

`assembleContext` 全仓仅此一处调用（`grep -rn "assembleContext" src/` 确证）。`bundle` 没有写库、没有 hash、没有关联到后续产生的 `decision` 行。

### 1.2 注入形态：标签列表，不是上下文

```js
// src/context/injector.js:12-22
L1 → layers.L1.map(x => x.title).join('; ')                    // 只有标题，无正文、无字段、无来源
L2 → decisions.map(d => `${d.scenario_id}:${d.disposition}`)   // 只有 场景:处置，无理由/时间/因果
L3 → `执行态(${layers.L3.tasks.length} 在办任务)`               // 只有一个计数
```

模型拿到的是约 5 个分号拼接的短语。文章对比表所说的「传统向量 RAG 只有相关没有因果」——本平台连相关性都很弱（`hashVector` 是确定性哈希指纹，非语义 embedding）。

> **BG-01 同源证据**（B-§2）：装配层 `assembler.js:72` 已 `SELECT ... rationale`、`:76` 已 `retrieveMemory`，但 `injector.js:18-22` 只输出 `scenario:disposition`，`rationale` 与 `memories` 在最后一厘米被丢弃。

### 1.3 五个「造好但未接线」的模块（A 的修复标的）

| 模块 | 已实现能力 | file:line | 当前唯一调用方 | 是否在装配链 |
|---|---|---|---|---|
| `searchPrecedents` | 向量相似先例检索 | `decisionRepo.js:244-253` | 决策写入时的先例边 | ❌ |
| `detectConflicts` | 多源冲突检测（`needs_review` 保留分歧） | `conflict.js:41` | `auditability.js:42`（事后） | ❌ |
| `ruleEngine.check` | DB 化确定性规则 | `ruleEngine.js` | `seed-actions.js:283`（仅 DEAL） | ❌ |
| `buildTimelineRows` | 多源统一时间线 | `insightService.js:105` | 客户 360 页面渲染 | ❌ |
| `trackEntry` | PROV-O 溯源捕获 | `provenance.js` | `decisionRepo.js:115`（仅本体） | ❌ 不覆盖上下文 |

**判定**：装配器 `assembler.js` 的 L1–L4 是四条手写简化查询，绕过了平台五个专业模块。文章 `find_similar_decisions` 语义完全缺失。

### 1.4 数据库实证（生产库 `plm`，2026-09-01 直查）

```
decision 列数: 32   含 context_snapshot? false
上下文快照表: { decision_context_snapshot: null, context_assembly: null }
决策统计: { total: 9, empty_ctx: 8, empty_cond: 4, no_entity: 3 }
边来源: 7/7 全为 seed-script（REFERENCED_PRECEDENT/CAUSED/INFLUENCED/
        DERIVED_FROM_EXCEPTION/DECIDED_ON/ESTABLISHES_FRAME/OVERRIDES 各 1 行）
        → 运行时产出 0 条（BG-04）
溯源条目: 10（仅覆盖决策本体，不覆盖上下文事实）
```

判定块：
- **上下文快照 0 处存在** → 「当时看到了什么」不可回答；
- **`trigger_context` 空率 89%** → 连调用方自报都没填；
- **7 类边 100% seed** → 因果图是摆设，`trace_decision_chain` 查到演示数据；
- **BG-03 加剧**：其中 `DECIDED_ON`/`DERIVED_FROM_EXCEPTION` 在真实运行时**根本写不进权威表**（见 §3.4）。

### 1.5 前台诊断（A-§1.5）

`1682` 行七个平级块，各自成立、合起来无叙事——缺「选定一个决策 → 看它当时用了什么 → 看它连到哪里 → 看它是否站得住」的组织主线。

### 1.6 缺陷因果链（B-§0.1，统一根因视图）

```
装弹已生效（required_dims 有值）
      ↓ 推导
应连边恒含 DECIDED_ON
      ↓ 但
DECIDED_ON 因外键结构写不进权威表        ← BG-03 P0 架构偏离
      ↓ 于是
6 个已装弹场景的每条真实决策 → 系统性 EDGE_MISSING 误报   ← BG-05 P0 逻辑炸弹
      ↓ 而
看板显示"7 类边齐备"，实为种子脚本造的假绿（运行时 0 条） ← BG-04 P0 数据可信度
      ↓ 同时
装配产物被丢弃、叙事字段被注入层丢弃       ← A-§1.1 / BG-01 断链
```

**结论**：A 的「重新设计」要成立，必须先修 B 的 P0（BG-03/BG-04/BG-05）；A 的「快照落库」同时是 BG-04 的根治手段。二者不可分割，故合并为单一文档。

---

## §2 三篇文章可借鉴点 → 本平台逐条判定（外部输入分析）

| # | 文章要点 | 出处 | 本平台现状 | 判定 |
|---|---|---|---|---|
| 1 | 决策=图一等节点，`record_decision` 记场景/推理/结果/置信度 | 全三篇 | `crm.decision` 7 点全物化 + `confidence` 列已补 | ✅ 已具备 |
| 2 | `trace_decision_chain` 上溯因果 | 文1 §01 | `decisionTrace.traceDecision` 已实现 | ✅ 已具备（但数据是 seed/BG-04） |
| 3 | `analyze_decision_impact` 下溯影响 | 文1 §01 | `getImpact` 已实现 | ✅ 已具备 |
| 4 | **`find_similar_decisions` 找先例** | 文1 §01 | `searchPrecedents` 已实现但不在装配链 | 🔴 **采纳：接线（S2 决策史检索）** |
| 5 | **`check_decision_rules` 规则校验** | 文1 §01 | `ruleEngine` 已实现但不在装配链 | 🔴 **采纳：接线（S4 规则校验）** |
| 6 | **「Agent 看到了哪些事实」须落库** | 文3 PART 03 | 完全缺失 | 🔴 **采纳：核心（快照落库，§4.3）** |
| 7 | **PROV-O 覆盖事实来源，不只覆盖结论** | 文3 PART 08 | 仅覆盖决策本体 | 🔴 **采纳：操作级 provenance（S7）** |
| 8 | **冲突检测优于静默覆盖，保留分歧** | 文2 §3、文3 PART 09 | `detectConflicts` 仅事后审计 | 🔴 **采纳：装配时前置（S3 冲突探测）** |
| 9 | 确定性计算不烧 token | 文2 §⚡ | 七维校验/规则引擎已是确定性 | ✅ 已具备，显式标注 |
| 10 | 四个验收问题（原因/来源/冲突/影响） | 文3 LAST | `computeAudit4q` 已实现 | ✅ 已具备，前台升级为主视图 |
| 11 | 图浏览器（React+Sigma.js 力导向） | 文2 §⚡3 | Cytoscape 已在 `#true-graph` | ✅ 已具备，前台重排 |
| 12 | Rete / Datalog 推理引擎 | 文2 §⚡2 | `decision_rule` 表 + 简单 evaluate | ⚪ 不采纳（§10-1） |
| 13 | Neo4j / FalkorDB / Qdrant 外挂 | 文2 §⚡1 | PG + pgvector + AGE 镜像 | ⚪ 不采纳（§10-2） |
| 14 | Retraction / Purge（GDPR 擦除） | 文2 §⚡3 | 铁律：绝对禁止 DELETE | ⚪ 不采纳（§10-3） |
| 15 | 引入 `semantica` Python 包 | 全三篇 | Node 22 + ESM 全栈 | ⚪ 不采纳（§10-4） |

**净新增 = 5 项（#4/#5/#6/#7/#8），全部是「接线 + 落库」，无一项新造算法。** 注意 #6 快照落库与 BG-04 互锁（§0.2-七）。

---

## §3 缺陷清单 BG-01 ~ BG-08（根因审计，来自 B）

> 判定方法：**三问法**（规范是否要求 / 实现是否达成 / 未达成是否留痕）+ 生产库实测。

### 3.1 BG-01｜注入层丢弃已装配的叙事字段（P1 · 真 BUG）

**现象**：L2 历史决策只输出 `OPP_QUALIFY:approved` 键值对，无依据、无时间、无因果；`rationale` 与 `memories` 装配到 bundle 后在注入层被丢弃（A-§1.2 同源）。

**证据**（三问）：Q-A 规范要求（装配层已显式取数）→ Q-B 未达成（取到未消费）→ Q-C 无留痕。

```js
// src/context/assembler.js:72 已 SELECT rationale；:76 已 retrieveMemory
// src/context/injector.js:18-22 只输出 scenario:disposition / title
```

**影响**：`rationale` 是决策问责核心字段，不注入则模型侧问责信息不可见；直接决定后续所有 AI 能力的上下文质量上限。

**修复**：BG-01a 仅消费已装配字段（`rationale` 截断 + `memories` 块 + `narrative` 时间线）；`clip()` 纯函数。T1 已落地（`injector.js:45-68`，验收 A1–A5 通过）。BG-01b（叙事时间线进注入层）见 §3.8 / §9。

> **BUDGET 配置化说明（2026-09-01 复核）**：注入层截断预算（`RATIONALE_MAX=120` / `MEMORY_MAX=100` / `MEMORY_TOP=3` / `TIMELINE_TOP=8`）当前用模块常量出厂默认，**未接 `config_store['context-budget']`**。理由：注入截断属轻量**技术**阈值（防 token 膨胀），非**业务**阈值（BANTCC 达标线/阶段停留/拜访频率等）；若强行走 `config_store` 须将 `injector.formatForPrompt` 改异步，连锁 `assembleContextV2` 调用，收益不抵风险。如确需运行期可调，单独立项接 config_store（当前不强制，不视为铁律违约）。

**验收**：A1 输出含 `rationale`；A2 超长截断以 `…` 结尾不抛；A3 null 时不输出 `｜依据:`、无 `undefined`；A4 `memories` 空不输出块；A5 现有 `test/context.test.js` 全绿。

### 3.2 BG-02｜`OVERRIDES` 边漏接权威表（P1 · 真 BUG）

**现象**：翻案时 `OVERRIDES` 只写 AGE 镜像，PG 权威表 `decision_relation` 无记录 → 权威读路径永远看不到。

**证据**：`decisionRepo.js:307` 用 `addEdge()` only，其余四类边均走统一双写入口 `linkDecisions()`（`:157/:173/:176/:179`）。`OVERRIDES` 两端都是 decision，外键完全允许——**纯遗漏，非结构限制**（与 BG-03 分界线）。

**影响**：`listTypedEdges`/`closure`/`traceRootCause`/`routes.js:2056` 全读权威表 → 翻案链路中断；`governance`/`decision_history` 两维恒缺证据。

**修复**：`:305-308` 改调 `linkDecisions(...,'OVERRIDES',{source:'engine',props:{reason}})` 并留痕（对齐 `:162-163`）。`serves_dimension` 由 `primaryDimension('OVERRIDES')` 自动取 `governance`。

**验收**：B1 权威表有 1 行且 `serves_dimension='governance'`；B2 `listTypedEdges` 双向返回；B3 幂等（UNIQUE）；B4 AGE 不可用主流程不抛。

### 3.3 BG-03｜`DECIDED_ON` / `DERIVED_FROM_EXCEPTION` 外键结构性不可写（**P0 · 架构偏离 · 已 RESOLVED 2026-09-01**）

**现象（原始诊断）**：7 类边中 2 类**任何情况下都写不进权威表**——不是漏写，是表结构不允许。

> **2026-09-01 复核结论：本项已 RESOLVED，文档此前状态过时。** 实证：
> - `crm.decision_relation` 当前**仅 `from_id` 有 FK**（`decision_relation_from_id_fkey → decision(decision_id)`），**`to_id` 无外键**（pg_constraint 直查确认）。原证据#2「两端 REFERENCES decision」与当前 schema 不符——`to_id` FK 已不存在。
> - 写入点已落地：`decisionRepo.js:117-126` 写 `DECIDED_ON`（decision→entity）、`:195-209` 写 `DERIVED_FROM_EXCEPTION`（decision→exception），均经 `relation.linkDecisions` 落 `decision_relation`（`to_id=实体/异常 UUID`，无 FK 约束）。
> - `src/decision/writableEdges.js:18/20` 显式声明两类边可写。
> - 事务回滚验证（plm_test，零污染）：以 `linkDecisions` 同源 SQL 落实体 `to_id` 边 → 决策视角得 2 边；实体/异常视角经 `from_id OR to_id` 读路径均可查回。**回路通。**
> - **方案 A（新表）弃用**：无正确性必需；方案 B 已满足（读路径本就 `from_id OR to_id`，无需 UNION 改造）。

**证据链**：
1. 规范侧：这两类边靶子不是 decision（`edgeDimensionSpec.js:31,33`：`decision->entity` / `decision->exception`）。
2. 实现侧：`schema.sql:492-496` 两端 `REFERENCES crm.decision(decision_id)`——靶子钉死为 decision，**枚举允许、外键拒绝**，表自我矛盾。
3. 已批准设计被偏离：`docs/2026-08-30-decision-drillthrough-design.md:105/:114/:175` 明确要求 `to_particle` 列；`schema.sql` **无此列**。
4. 实现方注释自我承认偏离（`decisionRepo.js:155-156,181`）但未回告评审。
5. 判定：符合"架构偏离"且完全静默（连 `recordFailure` 的 trace 都不产生）。

> 已核实：`ageGraph.addEdge` 支持 `to` 为顶点对象（`ageGraph.js:140-143`），故 AGE 侧确实写了；缺陷严格限定在 **PG 权威表**侧。

**影响**：权威表 2/7 边永不可写 → `identity`/`structure`/`operational_state` 三维永远取不到边证据；直接引爆 BG-05。

**修复（已落地 = 方案 B，无新表；§8-Q1 同步结案）**：
- 原方案 A（新建 `crm.decision_entity_relation` + 4 处读路径 UNION）**弃用**——`to_id` 无 FK 前提使新表无正确性必需，且读路径本就 `from_id OR to_id` 兼容实体 `to_id`，UNION 改造纯属过度设计。
- 方案 B 实际状态：`decision_relation` `to_id` **本就无 FK**（非"放宽"，是 schema 现状），实体/异常 UUID 可直写；写入点已在 `decisionRepo.js` 落地（见下）。无需补应用层存在性守卫（读路径不把 `to_id` 当 decision 递归）。

**写入点补齐（BG-03b，已落地）**：`decisionRepo.js:117-126`（DECIDED_ON）/ `:195-209`（DERIVED_FROM_EXCEPTION）在 AGE 写后补权威写，复用既有 `relation.linkDecisions`（单一写入口铁律，未新增 `linkEntity`）。

**验收（已满足）**：C1 ✅ 创建决策后权威侧可查 `DECIDED_ON`；C2 ✅ 可查 `DERIVED_FROM_EXCEPTION`；C3 ✅ `listTypedEdges`（`from_id OR to_id`）7 类全可达；C5 ✅ AGE 不可用权威写不受影响（`linkDecisions` 内部降级）；C6 ✅ 无新表迁移（零 DDL）。C4（真实写入后 `required_missing=[]`）对**新建决策**成立；prod 6 条修复前陈旧决策仍缺实体边，需按需回溯（见 §8-Q1 备注）。

### 3.4 BG-04｜种子数据伪装为运行时产出（**P0 · 数据可信度**）

**现象**：边看板显示"7 类边齐备"，但运行时产出 0 条，全为种子脚本。

**证据**：`seed-decision-network.mjs:88` 写 `source='seed-script'`；生产库 `SELECT count(*) FROM crm.decision_relation WHERE source<>'seed-script'` → 0。附加语义错误：种子 `DECIDED_ON` 因 FK 强制 `to_id` 被迫指向 decision 而非粒子——业务语义错但看板显 present（BG-03 下游污染）。

**影响**：假绿掩盖 BG-03；误导验收（前两轮曾据"7 类边各 1 行"误判边体系已通）；与 BG-05 叠加致系统自相矛盾。

**修复（约束：绝对禁止 DELETE，只做口径隔离）**：
1. 新增 `RUNTIME_SOURCES = source NOT IN ('seed-script','demo','import-test')` 常量（`src/decision/edgeSource.js` 单一事实源）；
2. `listTypedEdges`/`getTypedEdges` 增 `{ runtimeOnly=false }` 选项（默认 false，兼容存量）；
3. 权威读路径默认切运行时口径（`traceRootCause.js:126`/`attribution.js:80`）；
4. 巡检卡/边看板**双口径**：`运行时边 N / 演示边 M`，演示边虚线渲染（`routes.js:2056` + Cytoscape）；
5. `closure.js:96` D2 判定改运行时口径（否则演示数据即判闭环成立）；
6. 只读核验脚本 `tmp/probe_edges2.mjs` 显式区分口径。

> **与 A 的互锁（§0.2-七）**：A 的「上下文快照落库」(`decision_context_snapshot`) 是根治手段——快照记录"本次装配真实供给了什么"，让"供给 N/7"指标来自运行时证据而非 seed 边。BG-04 的口径隔离是**止血**，快照落库是**治本**，两阶段都做。

**验收**：D1 `runtimeOnly:true` 纯种子环境返回 `[]`；D2 不传时行为不变（无回归）；D3 展示 `运行时 0 / 演示 7` 不混计；D4 造一条运行时边后计数 +1；D5 全流程零 DELETE。

### 3.5 BG-05｜装弹后系统性 `EDGE_MISSING` 误报（**P0 · 逻辑炸弹**）

**现象**：6 个已装弹场景（含 `identity`/`structure`）的每条真实决策都判 `EDGE_MISSING` 且永不可消除。

**证据链**：`seed-seven-dim.mjs:47-49` 装弹已完成（CLIENT_STRATEGY 等 7 维含 identity+structure）→ `attribution.js:20-31` `requiredEdgesForDims(['identity','structure'])=[DECIDED_ON]` → `attribution.js:49` `required_missing` 恒含 `DECIDED_ON`（因 BG-03 不可写）→ `rootCauseClassifier.js:25-31` 返回 `EDGE_MISSING`。放大路径：`retro.js:84`/`autoSuggest.js:38`/`seed-actions.js:100,1060` 均消费 `edge_compliance` → 误报污染复盘/校准/回执三条下游。

**修复**：
- **BG-05a（可先于 BG-03）**：新增可写边集合单一事实源 `WRITABLE_EDGES.PG_AUTHORITY`（随 BG-02/BG-03 递增）；S20 七维页保存 `required_dims` 时自检 `requiredEdgesForDims(dims) ⊆ WRITABLE_EDGES` 否→拒绝保存并提示。提供只读存量核验脚本输出风险台账。
- **BG-05b（依赖 BG-03）**：BG-03 落地后误报自然消除，无需改装弹内容。若 BG-03 延期，临时降级止血：将 `identity`/`structure` 从 `on_missing` 降为 `'info'` 并文档挂账（需单独批准）。

**验收**：E1 自检脚本对当前库输出告警；E2 BG-03 未完成时保存被拒；E3 完成后通过；E4 新建真实决策不返 `EDGE_MISSING`；E5 下游不复现批量误报；E6 降级时巡检卡标注"暂不判缺"。

### 3.6 BG-06｜边写降级无留痕（P2 · 可观测性）

**现象**：`decisionRepo.js:106/:188` `addEdge(...).catch(()=>{})` 丢弃返回值，无法区分"降级跳过"与"真失败"。同文件其它失败点均留痕（`:117-119`/`:162-163`），唯独这两处。

**判定**：数据不丢（`involved_entities` 在 decision 行），丢的是"边形态"与"降级可见性"。定 P2。与 A 的 S7 操作级 PROV-O 互补。

**修复**：新增 `mirrorEdge(relType,from,to,props)`（AGE 不可用时 emit `decision-graph-degraded`）；三处改调，`.catch` 保留不吞返回值。

**验收**：F1 AGE 不可用 emit 事件；F2 写失败 emit `decision-graph-sync-failed`；F3 三处主流程不阻断；F4 `test/decision/*.test.js` 全绿。

### 3.7 BG-07｜L1 用哈希向量，非语义向量（**RESOLVED · Q3=② 有意识设计，embedding 换真另立任务**）

`embedding.js:1-2` 注释自陈"确定性哈希向量，零外部依赖"；`assembler.js:43` 用 `hashVector(q)`，语义检索实质无效，真实生效的是 `:50-62` 精确名匹配兜底。影响：无法支撑"张总上月提了什么顾虑"式语义查询。**三问法判定"规范是否要求"存疑**（属未完成集成非缺陷），建议另立任务注入 SiliconFlow embedding（维度与 `vector(384)` 对齐），保留 `hashVector` 作降级路径。对应 A 的 S2 先例检索质量受限（同根）。

### 3.8 BG-08｜叙事时间线与因果图时间基准不一致（P2 · **RESOLVED 2026-09-01**，与 BG-01b 强耦合）

**现象**：叙事时间线（`insightService.js:262` 用 `created_at`）/ L2 装配（`assembler.js:73` 用 `decided_at DESC`）/ 决策边（`schema.sql:501` 仅 `created_at`）三者时间列语义分离（记录创建 vs 业务发生）。HITL 场景（`confirmDecision` 重写 `decided_at`）二者必然分离；生产库 12 条决策 `gap_hours` 全 0（均未走 HITL，缺陷未暴露非不存在）。

**判定**：P2，但若先做叙事进注入层（BG-01b）而不统一基准，会把不一致固化进模型上下文，后续修正成本更高 → 随 BG-01b 一并处理。

**修复**：① 统一时间基准 `COALESCE(decided_at, created_at)`；② 边升时态边（`valid_from/valid_to`，与 BG-03 结构扩容合并窗口）；③ 一致性断言（构造 HITL 决策断言排序一致）。

**验收**：F1 排序键为 `COALESCE`；F2 `created_at` 早于 `decided_at` 24h 排在同批更后；F3 时间线与 L2 顺序一致；F4 现有测试全绿。

---

## §4 后台架构：7 维 × 供给操作(S1–S7) × 7 边 + 快照落库（战略解法）

### 4.0 本架构对 BG 缺陷的依赖（合并后关键约束）

| 架构构件 | 依赖的 BG 修复 | 说明 |
|---|---|---|
| 7 维（校验侧） | BG-05a 装弹自检 | 装弹含不可写边时须拒绝，否则误报 |
| 7 边（结构侧） | BG-02、BG-03、BG-04 | 2/7 边须可写（BG-03）、OVERRIDES 须接权威表（BG-02）、边须区分运行时/演示（BG-04） |
| S1–S7 供给操作 | BG-01a/b、BG-08 | 注入形态须消费叙事（BG-01a）、时间线须进装配（BG-01b + BG-08） |
| 快照落库 | BG-04（根治） | 快照是"真实供给"的运行时证据，取代 seed 假绿 |

**结论**：Phase 2（BG 修复）必须先于 Phase 3（供给架构）完成；否则 S1–S7 跑在假绿/误报之上。

### 4.1 三轴正交：校验主题 × 供给机制 × 结构类型

| 轴 | 回答 | 单一事实源 | 状态 |
|---|---|---|---|
| **校验侧** 7 维 | 上下文齐不齐 | `sevenDimensions/constants.js` | ✅ 已有 |
| **结构侧** 7 边 | 因果怎么连 | `edgeDimensionSpec.js` | ⚠️ 数据是 seed / 2 类不可写（BG-03/04） |
| **供给侧** S1–S7 供给操作 | 这次装配跑了哪些操作、返回什么、状态如何 | 新建 `src/context/supplySpec.js` | 🔴 缺失 |

**供给操作定义（按真实运行模块/数据源命名，与维度多对多）**：

| 操作 | 模块 | 服务维度 | 产生边 | 类别 |
|---|---|---|---|---|
| **S1** 实体与结构取 | `retrieveEntityProfile`+`particles` | identity, **structure** | DECIDED_ON | 事实 |
| **S2** 决策史检索 | `searchPrecedents` | decision_history | REFERENCED_PRECEDENT | 事实 |
| **S3** 冲突探测 | `detectConflicts` | **semantics**, governance | （冲突证据） | 事实 |
| **S4** 规则校验 | `ruleEngine.check` | governance | rule_hit | 确定性 |
| **S5** 时间线构建 | `buildTimelineRows`+`loadTimelineSources` | time_config, **operational_state** | CAUSED/INFLUENCED/DERIVED_FROM_EXCEPTION | 解释 |
| **S6** 运行态取 | tasks+agent_health+回款/竞品 | operational_state | — | 事实 |
| **S7** 溯源捕获 | `trackEntry` | 跨全部（meta） | PROV-O 条目 | 确定性 |

设计要点：
1. **事实/解释二分**：S1/S2/S3/S6 事实（可复算、必须可溯源），S5 解释（可被后发条目覆盖，格式预留 `superseded_by`），S4/S7 确定性（不烧 token）。`supplySpec.js` 每操作带 `kind` 标记。
2. **每维至少一操作供给**，`validateSupplySpec()` 强制校验（悬空操作/悬空维/维未覆盖三类错误）。
3. **操作↔维度绑定可配置**：走 `config_store['seven-dim'].supply_bindings`，与既有 `edge_bindings` 并列（阈值配置化铁律）。校验失败 fail-safe 回退默认，不阻断业务。

### 4.2 统一操作信封（Supply Envelope）

每操作返回同一形状，快照可聚合、前台可渲染：

```js
{
  op: 'S5', name: '时间线构建', serves_dims: ['time_config','operational_state'],
  kind: 'narrative',
  status: 'hit',              // hit | empty | degraded | timeout | blocked
  items: [ /* 操作内容，形状由操作自定 */ ],
  provenance: { source: 'insightService.buildTimelineRows', actor, ts, hash },
  cost_ms: 41, note: null
}
```

**铁律：任一操作失败不得阻断装配**。沿用 `assembler.js:103-106` try/catch 降级，但把"静默 `missing`"升级为"带 `note` 的结构化 `status`"——对齐文章「不静默」，也对齐 BG-06 的留痕要求。

### 4.3 快照落库（根治 BG-04，§0.2-七）

```sql
CREATE TABLE IF NOT EXISTS crm.decision_context_snapshot (
  snapshot_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assembly_id     UUID NOT NULL,
  decision_id     UUID REFERENCES crm.decision(decision_id),
  tenant_id       TEXT NOT NULL DEFAULT 'system',
  actor           TEXT, scenario_id TEXT, query_text TEXT,
  ops             JSONB NOT NULL,        -- S1–S7 操作信封数组
  dim_coverage    JSONB NOT NULL,        -- 7 维 × status（供给侧视图）
  supplied_dims   INT NOT NULL DEFAULT 0,
  degraded        BOOLEAN NOT NULL DEFAULT FALSE,
  prompt_block    TEXT, prompt_hash TEXT, token_est INT, cost_ms INT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 独立 ALTER 段（迁移铁律：CREATE TABLE IF NOT EXISTS 不补列）
ALTER TABLE crm.decision ADD COLUMN IF NOT EXISTS context_snapshot_id UUID;
```

快照是平台级问责资产：**`supplied_dims` 来自运行时真实供给，非 seed 边**——直接回答 BG-04「怎么算绿」。

### 4.4 装配即审计：操作级 PROV-O（对齐 S7 + BG-06）

每次装配后，逐操作调 `trackEntry`（`provenance.js`）：

```js
trackEntry({ entry_type: 'context_supply', actor, decision_id,
  payload: { assembly_id, op: 'S5', status, item_count, provenance } });
```

AGE 不可用等降级路径 emit `decision-graph-degraded`（BG-06 的 `mirrorEdge`）而非静默。

### 4.5 装配时序（assembleContextV2）

```
① assembleContextV2({ actor, scenario_id, query, entities })
     ├─ S1 实体与结构取  ─┐
     ├─ S2 决策史检索     │
     ├─ S3 冲突探测       │ 并行（Promise.allSettled，逐操作独立超时 200ms）
     ├─ S4 规则校验       │
     ├─ S5 时间线构建     │
     ├─ S6 运行态取       │
     └─ S7 溯源捕获      ─┘
  ↓
② computeDimCoverage(ops)          → 7 维 × status（供给侧视图）
  ↓
③ formatForPromptV2(ops)           → 分层文本块（事实/叙事/规则/先例四段，非标签列表；BG-01a/b 形态）
  ↓
④ persistSnapshot()                → crm.decision_context_snapshot（含 prompt_hash）
  ↓
⑤ trackEntry × 7                   → PROV-O 操作条目
```

### 4.6 注入形态（formatForPromptV2，承接 BG-01a/b + A-§4.3）

```text
【上下文 · 快照 <snapshot_id 前8位>】

▸ 治理边界（S4 规则校验）
  角色: 大客户销售 | 数据范围: 仅本人商机/客户读写 | 自主边界: NORMAL 以下可自主
  命中规则: stage_forward_only(pass) / lost_requires_reason(pass)

▸ 事实（S1 实体与结构取，稳定，可复算）
  客户 银通包装(a1111111) | 商机 彩盒打样询盘 | 阶段 lead | 预算 ¥120,000
  BANTCC: B✓ A✓ N✓ T✗ C✗ C✗（4/6 未达标）

▸ 冲突事实（S3 冲突探测，保留分歧，未裁决 2 条）
  ⚠ 联系人手机: CRM=138**** / 合同=139****（两源未裁决，勿假定单一真值）

▸ 故事时间线（S5 时间线构建，最近 8 条，倒序，可被后发事实覆盖，时间基准 COALESCE(decided_at,created_at)）
  09-01 王川 拜访 «生产副总质疑交付周期»            [source: visit_log#412]
  08-28 系统 报价发送 «三级报价 38/36/34 万»        [source: quotation#88]

▸ 相似先例（S2 决策史检索，top-3，带失效标记）
  0.87 QUOTE_PRICING → APPROVE «目标价 38 万、底价 34 万» ⚠已被 OVERRIDES
  0.72 SIGN_RISK → ESCALATE «反对者出现，需求变更 <10%»
```

设计要点：每条带来源 id（`[source: ...]`，否则不可审计）；先例带 `⚠已被 OVERRIDES`（化解"图太硬"）；冲突显式呈现且明说"勿假定单一真值"（对齐"保留分歧优于静默覆盖"）；窗口配置化（S5 默认 20 条、S2 默认 top-3、`minSimilarity` 默认 0.6，走 `config_store['context-assembly']`）。

---

## §5 前台设计：三层一屏（来自 A-§4）

### 5.1 信息架构

```
┌─────────────────────────────────────────────────────────────────┐
│ Layer 0  平台问责健康（常驻头：①可审计性 N/4 ②上下文供给 N/7 ★ ③三闭环）│
├─────────────────────────────────────────────────────────────────┤
│ Layer 1  决策清单（可筛可排，默认按「问题严重度」倒序）             │
│  决策 | 场景 | 处置 | 置信度 | 四问 N/4 | 供给 N/7 | 结果 | 操作   │
├─────────────────────────────────────────────────────────────────┤
│ Layer 2  单决策问责档案（右侧抽屉，五页签）                        │
│  ① 决策卡 ② 当时的上下文 ★核心 ③ 因果链 ④ 溯源链 ⑤ 7×7 巡检      │
└─────────────────────────────────────────────────────────────────┘
```

被移出主视图：#tasklist→`/my-todo`；#l2-feedback→Layer2「决策卡」行内动作（过第 0 闸 + HITL）。

### 5.2 Layer 0：上下文供给健康（**采用 BG-04 双口径**，避免重复假绿）

`上下文供给 N/7` 回答「决策当时看没看够」。渲染 7 色块横条，颜色映射操作 status（`hit→--ok`/`degraded→--warn`/`empty→--mut`/`timeout→--err`/`blocked→--ac`，零硬编码）。

**关键**：Layer 0 的「边齐备」指示与 `#true-graph` 边看板**统一采用 BG-04 双口径**（运行时边 N / 演示边 M），演示边虚线、不计入供给健康分母——否则会重演"假绿"。点击任一维 → Layer 1 筛出该维供给不足决策（平台指标直达问题决策的唯一路径）。

### 5.3 Layer 2 页签②「当时的上下文」（文章核心命题落地）

```
快照 3f8a1c22  装配耗时 148ms  估算 1,240 token  哈希 ✓ 完整
────────────────────────────────────────────────────────────
▾ S1 实体与结构取   [identity,structure]      ● hit      2 项   12ms
    银通包装 (a1111111-…101)  ← 来源: particles#a1111111 / 08-29 采集
▾ S3 冲突探测        [semantics,governance]     ◐ 2 未裁决  38ms
    ⚠ 联系人手机  CRM=138****(08-20)  合同=139****(08-28)   [裁决]
▾ S2 决策史检索      [decision_history] ○ empty   9ms
    note: 该场景历史决策不足（<3 条），无法构成先例基线
▸ S5 时间线构建      [time_config,operational_state]   ● hit      8 项   41ms
▸ S4 规则校验        [governance]    ● hit      规则 2 命中 0 拦截   6ms
────────────────────────────────────────────────────────────
▾ 逐字 Prompt 原文（SHA-256 校验通过）
    【上下文 · 快照 3f8a1c22】…
```

要点：逐字 prompt 原文常驻可展开（文章「决策依据不能重新生成」）；hash 校验徽章（篡改显 `✗ 已篡改`）；每条 item 带来源与采集时间可下钻；冲突条目带 `[裁决]` 行内动作（走第 0 闸 + HITL，零信任）。

### 5.4 页签⑤ 7×7 巡检 → 回跳供给操作（闭环）

页签⑤ 的 7×7 每一格可回跳页签② 的对应供给操作——「校验侧 ↔ 供给侧」闭环。今天 7×7 标红后是死胡同。边相关格回跳时同步显示 BG-04 双口径（该边运行时/演示计数）。

---

## §6 实施计划（合并 T 序列，每 Task 一 commit）

### Phase 0 — 数据可信度隔离（P0 先行）

| Task | 内容 | 关联 | 验收 |
|---|---|---|---|
| **T0** | 边来源口径隔离：`edgeSource.js` + `listTypedEdges({runtimeOnly})` + 双口径展示 + 零 DELETE | BG-04 | D1–D5 |

### Phase 1 — 注入层接线（P1/P2）

| Task | 内容 | 关联 | 验收 |
|---|---|---|---|
| **T1** | BG-01a 注入层消费 `rationale`/`memories`（`clip`） | BG-01 | A1–A5 ✅ |
| **T8** | BG-01b 叙事时间线进注入层 + BG-08 时间基准统一 `COALESCE` | BG-01b/BG-08 | G1–G5/F1–F4 ✅ |

### Phase 2 — 边完整性（P0/P1/P2，修复断链根因）

| Task | 内容 | 关联 | 验收 |
|---|---|---|---|
| **T2** | BG-06 `mirrorEdge` 留痕（三重留痕+fail-open） | BG-06 | F1–F4 ✅ |
| **T3** | BG-02 `OVERRIDES` 接权威表 `linkDecisions` | BG-02 | B1–B4 | ✅ |
| **T4** | BG-05a `WRITABLE_EDGES` + S20 装弹自检闸门 + 只读风险台账脚本(`scripts/probe-edge-writability.mjs`) | BG-05a | E1–E2 ✅ |
| **T5** | BG-03 结构扩容（**已结案：弃用新表，方案 B 已落地**） | BG-03 | C1–C6 ✅ |
| **T6** | BG-03b 写入点补齐（`decisionRepo.js:117-209` 已落地 DECIDED_ON/DERIVED_FROM_EXCEPTION） | BG-03b | C1–C2 ✅ |
| **T7** | BG-05b 误报清零（BG-03 RESOLVED + `hasRealEdgeMissing` 守卫，自然消除） | BG-05b | E3–E6 ✅ |

### Phase 3 — 供给架构（战略解法）

| Task | 内容 | 关联 | 验收 |
|---|---|---|---|
| **A-T1** | 供给操作规范 `supplySpec.js`（S1–S7 + `validateSupplySpec` + 配置覆盖 fail-safe） | §4.1 | 悬空操作/悬空维/维未覆盖 3 类错误 |
| **A-T2** | schema 迁移（独立 `CREATE TABLE decision_context_snapshot` + 独立 `ALTER ... ADD COLUMN context_snapshot_id`） | §4.3 | 幂等，不补列铁律 |
| **A-T3** | `assembleContextV2` 接线 5 模块 + `Promise.allSettled` + 逐操作 200ms 超时 | §4.5 | 5 态（hit/empty/degraded/timeout/blocked）任一抛错不崩 |
| **A-T4** | `snapshotStore` 落库 + `prompt_hash` + S7 操作级 PROV-O（放开 `entry_type`） | §4.3/4.4 | 落库→读回→hash 一致；篡改返 TAMPERED |
| **A-T5** | `formatForPromptV2` 分层注入（事实/叙事/规则/先例四段） | §4.6 | 输出含 rationale/时间线/先例/规则 |

### Phase 4 — 前台三层一屏

| Task | 内容 | 关联 | 验收 |
|---|---|---|---|
| **A-T6** | `sales-decision-monitor.html` 重构（1682→≤1200 行）：Layer0 双口径供给健康 / Layer1 清单 / Layer2 五页签（含页签②当时的上下文 + 页签⑤回跳） | §5 | 三层一屏；7×7 回跳；色值全走 tokens.css |

### Phase 5 — 真实数据验收（闸门）

| Task | 内容 | 关联 | 验收 |
|---|---|---|---|
| **A-T7** | 清理 7 条 seed 边走 `props.demo=true` 软标记（**零 DELETE**）+ 跑真实场景验证回路真正通 | BG-04/A-§7 | 运行时边计数反映真实；四问可答；无 EDGE_MISSING 误报 |

**执行顺序铁律**：Phase 0→1→2 必须先于 Phase 3（§4.0 依赖）；Phase 5 为验收闸门，未过不视为完成。

---

## §7 验收口径（合并）

### 7.1 四问验收（文章核心，来自 A-§7）

| 问 | 通过条件 |
|---|---|
| Q1 原因是否充分 | `dim_coverage` 中 supplied_dims ≥ 5/7（S2 冷启动期合法 empty，S3 无冲突合法 empty） |
| Q2 能否追溯到源头 | PROV-O 链 `chainStatus=OK` 且**覆盖上下文操作**（今天只覆盖决策本体） |
| Q3 有无未处理冲突 | `conflict_status` 非 `unresolved`（保留分歧须显式 `needs_review`，非静默覆盖） |
| Q4 影响是否评估 | `impact_status` 非 `unassessed` |

### 7.2 量化验收（合并 A-§7 + B-§11）

| 指标 | 目标 |
|---|---|
| 上下文快照落库率 | 100%（每次装配产生 `decision_context_snapshot`） |
| `supplied_dims` | ≥ 5/7（冷启动期 S2 合法 empty） |
| 操作级 PROV-O 条目数 | ≥ 7 × 决策数 |
| 装配耗时 P95 | ≤ 400ms（7 操作并行，单操作超时 200ms） |
| 运行时边计数 | 真实反映（无 seed 伪装，BG-04 双口径） |
| `EDGE_MISSING` 误报 | 0（BG-05b 后） |
| 全量测试基线 | 398/398 绿（修复前记录；禁止并发两 vitest；真回归=失败文件单独小批量重跑仍红） |

### 7.3 生产库 vs 测试库双态（B-§11.3）

`vitest` 连 `plm_test`，裸 `node`/服务连生产库 `plm`。**测试全绿 ≠ 生产可用**。Phase 2 含 DDL（T5）完成后须用 `information_schema` 直查生产库确认已应用；滞后时补跑 `PGDATABASE=plm node db/migrate.js`（幂等，属生产写操作，需用户授权）。

---

## §8 待裁决项（合并，实施前必须闭环）

| # | 问题 | 选项 | 建议 |
|---|---|---|---|
| **Q1** | BG-03 结构扩容方案 | A 新建 `decision_entity_relation` / B 复用 `decision_relation`（`to_id` 无 FK，实体可写） | **已落地=方案 B**（代码已实现，无新表；原推荐 A 因 `to_id` 无 FK 前提失效而弃用）。**2026-09-01 backfill 已执行**：prod 6 条陈旧决策补齐 11 条运行时 `DECIDED_ON` 边（source='backfill'，零 DELETE，幂等），验证 `d2222222` 实体视角可查 4 决策；双口径 demo=7 不污染运行时分母 |
| **Q2** | BG-01b 叙事 scope 来源 | ① `intent.account_id`/`entity_id` 显式携带 ② 从 `actor` scope 反查 ③ 两者结合缺失则不注入 | **③** |
| **Q3** | embedding 是否纳入（BG-07 / S2 先例质量） | ① 纳入换 SiliconFlow ② 另立任务 | **②**——三问法"规范是否要求"存疑，混入拉长关键路径 |
| **Q4** | BG-08 时间基准 / 时态边 | ① 随 BG-01b 一并（含时态边）② 仅基准统一（时态边延后）③ 不纳入 | **② 已落地**（基准统一：`DECISION_TIME_BASIS` 三处引用闭环；时态边 `valid_from/to` 按决策延后，非目标） |
| **Q5** | seed 边软标记口径（BG-04 / A 前台） | 走 `props.demo=true` + 前台默认过滤（可开关），禁止 DELETE | **采纳**——与"绝对禁止 DELETE"铁律一致 |
| **Q6** | 快照多租户隔离 | sysadmin 跨租户读，普通角色仅本租户 | **采纳** |
| **Q7** | 调试端点鉴权（文档旧名 `/api/context/assemble`；代码现行名 `/api/decision/:id/context-reassemble` + 只读 `/api/decision/:id/context-snapshot`） | 仅 sysadmin 可调（调试用），普通用户走只读快照 | **已落地**（routes.js:2073 roleIsAdmin 闸 + :2081 惰性装配 admin 触发 + :2108 reassemble 403；2026-09-01 冒烟 5/5：普通 403 / 只读 200 / admin 200 / 匿名 401×2） |

---

## §9 风险（合并）

| 风险 | 后果 | 缓解 |
|---|---|---|
| BG-03 架构偏离未被发现（长期静默） | 2/7 边永不可写、巡检三维恒缺证据 | Phase 2 T5 结构扩容 + T0 双口径暴露 |
| 假绿误导验收（BG-04） | 边体系"已通"误判 | T0 双口径 + Phase 5 真实数据闸门 |
| 误报污染下游（BG-05） | retro/autoSuggest/回执批量 EDGE_MISSING | T4 装弹自检 + T7 清零 |
| 装配耗时上升（7 操作并行 + 向量 + 冲突） | Agent 响应变慢 | 并行 + 逐操作 200ms 超时 + token 预算上限 |
| `hashVector` 非真 embedding（S2/BG-07） | 先例召回不准 | 不解决 embedding；S2 `status='empty'` 诚实暴露，不伪装成功 |
| DDL 生产库双态（T5） | 测试全绿生产滞后 | 直查 `information_schema` + 授权补跑 migrate（幂等） |
| AGE 降级丢边形态（BG-06） | 可观测性缺失 | T2 `mirrorEdge` 留痕 |

---

## §10 不采纳项（来自 A-§9）

| # | 项 | 理由 |
|---|---|---|
| 1 | Rete / Datalog 推理引擎 | `decision_rule` 表 + 简单 evaluate 已满足确定性规则，过度引入 |
| 2 | Neo4j / FalkorDB / Qdrant 外挂 | PG + pgvector + AGE 镜像已覆盖图与向量，外挂增运维 |
| 3 | Retraction / Purge（GDPR 擦除） | 项目铁律：绝对禁止 DELETE，走软标记/口径隔离 |
| 4 | 引入 `semantica` Python 包 | Node 22 + ESM 全栈，不混语言栈 |

---

## §11 涉及文件清单（合并）与附

### 11.1 文件改动总表

| 文件 | 关联 | 改动性质 |
|---|---|---|
| `src/context/injector.js` | BG-01a/b, A-T5 | 消费 rationale/memories/timeline + 分层注入 |
| `src/context/assembler.js` | BG-01b, A-T3 | `retrieveL2` 补 timeline；`assembleContextV2` 接线 5 模块 |
| `src/context/supplySpec.js` | A-T1 | **新建** S1–S7 规范 + `validateSupplySpec` |
| `src/context/snapshotStore.js` | A-T2/A-T4 | **新建** 落库 + `prompt_hash` |
| `src/account/insightService.js` | BG-01b | 仅被复用（除非循环依赖，否则不改） |
| `src/decision/relation.js` | BG-03/05a, A-T3 | `linkEntity`/`WRITABLE_EDGES`/`listTypedEdges` UNION+选项 |
| `src/decision/decisionRepo.js` | BG-02/03b/06 | `:106/:152/:188/:307` 统一入口 |
| `src/decision/ageGraph.js` | BG-06 | `mirrorEdge` |
| `src/decision/traceRootCause.js` | BG-03/04 | 读路径 UNION + 运行时口径 |
| `src/decision/closure.js` | BG-04 | 运行时口径 + D2 判定 |
| `src/monitor/attribution.js` | BG-03/04/05a | 读路径 + 装弹自检 |
| `src/http/routes.js` | BG-04, A-T6 | `:2056` 边双口径；监控台路由 |
| `src/sevenDimensions/*` 或 S20 保存路径 | BG-05a | 装弹自检闸门 |
| `db/schema.sql` | BG-03, A-T2 | 新增 `decision_entity_relation`（方案 A）或 ALTER；新增 `decision_context_snapshot` |
| `db/migrate.js` | BG-03, A-T2 | **独立 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` 段 / 独立 `CREATE TABLE IF NOT EXISTS`**（整文件单事务，一处报错全量回滚） |
| `scripts/seed-decision-network.mjs` | BG-04 | 可选：种子行加语义标注 |
| `src/web/sales-decision-monitor.html` | A-T6 | 重构 1682→≤1200 行，三层一屏 |
| `test/**` | 全部 | 每 Task 配套用例 |

### 11.2 迁移铁律（项目踩坑，务必遵守）

新增列只写在 `CREATE TABLE IF NOT EXISTS` 段内，旧库（表已存在）**不会补列**；后续依赖该列的 `CREATE INDEX` 报列不存在 → `db/migrate.js` 整文件单事务全量回滚。新增表用独立 `CREATE TABLE IF NOT EXISTS`；新增列必须走独立 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` 段。

### 11.3 核验脚本（只读）

`tmp/probe_edges_readonly.mjs`（边分布+决策数+装弹）、`tmp/probe_edges2.mjs`（边明细+source）、`tmp/probe_dims.mjs`（逐场景 required_dims）。T4 需新增 `tmp/probe_edge_writability.mjs`（场景→required_dims→应连边→不可写边 风险台账）。

### 11.4 非目标（本文档不做）

- D4 智能体接线修复（独立设计 `docs/2026-09-01-retro-agent-wiring-design.md`，**已实施并验证 2026-09-01**；BG-01 收益以 SKILL 真被调用为前提，已落地：`agentLoop.js:63-66` 取值链 + `scheduler.js:28/46/52` retro 路由 + `contractIds.js` 五键 + `skills/decision-retrospective/registry.json`(D8)，生产库实证五契约键均真实 episode，详见独立设计文档 §8）
- BG-07 embedding 换真（§8-Q3，另立任务）
- visit_notes 双层化（原始+AI 派生，需单独 brainstorming）
- 外部数据富化/邮件起草（Lightfield 对标功能补齐，非缺陷）
- 删除任何演示数据（铁律禁止 DELETE，走口径隔离/软标记）

### 11.5 文档关系

- 本文档**取代** `docs/2026-09-01-sales-decision-monitor-redesign-design.md` 与 `docs/2026-09-01-bugfix-design.md`，为唯一批准目标。
- 概念辨析见 `docs/2026-09-01-tetrad-vs-7x7-and-story-vs-graph.md`（事实/解释二分、三层同喂）。

---

## §12 交付确认（✅ 2026-09-01 用户批准）

> 批准范围：本文档「统一批准目标」所载 **Phase 0–5 全部设计 + 实施 + 真实数据验收** 已通过用户批准，正式收口。后续增量 Phase（Q4 时间基准实现 / Q6 快照多租户 / Q7 调试鉴权实现）按需另走 `writing-plans` 闸；**D4 智能体接线已在独立设计文档 `docs/2026-09-01-retro-agent-wiring-design.md` 单独收口（已实施并验证 2026-09-01，见 §11.4），不属本批准范围，状态以独立文档为准**。

- [x] **§8 七项裁决闭环**（决策层面）
  - Q1 结构 → **已落地=方案 B**（prod backfill 11 边验证，2026-09-01）
  - Q2 scope → **已采纳③**（intent/actor 双源缺失不注入）
  - Q3 embedding → **已裁决②**（不换真 embedding，§11.4 非目标）
  - Q4 时间基准 → **已裁决②**（COALESCE 统一，待实现）
  - Q5 seed 软标记 → **已落地**（relation.js:78 排除 + 7 边 `props.demo=true` 软标记，零 DELETE）
  - Q6 多租户 → **已采纳**（快照按 tenant 隔离，待实现）
  - Q7 调试鉴权 → **已落地**（`routes.js:2073 roleIsAdmin` 闸；alice 普通 POST 调试端点 403「需要 sysadmin 权限」/ GET 只读 200 / admin POST 200 / 匿名 401，2026-09-01 冒烟 5/5）
- [x] **D4 接线设计已实施并验证** → 独立设计文档 `docs/2026-09-01-retro-agent-wiring-design.md` §8 已收口（2026-09-01：取值链 `agentLoop.js:63-66` + retro 路由 `scheduler.js:28/46/52` + `contractIds.js` 五键 + `skills/decision-retrospective/registry.json`；生产库五契约键真实 episode；回归 5 文件 39 例全绿）
- [x] **本文档已由用户批准**（2026-09-01，授权生产写：建表迁移 + 软标记 `--apply` + backfill `--apply` 均已完成）
- [x] **Phase 0–5 实施完成且真实数据验证通过** → 9/9 决策快照、供给 33.3% 真实缺口暴露、双口径防假绿生效、四问可答、BG-01~BG-08 全程 RESOLVED；后续进入 `writing-plans` 仅针对 Q4/Q7/D4 等增量 Phase
