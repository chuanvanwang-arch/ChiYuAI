# 销售决策监控台前后台重新设计：上下文构成逻辑真正落地

> 日期：2026-09-01　作者：WorkBuddy
> 目标页：`http://localhost:3000/sales-decision-monitor`（`src/web/sales-decision-monitor.html`，1682 行）
> 外部输入：三篇 Semantica 文章（`ViaPl3gce` 决策问责账 / `3Lsnnon_` 图原生上下文基座 / `40Q2fXJf` 决策链实战教程）
> 内部实证：`src/context/*`、`src/decision/*`、`src/agent/agentLoop.js`、`db/schema.sql`、生产库 `plm` 直查
> 性质：**设计文档，待批准**。未获批准前不写实现代码（HARD-GATE）。

---

## §0 执行摘要（先结论）

**结论一：本平台的「上下文构成逻辑」目前是一条断链，不是一条弱链。** 装配器 `assembleContext` 确实跑，但产物在 `agentLoop.js:28` 被拍平成标签列表塞进 prompt 后**整体丢弃**——既不落库、不带来源、不做冲突检测、不查相似先例、不校验规则。生产库 9 条决策中 **8 条 `trigger_context = {}`**（唯一非空的那条 `decider_type='engine'`，即引擎自己写的），`decision` 表 32 列**无任何上下文快照列**，也不存在快照表。三篇文章反复指出的那句话——「当时的决定压根没被当成数据留下」——在本平台是**字面成立**的。

**结论二：`decision_relation` 的「七类边全绿」是手工演示数据。** 7 类边**各恰好 1 条，`source` 全为 `seed-script`，`created_at` 全为 2026-08-31**。零条来自真实运行。这重复了工作记忆里已有的铁律：**看板全绿 ≠ 回路通**。

**结论三：修复方案不是新增第 8 个模块，而是把已有的 5 个「造好但没接线」的模块接进装配链。** `searchPrecedents`（真向量相似度）、`detectConflicts`、`ruleEngine`、`buildTimelineRows`、`trackEntry` 全部已实现且有测试，只是从未出现在上下文装配路径上。工作量集中在**装配器重构 + 快照落库**，而非从零造能力。

**结论四：架构修正为「7 维（校验）× 供给操作（机制）× 7 边（结构）」，供给操作与维度是多对多而非 1:1 镜像。** 平台已有 7 维（`sevenDimensions/constants.js`，校验侧：齐不齐）和 7 边（`edgeDimensionSpec.js`，结构侧：怎么连），**唯独缺供给侧**——没人记录「这次装配实际跑了哪些供给操作、各自返回了什么、状态如何」。本设计新增 **供给操作清单 S1–S7**（按真实运行的模块/数据源命名：实体取/史检索/冲突探测/规则校验/时间线/运行态/溯源），**一个操作可服务多个维度、产生多条边**（如时间线构建同时服务「时间配置」+「运行状态」两维、产出 CAUSED/INFLUENCED 等边），从而与 7 维正交、不重复。7×7 巡检卡从「已装弹但无弹药」变成每格可下钻到具体供给操作及其状态。

**结论五：前台从「7 个 section 平铺」重构为「三层一屏」。** 现状 1682 行里 loop-strip / gates / tasklist / decision-network / l2-feedback / true-graph / calibration 七块平级堆叠，没有主次，用户无法回答「哪个决策有问题、问题在哪一维」。新设计收敛为：**平台健康头（含全新的上下文供给健康）→ 可筛决策清单 → 单决策问责档案抽屉（五页签）**。

---

## §1 实证诊断：上下文构成逻辑为何「没落地」

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

模型拿到的是**约 5 个分号拼接的短语**。文章里对比表所说的「传统向量 RAG 只有相关没有因果」——本平台连相关性都很弱（`hashVector` 是确定性哈希指纹，非语义 embedding）。

### 1.3 五个「造好但未接线」的模块

| 模块 | 已实现能力 | file:line | 当前唯一调用方 | 是否在装配链 |
|---|---|---|---|---|
| `searchPrecedents` | 向量相似先例检索（`1 - (embedding <=> $2)` + `minSimilarity` 过滤） | `decisionRepo.js:244-253` | 决策写入时的先例边 | ❌ |
| `detectConflicts` | 多源冲突检测（`needs_review` 保留分歧不覆盖） | `conflict.js:41` | `auditability.js:42`（**事后**审计） | ❌ |
| `ruleEngine.check` | DB 化确定性规则（`decision_rule` 表驱动 + `rule_hit` 留痕） | `ruleEngine.js` | `seed-actions.js:283`（仅 DEAL 推进） | ❌ |
| `buildTimelineRows` | 多源统一时间线（倒序 + 同秒去重 + `actor`/`source`/`entity`/`summary`） | `insightService.js:105` | 客户 360 页面渲染 | ❌ |
| `trackEntry` | PROV-O 溯源捕获（SHA-256 链） | `provenance.js` | `decisionRepo.js:115`（仅决策本体） | ❌ 不覆盖上下文 |

**判定：装配器 `assembler.js` 的 L1–L4 是四条「自己手写的简化查询」，绕过了平台已有的五个专业模块。** L2 尤其典型——它按 `scenario_id` 取最近 5 条（`assembler.js:71-75`），而不是调用同仓库里现成的 `searchPrecedents`。文章中的 `find_similar_decisions` 语义完全缺失。

### 1.4 数据库实证（生产库 `plm`，2026-09-01 直查）

```
decision 列数: 32   含 context_snapshot? false
上下文快照表: { decision_context_snapshot: null, context_assembly: null }
决策统计: { total: 9, empty_ctx: 8, empty_cond: 4, no_entity: 3 }
边来源: REFERENCED_PRECEDENT|seed-script  CAUSED|seed-script  INFLUENCED|seed-script
        DERIVED_FROM_EXCEPTION|seed-script  DECIDED_ON|seed-script
        ESTABLISHES_FRAME|seed-script  OVERRIDES|seed-script     ← 7/7 全为 seed
溯源条目: 10
```

判定块：
- **上下文快照：0 处存在**（无列、无表）→ 「当时看到了什么」不可回答；
- **`trigger_context` 空率 89%**（8/9）→ 连调用方自报的上下文都没填；
- **7 类边 100% seed-script** → 因果图是摆设，`trace_decision_chain` 查到的是演示数据；
- **溯源 10 条 vs 决策 9 条** → 溯源只覆盖决策本体，不覆盖上下文事实（文章 PART 08 的核心用途缺位）。

### 1.5 前台诊断

`sales-decision-monitor.html` 1682 行，body 内七个平级块：

| 块 | 行 | 回答什么问题 | 问题 |
|---|---|---|---|
| `#loop-strip` | 291 | 三闭环状态 | 三张卡跳三个页面，无下钻 |
| `#gates` + `#attribution-panel` | 306-307 | 闸门通过率 / 归因 | 与四问审计口径并列，用户不知看哪个 |
| `#tasklist` | 314 | 待办 | 与决策问责无关，占据视觉中心 |
| `#decision-network` | 318 | 因果链/影响/审计链 | 需手动下拉选决策，与清单割裂 |
| `#l2-feedback` | 329 | 业务结果回路 | 含手工补录表单，运维动作混入监控视图 |
| `#true-graph` | 352 | Cytoscape 真图 | 需两次点击才出图，且图上全是 seed 边 |
| `#page-calibration` | 377 | 校准处方 | 独立 tab，尚可 |

判定：**七块各自成立，合起来无叙事。** 缺的恰是三篇文章的组织主线——「选定一个决策 → 看它当时用了什么 → 看它连到哪里 → 看它是否站得住」。

---

## §2 三篇文章可借鉴点 → 本平台逐条判定

| # | 文章要点 | 出处 | 本平台现状 | 判定 |
|---|---|---|---|---|
| 1 | 决策=图一等节点，`record_decision` 记场景/推理/结果/置信度 | 全三篇 | `crm.decision` 7 点全物化 + `confidence` 列已补 | ✅ **已具备**，无新工作 |
| 2 | `trace_decision_chain` 上溯因果 | 文1 §01 | `decisionTrace.traceDecision` 已实现 | ✅ 已具备（但数据是 seed） |
| 3 | `analyze_decision_impact` 下溯影响 | 文1 §01 | `getImpact` 已实现 | ✅ 已具备 |
| 4 | **`find_similar_decisions` 找先例** | 文1 §01 | `searchPrecedents` 已实现但**不在装配链** | 🔴 **采纳：接线（S2 决策史检索操作）** |
| 5 | **`check_decision_rules` 规则校验** | 文1 §01 | `ruleEngine` 已实现但**不在装配链** | 🔴 **采纳：接线（S4 规则校验操作）** |
| 6 | **「Agent 看到了哪些事实」须落库** | 文3 PART 03 五问 | **完全缺失** | 🔴 **采纳：核心（C0 快照落库）** |
| 7 | **PROV-O 覆盖事实来源，不只覆盖结论** | 文3 PART 08 | 仅覆盖决策本体 | 🔴 **采纳：操作级 provenance（S7 溯源捕获）** |
| 8 | **冲突检测优于静默覆盖，保留分歧** | 文2 §3、文3 PART 09 | `detectConflicts` 仅事后审计 | 🔴 **采纳：装配时前置（S3 冲突探测操作）** |
| 9 | 确定性计算不烧 token | 文2 §⚡ | 七维校验/规则引擎已是确定性 | ✅ 已具备，设计中显式标注 |
| 10 | 四个验收问题（原因/来源/冲突/影响） | 文3 LAST | `computeAudit4q` 已实现 | ✅ 已具备，前台升级为主视图 |
| 11 | 图浏览器（React+Sigma.js 力导向） | 文2 §⚡3 | Cytoscape 已在 `#true-graph` | ✅ 已具备，前台重排 |
| 12 | Rete / Datalog 推理引擎 | 文2 §⚡2 | `decision_rule` 表 + 简单 evaluate | ⚪ **不采纳**（见 §9-1） |
| 13 | Neo4j / FalkorDB / Qdrant 外挂 | 文2 §⚡1 | PG + pgvector + AGE 镜像 | ⚪ **不采纳**（见 §9-2） |
| 14 | Retraction / Purge（GDPR 擦除） | 文2 §⚡3 | 铁律：绝对禁止 DELETE | ⚪ **不采纳**（见 §9-3） |
| 15 | 引入 `semantica` Python 包 | 全三篇 | Node 22 + ESM 全栈 | ⚪ **不采纳**（见 §9-4） |

**净新增工作 = 5 项（#4/#5/#6/#7/#8），全部是「接线 + 落库」，无一项需要新造算法。**

---

## §3 后台重新设计：上下文构成逻辑

### 3.1 核心架构：7 维（校验）× 供给操作（机制）× 7 边（结构）

平台已有两侧，独缺一侧——**且初版把「供给侧」错定义成「供给主题」，与 7 维 1:1 镜像（C1 实体身份…C7 治理与规则，标签逐词照搬 7 维），形成三套同构清单的冗余**。修正如下：

| 侧 | 回答的问题 | 单一事实源 | 命名视角 | 状态 |
|---|---|---|---|---|
| **校验侧** L1–L7 七维 | 上下文**齐不齐**？按哪方面校验 | `sevenDimensions/constants.js` | 校验**主题** | ✅ 已有 |
| **结构侧** E1–E7 七边 | 因果**怎么连**？建立了什么关系 | `edgeDimensionSpec.js` | 关系**类型** | ✅ 已有（数据是 seed） |
| **供给侧** 供给操作 S1–S7 | 装配**跑了哪些操作、返回什么、状态如何** | **本设计新增** `src/context/channelSpec.js` | 供给**机制/数据源** | 🔴 缺失 |

> ⚠️ **设计修正（2026-09-01 用户评审）**：初稿的 C1–C7 与 7 维逐词重复（身份/结构/语义/时间/决策历史/运行状态/治理），是 1:1 镜像而非正交新轴。修正为**供给侧按「执行的模块/数据源」命名（S1–S7），与维度多对多**——一个操作可服务多个维度、产生多条边，从而与校验侧正交、不重复。

**供给操作 S1–S7 定义（按真实运行的模块/数据源命名，单一事实源 `src/context/channelSpec.js`）：**

| 操作 | 名称 | 实际模块/数据源 | 服务维度（多对多） | 产生边 | 类别 |
|---|---|---|---|---|---|
| **S1** | 实体与结构取 | `retrieveEntityProfile` + `crm.particles` | `identity`, `structure` | `DECIDED_ON` | 事实 |
| **S2** | 决策史检索 | **`searchPrecedents`**（接线） | `decision_history` | `REFERENCED_PRECEDENT` | 事实 |
| **S3** | 冲突探测 | **`detectConflicts`**（接线） | `semantics`, `governance` | —（产出冲突证据，喂 semantics+governance 校验） | 事实 |
| **S4** | 规则校验 | **`ruleEngine.check`**（接线） | `governance` | —（`rule_hit` 留痕，确定性） | 确定性 |
| **S5** | 时间线构建 | **`buildTimelineRows`**（接线） | `time_config`, `operational_state` | `CAUSED`, `INFLUENCED`, `DERIVED_FROM_EXCEPTION` | 解释 |
| **S6** | 运行态取 | `crm.tasks` + `agent_health` + 回款/竞品（沿用 L3） | `operational_state` | — | 事实 |
| **S7** | 溯源捕获 | **`trackEntry`** / `provenance.js`（放开 `context_channel`） | 跨所有操作（meta） | —（PROV-O 条目） | 溯源 |

设计要点：
1. **命名按机制不按主题**：S1–S7 是「取/检索/探测/校验/构建/取/捕获」等操作动词，不是维度话题。与 7 维（主题）天然正交，杜绝逐词重复。
2. **多对多绑定（与 1:1 镜像的本质区别）**：`serves_dims` 为数组——S1 服务 2 维、S5 服务 2 维、S3 服务 2 维、S7 跨全部。维度可被多个操作服务，操作可服务于多个维度。
3. **数量由模块决定，不强行凑 7**：上表 7 个操作 = 当前装配链实际会跑的模块枚举；若某机制服务 3 维则总数会少于 7。`validateChannelSpec()` 校验：每维≥1 操作服务、无悬空维、无悬空操作（复用 `validateEdgeDimensionSpec` 写法：悬空/未覆盖两类错误）。
4. **绑定可配置**：`config_store['seven-dim'].channel_bindings`（操作→维度/边），校验失败 fail-safe 回退默认，绝不阻断业务写边。

### 3.2 统一操作信封（Operation Envelope）

每操作返回同一形状，这是快照可聚合、前台可渲染的前提：

```js
{
  op: 'S2',
  name: '决策史检索',
  serves_dims: ['decision_history'],
  kind: 'fact',
  status: 'hit',              // hit | empty | degraded | timeout | blocked
  items: [ /* 操作内容，形状由操作自定 */ ],
  provenance: [               // 每条 item 的来源，PROV-O 语义
    { source_type: 'decision', source_id: '<uuid>', captured_at: '2026-09-01T09:00:00Z', extractor: 'searchPrecedents@v1' }
  ],
  cost_ms: 42,
  token_est: 180,
  note: null                  // degraded/timeout/blocked 时的人类可读原因
}
```

**`status` 五态的判定口径（写入代码注释作为唯一事实源）：**

| 状态 | 含义 | 对 7 维校验的影响 |
|---|---|---|
| `hit` | 检索到内容 | 该维 ✅ 供给充足 |
| `empty` | 检索成功但无内容（合法空） | 该维 ⚠️ 供给为空（业务上可能正常，如首次决策无先例） |
| `degraded` | 部分失败（降级取到子集） | 该维 ⚠️ 供给降级 |
| `timeout` | 超时（默认 200ms，配置化） | 该维 ❌ 供给缺失 |
| `blocked` | 被数据范围/权限闸拦截 | 该维 🔒 供给受限（合法，不算缺陷） |

**铁律：任一操作失败不得阻断装配。** 沿用 `assembler.js:103-106` 的 try/catch 降级模式，但把「静默 `missing.L1 = true`」升级为「带 `note` 的结构化 `status`」——文章反复强调的「不静默」。

### 3.3 上下文快照落库（本设计的核心）

**新表 `crm.decision_context_snapshot`：**

```sql
-- 上下文快照（append-only；决策「当时看到了什么」的唯一权威记录）
-- 铁律：prompt_block 存逐字原文，禁止事后重建（文章：「AI 可以重新生成答案，决策依据不能」）
CREATE TABLE IF NOT EXISTS crm.decision_context_snapshot (
  snapshot_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assembly_id    UUID NOT NULL,                       -- 装配批次（一次装配可服务多次决策）
  decision_id    UUID REFERENCES crm.decision(decision_id),  -- NULL = 装配时决策尚未产生
  tenant_id      TEXT NOT NULL DEFAULT 'system',
  actor          TEXT,
  scenario_id    TEXT,
  query_text     TEXT,
  channels       JSONB NOT NULL,                      -- S1–S7 供给操作信封数组
  dim_coverage   JSONB NOT NULL,                      -- 7 维 × { supplied_by:[], status, note }
  supplied_dims  INT NOT NULL DEFAULT 0,              -- 冗余列，供聚合查询免解 JSONB
  degraded       BOOLEAN NOT NULL DEFAULT FALSE,
  prompt_block   TEXT,                                -- 真正喂给模型的逐字文本
  prompt_hash    TEXT,                                -- SHA-256(prompt_block)，防篡改
  token_est      INT,
  cost_ms        INT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_dcs_decision ON crm.decision_context_snapshot(decision_id);
CREATE INDEX IF NOT EXISTS idx_crm_dcs_assembly ON crm.decision_context_snapshot(assembly_id);
CREATE INDEX IF NOT EXISTS idx_crm_dcs_created  ON crm.decision_context_snapshot(created_at DESC);
```

**`crm.decision` 增列（严格遵守迁移铁律：独立 `ALTER TABLE` 段，绝不写进 `CREATE TABLE IF NOT EXISTS` 内）：**

```sql
-- 2026-09-01 上下文快照关联（旧库补列；写进 CREATE TABLE 段会导致旧库不补列 → 后续索引报错 → 整文件单事务回滚）
ALTER TABLE crm.decision
  ADD COLUMN IF NOT EXISTS context_snapshot_id UUID;
CREATE INDEX IF NOT EXISTS idx_crm_decision_ctx_snap
  ON crm.decision(context_snapshot_id) WHERE context_snapshot_id IS NOT NULL;
```

> 迁移铁律引用：工作记忆「schema 迁移（`CREATE TABLE IF NOT EXISTS` 不补列，2026-08-30/31 实测）」。新列必须走独立 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` 段。

### 3.4 装配即审计：操作级 PROV-O

每次装配后，逐操作调 `trackEntry`（`provenance.js`）：

```js
await trackEntry({
  decision_id: null,                    // 装配阶段决策未生成
  entry_type: 'context_channel',        // 新增 entry_type（provenance.js 需放开枚举）
  payload: { assembly_id, op: 'S2', status, item_count, provenance },
  source: 'context-assembled',
  activity_id: assembly_id,
});
```

这样文章 PART 08 说的「数据出错时能定位源文件和处理步骤」才成立——今天只能定位到决策结论，定位不到结论所依赖的事实。

### 3.5 装配链改造后的完整时序

```
决策请求
  ↓
① assembleContextV2({ actor, scenario_id, query, entities })
     ├─ S1 实体与结构取  ─┐
     ├─ S2 决策史检索     │
     ├─ S3 冲突探测       │ 并行（Promise.allSettled，逐操作独立超时）
     ├─ S5 时间线构建     │
     ├─ S6 运行态取       │
     └─ S4 规则校验  ────┘   （S7 溯源捕获在 ④ 阶段逐操作调 trackEntry，不在此并行扇）
  ↓
② computeDimCoverage(operations)    → 7 维 × status（供给侧视图，由多对多绑定反查）
  ↓
③ formatForPromptV2(operations)     → 分层文本块（事实/叙事/规则/先例四段，非标签列表）
  ↓
④ persistSnapshot()                 → crm.decision_context_snapshot（含 prompt_hash）
  ↓
⑤ trackEntry × 7（每操作一条）       → 操作级 PROV-O 条目
  ↓
⑥ LLM / 规则引擎 决策
  ↓
⑦ createDecision({ ..., context_snapshot_id })   ← 决策与快照双向绑定
  ↓
⑧ sevenDimensionsCheck 复用 dim_coverage（不再重算）→ 拦截判定有据可查
```

**关键收益：第 ⑧ 步是今天最大的隐性缺陷修复。** 现在 `sevenDimensionsCheck(scenario_id, trigger_context)`（`decisionRepo.js:76`）判的是**调用方自报的 `trigger_context`**——而 89% 的决策该字段为 `{}`，所以七维校验实际在校验一个空对象。改造后校验对象变成**装配器实测的 `dim_coverage`**，七维校验第一次有了真实输入。

### 3.6 注入形态改造（`injector.js` → `formatForPromptV2`）

从「标签列表」改为「四段分层」，承接 `2026-09-01-tetrad` §4.5 建议：

```
【上下文 · 快照 <snapshot_id 前8位>】

▸ 治理边界（S4 规则校验）
  角色: 大客户销售 | 数据范围: 仅本人商机/客户读写 | 自主边界: NORMAL 以下可自主
  命中规则: stage_forward_only(pass) / lost_requires_reason(pass)

▸ 事实（S1 实体与结构取，稳定，可复算）
  客户 银通包装(a1111111) | 商机 彩盒打样询盘 | 阶段 lead | 预算 ¥120,000
  BANTCC: B✓ A✓ N✓ T✗ C✗ C✗（4/6 未达标，缺 T/C/C）

▸ 冲突事实（S3 冲突探测，保留分歧，未裁决 2 条）
  ⚠ 联系人手机: CRM=138**** / 合同=139****（两源未裁决，勿假定单一真值）

▸ 故事时间线（S5 时间线构建，最近 8 条，倒序，可被后发事实覆盖）
  09-01 王川 拜访 «生产副总质疑交付周期»            [source: visit_log#412]
  08-28 系统 报价发送 «三级报价 38/36/34 万»        [source: quotation#88]
  ...

▸ 相似先例（S2 决策史检索，top-3，带失效标记）
  0.87 QUOTE_PRICING → APPROVE «目标价 38 万、底价 34 万» ⚠已被 OVERRIDES
  0.72 SIGN_RISK → ESCALATE «反对者出现，需求变更 <10%»
```

设计要点：
- **每条带来源 id**（`[source: ...]`），否则叙事不可审计；
- **先例带 `⚠已被 OVERRIDES` 标记** —— 这是「图的边可失效」，化解文章提到的「图太硬」；
- **冲突显式呈现且明说「勿假定单一真值」** —— 对齐文章「保留分歧优于静默覆盖」；
- **窗口配置化**：S5 时间线默认 20 条、S2 先例默认 top-3、`minSimilarity` 默认 0.6，全部走 `config_store['context-assembly']`，遵守阈值配置化铁律。

---

## §4 前台重新设计：三层一屏

### 4.1 信息架构

```
┌─────────────────────────────────────────────────────────────────┐
│ Layer 0  平台问责健康（常驻头，一屏内 3 个数字 + 1 条 7 维条）      │
│  ① 可审计性 N/4          ② 上下文供给 N/7 ★全新   ③ 三闭环状态    │
├─────────────────────────────────────────────────────────────────┤
│ Layer 1  决策清单（可筛可排，默认按「问题严重度」倒序）             │
│  决策 | 场景 | 处置 | 置信度 | 四问 N/4 | 供给 N/7 | 结果 | 操作   │
│  筛选：⊙全部 ⊙上下文降级 ⊙有未裁决冲突 ⊙孤立决策 ⊙溯源异常      │
├─────────────────────────────────────────────────────────────────┤
│ Layer 2  单决策问责档案（右侧抽屉，五页签）                        │
│  ① 决策卡  ② 当时的上下文 ★核心  ③ 因果链  ④ 溯源链  ⑤ 7×7 巡检  │
└─────────────────────────────────────────────────────────────────┘
Tab 2：决策校准（保留现状，独立 tab，不混入问责主线）
```

**被移出主视图的两块（含理由）：**

| 原块 | 处置 | 理由 |
|---|---|---|
| `#tasklist` 待办列表 | 移至 `/my-todo`（已有页面） | 待办是执行动作，不是问责证据；占据视觉中心属信息架构错误 |
| `#l2-feedback` 手工补录表单 | 收进 Layer 2「决策卡」页签的行内动作 | 运维写操作不应与只读监控并列；且写操作须过决策第 0 闸 |

### 4.2 Layer 0：新增「上下文供给健康」（本次最重要的新指标）

现有 `可审计性 N/4` 回答「决策**事后**查不查得清」；新增 `上下文供给 N/7` 回答「决策**当时**看没看够」。两者缺一不可——一个是结果问责，一个是过程问责。

渲染形态：7 个色块横条，每块一维，颜色映射供给操作 status：

```
身份 ● 结构 ● 语义 ◐ 时间配置 ● 决策历史 ○ 运行状态 ● 治理 ●   供给 5.5/7
      ↑ hit   ↑ hit  ↑degraded    ↑ hit      ↑ empty   ↑ hit  ↑ hit
```

点击任一维 → Layer 1 自动筛出「该维供给不足」的决策。这是**从平台指标直达问题决策**的唯一路径，也是现状完全没有的能力。

色值全走 `tokens.css` 语义变量：`hit`→`--ok`、`degraded`→`--warn`、`empty`→`--mut`、`timeout`→`--err`、`blocked`→`--ac`。零硬编码（UI 一致性铁律）。

### 4.3 Layer 2 页签②「当时的上下文」——三篇文章的核心命题落地

这是全新页签，回答文章 PART 03 的第 1 问「Agent 看到了哪些事实」。布局：

```
快照 3f8a1c22  装配耗时 148ms  估算 1,240 token  哈希 ✓ 完整
────────────────────────────────────────────────────────────
▾ S1 实体与结构取   [identity,structure]      ● hit      2 项   12ms
    银通包装 (a1111111-…101)  ← 来源: particles#a1111111 / 08-29 采集
    彩盒打样询盘 (d1111111-…111) ← 来源: particles#d1111111 / 08-30 采集
▾ S3 冲突探测        [semantics,governance]     ◐ 2 未裁决  38ms
    ⚠ 联系人手机  CRM=138****(08-20)  合同=139****(08-28)   [裁决]
▾ S2 决策史检索      [decision_history] ○ empty   9ms
    note: 该场景历史决策不足（<3 条），无法构成先例基线
▸ S5 时间线构建      [time_config,operational_state]   ● hit      8 项   41ms
▸ S4 规则校验        [governance]    ● hit      规则 2 命中 0 拦截   6ms
────────────────────────────────────────────────────────────
▾ 逐字 Prompt 原文（不可编辑，SHA-256 校验通过）
    【上下文 · 快照 3f8a1c22】…
```

设计要点：
1. **逐字 prompt 原文常驻可展开** —— 文章的核心断言「AI 可以重新生成答案，决策依据不能」，UI 必须让人看到当时**一字不差**的输入；
2. **hash 校验徽章** —— 篡改则显示 `✗ 已篡改`（`--err`），与 Q2 溯源链状态联动；
3. **每条 item 带来源与采集时间**，可点击下钻 `/particle-detail?id=`；
4. **冲突条目带 `[裁决]` 行内动作** —— 但走决策第 0 闸 + HITL 确认（零信任铁律），不是直接 UPDATE。

### 4.4 页面相关关系图（前台跳转拓扑）

```
                       /sales-decision-monitor
                        （决策问责总台）
                               │
      ┌────────────────┬───────┴────────┬──────────────────┐
      │ Layer0 健康头  │ Layer1 清单     │ Tab2 校准         │
      │                │                │                  │
   ┌──┴──┐          点击行 → Layer2    生成处方 → 第0闸
   │     │                 │
/skills  /memory           ├─ 页签② 上下文 ──→ /particle-detail?id=（实体下钻）
（知识环）（记忆环）        │                └─→ /seven-dim（配置该维阈值）
   │                       ├─ 页签③ 因果链 ──→ /decision-graph（全图 Cytoscape）
/decision-scenarios        ├─ 页签④ 溯源链 ──→ 导出 Turtle / JSON-LD
（决策环）                  └─ 页签⑤ 7×7 ────→ 每格点击回跳页签②对应供给操作
```

**新增的关键关系：页签⑤ 的 7×7 每一格可回跳页签② 的对应供给操作。** 这是「校验侧 ↔ 供给侧」的闭环——巡检卡说某维不合格，一点就知道是哪个供给操作没供上、为什么没供上。今天 7×7 巡检卡标红后是死胡同。

### 4.5 视觉与实现约束

| 约束 | 要求 |
|---|---|
| 主题 | 复用项目深色主题，色值 100% 走 `tokens.css` 语义变量（`--bg/--panel/--ink/--mut/--line/--ac/--ok/--err/--warn`） |
| 禁令 | 禁止页内 `:root` 重定义全局 token；禁止 `var(--x, #浅色)` fallback；禁止自引用 `:root{--panel:var(--panel)}`；禁止硬编码 `#fff/#fafafa` 作底色或 `#1e293b/#0f172a` 作文字色 |
| 复用 | 布局/组件复用 `common.css` 的 `.panel/.sect/.sect-title/.btn/.table/.card/.page-head`；tab 用 `.tabs/.tab` |
| 组件 | 沿用 `components.js` 的 `crm-tab/crm-select/crm-input/crm-button` |
| 鉴权 | 页面沿用现有 `/sales-decision-monitor` 路由（`routes.js:2388` `res.sendFile`，非 `renderPage`），无需改渲染架构 |
| 行数预算 | 目标从 1682 行降至 ≤1200 行（移出 tasklist/l2 表单 + 收敛 7 section 为 3 层） |

---

## §5 API 契约

### 5.1 新增

| 方法 | 路径 | 说明 | 鉴权 |
|---|---|---|---|
| `POST` | `/api/context/assemble` | 显式装配（调试/预演），返回 7 供给操作 + `snapshot_id`；**不产生决策** | 登录态 |
| `GET` | `/api/context/snapshot/:id` | 读快照全文（含逐字 prompt + hash 校验结果） | 登录态 + 数据范围闸 |
| `GET` | `/api/decision/:id/context` | **核心端点**：读某决策当时的上下文快照 | 登录态 + 数据范围闸 |
| `GET` | `/api/monitor/context-health` | 平台级 7 维供给覆盖率聚合（窗口可配） | 登录态 |

### 5.2 改造

| 路径 | 改造 |
|---|---|
| `GET /api/decision/:id/audit-4q` | 响应增 `context` 段：`{ snapshot_id, supplied_dims, degraded, dim_coverage }`。**不改既有四问字段形状**（`auditability.test.js` 契约锚定） |
| `GET /api/monitor/auditability` | 增 `context_supply_pct` 聚合字段，不改既有 7 字段 |

### 5.3 鉴权补齐（顺带修 G7）

现状 `/api/graph/*` 六个端点无鉴权（`routes.js:2221-2283`），而 `/api/calibration/*` 全 sysadmin 闸。本次一并对齐：`/api/graph/*` 与 `/api/context/*` 统一加登录态 + 数据范围闸，采用文章提到的 **fail-closed** 范式（鉴权信息缺失时拒绝，不放行）。

---

## §6 实施计划（T1–T9，每 Task 一 commit）

| T | 任务 | 交付 | 依赖 | 测试 |
|---|---|---|---|---|
| **T1** | 供给操作规范单一事实源 | `src/context/channelSpec.js`（S1–S7 定义 + 多对多绑定 + `validateChannelSpec` + `loadChannelSpecFromConfig`） | — | 纯函数单测：悬空操作/悬空维/维未被覆盖 3 类错误 + 配置覆盖 fail-safe |
| **T2** | schema 迁移 | `db/schema.sql` 新表 `decision_context_snapshot` + **独立 ALTER 段**增 `decision.context_snapshot_id` | — | 迁移幂等断言 + 生产库 `information_schema` 直查确认（测试库全绿 ≠ 生产可用） |
| **T3** | 供给操作装配器 | `src/context/assembler.js` 重构为 `assembleContextV2`，接线 `searchPrecedents`/`detectConflicts`/`ruleEngine`/`buildTimelineRows`；`Promise.allSettled` + 逐操作超时 | T1 | 逐操作注入 mock 测 5 态（hit/empty/degraded/timeout/blocked）；任一操作抛错不崩 |
| **T4** | 快照落库 + 操作级 PROV-O | `src/context/snapshotStore.js`（persist + `prompt_hash` + 读取 + hash 校验）；`provenance.js` 放开 `entry_type='context_channel'` | T2,T3 | 落库→读回→hash 一致；篡改 `prompt_block` 后校验返回 TAMPERED |
| **T5** | 注入形态四段化 | `src/context/injector.js` → `formatForPromptV2`（治理/事实/冲突/叙事/先例五段，每条带来源 id，先例带 OVERRIDES 失效标记） | T3 | 快照文本包含来源 id；被 OVERRIDES 的先例带失效标记；窗口配置生效 |
| **T6** | 决策链绑定 + 七维校验换源 | `agentLoop.js` 持久化快照；`decisionRepo.createDecision` 接收并写 `context_snapshot_id`；`sevenDimensionsCheck` 改为消费 `dim_coverage` | T4,T5 | 端到端：装配→决策→`decision.context_snapshot_id` 非空；七维校验输入不再是 `{}` |
| **T7** | API 表面 + 鉴权 | 4 新端点 + 2 端点扩展 + `/api/graph/*` 与 `/api/context/*` fail-closed 鉴权 | T4 | 既有 `audit-4q` / `auditability` 响应形状不变（回归锚定）；未登录 401 |
| **T8** | 前台重构 | `sales-decision-monitor.html` → 三层架构（Layer0 健康头含 7 维供给条 / Layer1 可筛清单 / Layer2 五页签抽屉）；移出 tasklist 与 l2 表单 | T7 | 页面回归 + `tmp/audit_css_vars.py` 变量一致性扫描零违规 |
| **T9** | 真实数据验证（关键） | 清理 `source='seed-script'` 的 7 条演示边（**软标记 `props.demo=true`，禁止 DELETE**）；跑真实场景产生≥3 条决策，验证 7 类边由真实运行产生 | T6,T8 | 四问验收 + 供给验收（见 §7）；`decision_relation` 出现 `source='engine'` 的边 |

**T9 是本设计的验收闸门。** 不做 T9，看板会再次「全绿但回路不通」——这是工作记忆里已记录过一次的教训，不能重犯。

---

## §7 验收口径

### 7.1 文章的四问（结果问责，已有 `computeAudit4q`）

对任选一条**真实运行产生**的决策：

| 问 | 通过判据 |
|---|---|
| Q1 能否解释直接原因 | 上游先例 > 0 **或** `rationale` 非空 |
| Q2 能否追溯到源头 | PROV-O 链 `chainStatus = OK`，且条目**覆盖上下文供给操作**（今天只覆盖决策本体） |
| Q3 能否发现冲突事实 | `detectConflicts` 扫过 ≥1 实体，未裁决冲突可枚举 |
| Q4 能否看下游影响 | 下游节点 > 0，且边 `source ≠ 'seed-script'` |

### 7.2 供给七问（过程问责，本设计新增）

| 判据 | 目标 |
|---|---|
| 每条新决策 `context_snapshot_id` 非空 | 100% |
| 快照 `prompt_hash` 校验通过 | 100% |
| 七维供给覆盖（`supplied_dims`）| ≥ 5/7（S2 检索先例在冷启动期合法为 `empty`，S3 无冲突时合法为 `empty`） |
| `trigger_context` 空率 | 从 89% 降至 **0%**（改由装配器写入，不依赖调用方自报） |
| 操作级 PROV-O 条目数 | ≥ 7 × 决策数 |
| 装配耗时 P95 | ≤ 400ms（7 供给操作并行，单操作超时 200ms） |

### 7.3 回归基线

- 既有全量测试保持全绿（当前 398/398）；
- `auditability.test.js`、`auditability-sla.test.js` 响应契约**零变更**；
- 生产库列断言更新：`crm.decision` = **33 列**（新增 `context_snapshot_id`），新表 `crm.decision_context_snapshot` 存在。

---

## §8 与既有设计文档的关系

| 文档 | 关系 |
|---|---|
| `2026-08-30-semantica-decision-accountability-design.md` | 本设计是其 **G1/G4（决策边落权威表 / PROV-O）在上下文侧的具体化**。G2 规则 DB 化已完成，本设计将其接进装配链 |
| `2026-08-31-decision-auditability-4q-design.md` | 四问评分口径**完全沿用**，不改 `computeAudit4q` 已有字段，仅增 `context` 段 |
| `2026-09-01-tetrad-vs-7x7-and-story-vs-graph.md` | 本设计**落地其 §4.5 建议的三层同喂注入形态**与 §5 行动项序 1（叙事接进注入层）。序 3（embedding 换真）不在本设计范围，列为后续依赖 |
| `2026-08-28-s20-seven-dim-matrix-design.md` | 七维定义**沿用单一事实源** `sevenDimensions/constants.js`，本设计只新增「供给侧」绑定，不改维定义 |

---

## §9 明确不采纳（含理由）

| # | 不采纳项 | 理由 |
|---|---|---|
| 1 | Rete 网络 / Datalog 引擎 | Rete 的价值在**万级规则的增量匹配**。本平台 `decision_rule` 表当前规则数为个位数，简单顺序 evaluate 的复杂度完全够用。引入 Rete 会增加一层难以调试的网络状态，收益为负。**重估触发条件：规则数 > 200 条。** |
| 2 | Neo4j / FalkorDB / Qdrant 外挂存储 | 文章自己给的门槛是「实体与关系规模迈向千万级」。本平台粒子数为百级。PG + pgvector + AGE 镜像的现有组合在此规模下运维成本最低。**重估触发条件：粒子数 > 1000 万或图查询 P95 > 2s。** |
| 3 | Retraction / Purge（GDPR 局部擦除） | 与本项目铁律「绝对禁止 DELETE」直接冲突。去重与失效走软合并（`meta.merged_into`）与 `OVERRIDES` 边失效标记，语义上更强——擦除会摧毁问责链本身，而问责链恰是本平台的核心资产 |
| 4 | 引入 `semantica` Python 包 | 技术栈冲突（Node 22 + ESM 全栈 vs Python 3.8 + PyTorch/Transformers/FAISS 重依赖）。文章描述的**五个 API 语义**（record/trace/similar/impact/rules）本平台已全部有对应实现，采纳的是**方法论而非代码** |
| 5 | 用 LLM 派生业务状态替代确定性计算 | 不可复算 = 管理问责失效。确定性计算是本平台相对 Semantica/Lightfield 的优势项，不能拿优势换便利 |

---

## §10 风险与开放问题

### 10.1 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 装配耗时上升（4 操作 → 7 操作，且含向量检索与冲突检测） | Agent 响应变慢 | 七操作并行 + 逐操作 200ms 超时 + `token_est` 预算上限；超时降级为 `timeout` 而非阻塞 |
| `hashVector` 非真语义 embedding，S2 检索先例质量受限 | 先例召回不准 | 本设计不解决 embedding 问题（属 tetrad 文档序 3），但 S2 的 `status='empty'` 会诚实暴露召回为空，不伪装成成功 |
| 快照表增长（每次装配一行 + 逐字 prompt 文本） | 存储膨胀 | `created_at` 索引 + 30 天后按记忆生命周期蒸馏（保留 `dim_coverage`/`prompt_hash`，正文转冷存）；不删行 |
| `sevenDimensionsCheck` 换源可能改变拦截行为 | 原本放行的决策可能被拦 | T6 分两步：先 shadow 模式（新旧口径并行记录差异，仅 trace），差异清零后再切换权威源 |
| 前台重构触及 1682 行页面 | 回归风险 | T8 前先跑 `tmp/audit_css_vars.py`；移出的 tasklist/l2 表单代码保留在 git 历史，不做物理删除以外的破坏 |

### 10.2 开放问题（需确认后再实施）

1. **S5 时间线窗口默认值**：建议最近 20 条 + 语义 top-k。但 top-k 依赖真 embedding，当前 `hashVector` 下语义检索无效 → 建议 **v1 先纯时间窗口 20 条**，embedding 换真后再加 top-k。是否同意？
2. **T9 的 seed 边处置**：铁律禁止 DELETE。建议软标记 `props.demo=true` 并在前台默认过滤（可开关显示）。是否同意此口径？
3. **快照存储的多租户隔离**：`tenant_id` 已在表设计中，但读取端点是否需要跨租户查询（sysadmin 审计场景）？建议 sysadmin 可跨租户读，普通角色仅本租户。
4. **`/api/context/assemble` 是否对外**：它会消耗检索资源且暴露内部结构。建议仅 sysadmin 可调（调试用途），普通用户走 `/api/decision/:id/context` 只读。

---

## 附：证据基础（file:line + DB 实测）

| 断言 | 证据 |
|---|---|
| 装配产物被丢弃 | `src/agent/agentLoop.js:24-29`；`grep -rn "assembleContext" src/` 全仓仅 1 处调用 |
| 注入形态是标签列表 | `src/context/injector.js:12-22` |
| L2 不是相似先例检索 | `src/context/assembler.js:71-75`（`ORDER BY decided_at DESC LIMIT 5`）vs `decisionRepo.js:244-253`（真向量相似度，未被装配调用） |
| 冲突检测仅事后 | `src/decision/conflict.js:41` 唯一调用方 `auditability.js:42` |
| 规则引擎不在装配链 | `src/ruleEngine.js` 唯一调用方 `src/action/seed-actions.js:283` |
| 时间线未进模型 | `src/account/insightService.js:105` 仅供客户 360 渲染 |
| 无上下文快照 | 生产库直查：`decision` 32 列无 `context_snapshot*`；`to_regclass('crm.decision_context_snapshot') = null` |
| `trigger_context` 空率 89% | 生产库直查：`total=9, empty_ctx=8` |
| 七类边全为演示数据 | 生产库直查：7 类边各 1 条，`source` 全 `seed-script`，`created_at` 全 2026-08-31 |
| 七维/七边单一事实源 | `src/sevenDimensions/constants.js:5-13`、`src/decision/edgeDimensionSpec.js:7-38` |
| 迁移铁律 | `db/schema.sql:181-185`（既有 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` 正确范式） |
