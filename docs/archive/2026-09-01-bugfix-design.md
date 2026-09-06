# 缺陷修复设计文档（决策子系统 · 上下文注入 · 数据可信度）

- 日期：2026-09-01
- 状态：**待批准**（本文档为设计，不含实现代码；批准后由独立任务执行）
- 来源：Lightfield 对标分析三轮追问中暴露的实现缺陷（`docs/2026-09-01-*` 系列）
- 适用：`D:\system\CRM-ai-native`，生产库 `plm@5433` schema `crm`
- 判定方法：**三问法**（规范是否要求 / 实现是否达成 / 未达成是否留痕）+ 生产库实测

---

## §0 执行摘要

### 0.1 结论

共识别 **7 项缺陷**，其中 **3 项 P0、3 项 P1、1 项 P2**。它们不是孤立 bug，而是**一条因果链**：

```
装弹已生效（required_dims 有值）
      ↓ 推导
应连边恒含 DECIDED_ON
      ↓ 但
DECIDED_ON 因外键结构写不进权威表        ← P0 架构偏离（BG-03）
      ↓ 于是
6 个已装弹场景的每条真实决策 → 系统性 EDGE_MISSING 误报   ← P0 逻辑炸弹（BG-05）
      ↓ 而
看板显示"7 类边齐备"，实为种子脚本造的假绿（运行时 0 条） ← P0 数据可信度（BG-04）
```

**当前不红只因真实决策仅 9 条**。一旦业务数据进入，巡检卡将对每一条决策报 `EDGE_MISSING`，且看板同期显示"边齐备"——**一个既误报又自相矛盾的状态**。

### 0.2 缺陷总表

| 编号 | 缺陷 | 分级 | 性质 | 依赖 |
|---|---|---|---|---|
| **BG-01** | 注入层丢弃已装配的叙事字段 | P1 | 真 BUG | 无（可最先修） |
| **BG-02** | `OVERRIDES` 边漏接权威表 | P1 | 真 BUG（纯遗漏） | 无 |
| **BG-03** | `DECIDED_ON` / `DERIVED_FROM_EXCEPTION` 外键结构性不可写 | **P0** | 架构偏离 | 需裁决 §8-Q1 |
| **BG-04** | 种子数据伪装为运行时产出（看板假绿） | **P0** | 数据可信度 | 无（可最先修） |
| **BG-05** | 装弹后系统性 `EDGE_MISSING` 误报 | **P0** | 逻辑炸弹 | BG-03 |
| **BG-06** | 边写降级无留痕（AGE 不可用静默丢边形态） | P2 | 可观测性缺陷 | 无 |
| **BG-07** | L1 用哈希向量，非语义向量 | 待裁决 | 未完成集成 | §8-Q3 |

### 0.3 建议执行顺序

```
T0  BG-04  数据可信度隔离        ← 先行：决定后续"怎么算绿"
T1  BG-01a 注入层补已有字段      ← 并行：最低风险、最高 ROI
T2  BG-06  边写降级留痕          ← 并行：改动 2 行
T3  BG-02  OVERRIDES 接线        ← 并行
T4  BG-05a 装弹自检闸门          ← 依赖 T3（可写边集合定义）
──────── 以上均无需结构变更，可一次交付 ────────
T5  BG-03  结构扩容（待裁决 Q1） ← 需 DDL
T6  BG-03b 边写入点补齐
T7  BG-05b 装弹修正 + 误报清零
T8  BG-01b 叙事时间线进注入层    ← 依赖 §8-Q2（scope 来源裁决）
```

每个 Task 一 commit，不做 `git add -A`。

---

## §1 判定方法与分级标准

### 1.1 三问法（本文档唯一准入闸）

| 问 | 是 → | 否 → |
|---|---|---|
| **Q-A 规范是否要求？** | 继续 Q-B | **非缺陷**（属增强，出本文档） |
| **Q-B 实现是否达成？** | 非缺陷 | 继续 Q-C |
| **Q-C 未达成时是否留痕？** | 有留痕且设计允许 → **可接受降级** | **缺陷** |

### 1.2 缺陷性质三分

| 性质 | 定义 | 严重度 |
|---|---|---|
| **真 BUG** | 规范明确、实现达成条件具备，但实现遗漏或写错 | 按影响面定 |
| **架构偏离** | 实现方主动偏离已批准设计且未回告评审 → **比 BUG 严重**，因为设计文档与代码双双"各自正确"，合起来是错的，且通常**完全静默** | 至少 P0 |
| **数据可信度** | 代码正确但呈现态失真（演示数据伪装运行时产出） | 至少 P0（误导决策） |

### 1.3 生产库实测基线（2026-09-01 09:0x，只读探针 `tmp/probe_edges2.mjs`）

| 指标 | 实测值 |
|---|---|
| `crm.decision_relation` 总行数 | **7**（E1–E7 各 1 行） |
| 其中 `source='seed-script'` | **7**（100%） |
| 其中 `source<>'seed-script'`（运行时产出） | **0** |
| `crm.decision` 真实决策数 | **9** |
| `decision_scenario.required_dims` 装弹 | **已完成**（`CLIENT_STRATEGY`/`OPP_QUALIFY`/`LOSS_REVIEW`/`POST_CONTRACT` 各 7 维、`LEAD_FOLLOW_UP` 5 维、`ATTR_SCHEMA_CHANGE` 3 维） |

> **更正记录**：前两轮分析曾据 DDL 默认 `'[]'`（db/migrate-config.sql:82）推断"巡检卡从未装弹"，**该判断错误**，已回改 `docs/2026-09-01-tetrad-vs-7x7-and-story-vs-graph.md` 的 F3 段。DDL 默认只对**新建场景**成立，存量场景已被 `scripts/seed-seven-dim.mjs` 装弹。

---

## §2 BG-01｜注入层丢弃已装配的叙事字段（P1 · 真 BUG）

### 2.1 现象

上下文注入给 LLM 的 L2（历史决策）是**标签列表**而非故事——模型拿到的是 `OPP_QUALIFY:approved` 这种键值对，没有决策依据、没有时间、没有因果。

### 2.2 证据

判定三问：

| 问 | 结论 | 证据 |
|---|---|---|
| Q-A 规范是否要求 | **是** | 装配层已显式取数，说明设计意图是"取来用" |
| Q-B 实现是否达成 | **否** | 取到后未消费 |
| Q-C 是否留痕 | **否** | 无任何告警/降级标记 |

```js
// src/context/assembler.js:72 —— 装配层已 SELECT rationale
`SELECT decision_id, scenario_id, disposition, rationale FROM crm.decision ...`
// src/context/assembler.js:76 —— 装配层已取 memories
const m = await retrieveMemory({ topicLike: 'decision:%', limit: 5 }).catch(() => ({ rows: [] }));
// src/context/assembler.js:77
return { decisions: r.rows, memories: m.rows };
```
```js
// src/context/injector.js:18 —— 注入层只输出 scenario:disposition
parts.push(`历史决策(${layers.L2.decisions.length}): `
  + layers.L2.decisions.map((d) => `${d.scenario_id}:${d.disposition}`).join('; '));
```

**`rationale` 与 `memories` 装配到 bundle 后，在最后一厘米被丢弃。**

同理 L1（`injector.js:12`）只输出 `x.title`，而 `assembler.js:64-65` 已装配 `payload` 与 `profile`（实体画像投影）。

### 2.3 影响

- 按 Lightfield 一手论证（"图/表让模型 hold the edges too firmly"），本平台模型不仅没拿到边，**连决策理由都没拿到**；
- `rationale` 是决策问责的核心字段（设计 §5 溯源链），不注入等于问责信息在模型侧完全不可见；
- 修复成本极低（改 1 个格式串），但直接决定后续所有 AI 能力的上下文质量上限。

### 2.4 修复方案

**BG-01a（必做，低风险）** —— 只消费已装配字段：

```js
// src/context/injector.js:17-19 改为
if (layers.L2?.decisions?.length) {
  const ds = layers.L2.decisions.map((d) => {
    const r = d.rationale ? `｜依据:${clip(d.rationale, BUDGET.l2_rationale)}` : '';
    return `${d.scenario_id}:${d.disposition}${r}`;
  });
  parts.push(`历史决策(${ds.length}): ` + ds.join('\n  '));
}
if (layers.L2?.memories?.length) {
  parts.push(`相关记忆(${layers.L2.memories.length}): `
    + layers.L2.memories.map((m) => clip(m.payload?.title || m.topic, BUDGET.mem_title)).join('; '));
}
```

- `clip()` 为纯函数（超长截断加 `…`），放 `injector.js` 内并确保可单测；
- `BUDGET` 建议走 `config_store['context-budget']`（**阈值配置化铁律**），缺失时取出厂默认 `{ l1_snippet: 60, l2_rationale: 80, mem_title: 40, timeline_max: 20 }`；
- L1（`injector.js:12`）同步改为 `title` + `payload` 关键字段摘要（复用 `retrieveEntityProfile` 已算好的 `profile`），避免 title-only 造成实体混淆。

**BG-01b（见 §8-Q2 裁决后）** —— 叙事时间线进注入层，见 §6。

### 2.5 验收

| # | 断言 |
|---|---|
| A1 | `formatForPrompt({ layers: { L2: { decisions: [{scenario_id:'S',disposition:'ok',rationale:'R'}] } } })` 输出含 `R` |
| A2 | `rationale` 超长（>80 字符）时输出被截断且以 `…` 结尾，不抛异常 |
| A3 | `rationale` 为 null/undefined 时不输出 `｜依据:`，不出现 `undefined` |
| A4 | `memories` 为空数组时不输出"相关记忆"块 |
| A5 | 现有 `test/context.test.js` 全绿（该文件有 `formatForPrompt` 用例，需确认未被格式变更打断） |

---

## §3 BG-02｜`OVERRIDES` 边漏接权威表（P1 · 真 BUG）

### 3.1 现象

决策被翻案时，`OVERRIDES` 边只写进 AGE 镜像，**PG 权威表 `decision_relation` 无记录** → 权威读路径永远看不到它。

### 3.2 证据

```js
// src/decision/decisionRepo.js:307（reverseDecision 内）
await addEdge('OVERRIDES', String(s.decision_id), String(decision_id), { reason }).catch(() => {});
```

同一文件内，其余四类边均走统一双写入口：

| 边 | 行号 | 入口 | 权威表 |
|---|---|---|---|
| `REFERENCED_PRECEDENT` | `:157` | 直插 + `:152` AGE | ✅ |
| `CAUSED` | `:173` | `linkDecisions()` | ✅ |
| `INFLUENCED` | `:176` | `linkDecisions()` | ✅ |
| `ESTABLISHES_FRAME` | `:179` | `linkDecisions()` | ✅ |
| **`OVERRIDES`** | **`:307`** | **`addEdge()` only** | ❌ |

**关键点**：`OVERRIDES` 的 direction 是 `decision->decision`（`edgeDimensionSpec.js:35`），两端都是 decision，**外键完全允许**（`schema.sql:495-496`）。这是纯遗漏，不是结构限制——也是它与 BG-03 的分界线。

### 3.3 影响

- `listTypedEdges()`（`relation.js:56`）查权威表查不到 OVERRIDES → **翻案链路在权威视图中断**；
- `closure.js:40`、`traceRootCause.js:126`、`http/routes.js:2056`（Cytoscape 真图渲染）全部读权威表 → 翻案不可见；
- `governance` / `decision_history` 两维（OVERRIDES 所服务，`edgeDimensionSpec.js:35`）在 7×7 巡检中恒缺证据。

### 3.4 修复方案

```js
// src/decision/decisionRepo.js:305-308 改为
const { linkDecisions } = await import('./relation.js');   // 与 :170 同款惰性导入
for (const s of succ) {
  await linkDecisions(String(s.decision_id), String(decision_id), 'OVERRIDES',
    { source: 'engine', props: { reason } }).catch((e) => {
      emit('trace', 'decision-relation-write-failed', { decision_id, to_id: s.decision_id, error: String(e?.message || e) });
      recordFailure('decision-relation-write-failed', e);
    });
}
```

- `serves_dimension` 由 `primaryDimension('OVERRIDES')` 自动取 `governance`（`relation.js:40`），无需硬编码；
- 保留 `.catch` 不阻断主写（主路径铁律），但**必须留痕**（对齐 `:162-163` 同款）。

### 3.5 验收

| # | 断言 |
|---|---|
| B1 | 构造 A→B 先例关系后 `reverseDecision(B)` → `SELECT * FROM crm.decision_relation WHERE rel_type='OVERRIDES'` 有 1 行，`serves_dimension='governance'` |
| B2 | 同一操作后 `listTypedEdges(A, {direction:'both'})` 返回含 `rel_type='OVERRIDES'` |
| B3 | 幂等：重复翻案不产生重复行（依赖 `UNIQUE(from_id,to_id,rel_type)`） |
| B4 | AGE 不可用时主流程不抛，`decision_relation` 仍有行 |

---

## §4 BG-03｜`DECIDED_ON` / `DERIVED_FROM_EXCEPTION` 外键结构性不可写（**P0 · 架构偏离**）

### 4.1 现象

7 类边中有 2 类**在任何情况下都写不进权威表**——不是漏写，是表结构不允许。

### 4.2 证据链

**（1）规范侧：这两类边的靶子不是 decision**

```js
// src/decision/edgeDimensionSpec.js:31
{ edge_type: 'DECIDED_ON',             serves_dimension: ['identity','structure'], direction: 'decision->entity' },
// src/decision/edgeDimensionSpec.js:33
{ edge_type: 'DERIVED_FROM_EXCEPTION', serves_dimension: ['operational_state'],    direction: 'decision->exception' },
```

**（2）实现侧：表两端都是 decision 的外键**

```sql
-- db/schema.sql:492-496
CREATE TABLE IF NOT EXISTS crm.decision_relation (
  from_id UUID NOT NULL REFERENCES crm.decision(decision_id),
  to_id   UUID NOT NULL REFERENCES crm.decision(decision_id),   -- ← 靶子被钉死为 decision
  rel_type TEXT NOT NULL CHECK (rel_type IN ('DECIDED_ON', ..., 'DERIVED_FROM_EXCEPTION', ...)),  -- ← 枚举却允许
  ...
);
```

**枚举允许、外键拒绝**——表自我矛盾。

**（3）已批准设计的要求被实现方偏离**

```markdown
# docs/2026-08-30-decision-drillthrough-design.md:105
  to_particle   TEXT,      -- 指向 K 粒子 id（D2 载体）
# :114
物化时在 `createDecision` 内遍历 `involved_entities` 生成 `DECIDED_ON`→`to_particle`（D2 边）
# :175
"D2_M_to_J": { "exists":true, "carrier":"decision_relation.DECIDED_ON→to_particle" }
```

`schema.sql` 中**没有 `to_particle` 列**。

**（4）实现方在注释中自我承认偏离，但未回告评审**

```js
// src/decision/decisionRepo.js:155-156
// 约束（schema.sql:492-493）：from_id/to_id 均 REFERENCES decision → 仅承载「决策↔决策」边；
// 「决策→粒子」联动走 decision.involved_entities(JSONB)，不进此表。
// src/decision/decisionRepo.js:181
// DERIVED_FROM_EXCEPTION：决策→异常顶点（异常非 decision，仅 AGE 镜像，不进 decision_relation 权威表）
```

两条轨道各自正确，合起来与设计冲突。

**（5）判定：符合"架构偏离"，且完全静默**

| 问 | 结论 |
|---|---|
| Q-A 规范是否要求 | **是**（drillthrough 设计 :105/:114/:175 明确要求 `to_particle` 列） |
| Q-B 实现是否达成 | **否**（无此列；只写 AGE） |
| Q-C 是否留痕 | **否**——因为根本没尝试写 PG，连 `recordFailure` 的 trace 都不会产生 |

> **已核实（避免误判）**：`ageGraph.addEdge(relType, from, to, props)` 支持 `to` 为 `{id,label}` 顶点对象（`ageGraph.js:140-143`），因此 `decisionRepo.js:106` 的 `DECIDED_ON` **确实写进了 AGE**（AGE 可用时）。缺陷严格限定在 **PG 权威表**侧，不是"边完全没写"。

### 4.3 影响

| 后果 | 说明 |
|---|---|
| 权威表 2/7 边永不可写 | 7×7 巡检的 `identity`/`structure`/`operational_state` 三维**永远取不到边证据** |
| AGE 降级即丢边形态 | AGE 不可用时这两类边只剩 `involved_entities` JSONB 兜底，图查询能力归零 |
| 直接引爆 BG-05 | 装弹含 `identity`/`structure` → 应连边恒含 `DECIDED_ON` → 恒不可满足 |

### 4.4 修复方案（**待裁决 §8-Q1**，两案并列）

#### 方案 A：新建 `crm.decision_entity_relation`（**推荐**）

```sql
CREATE TABLE IF NOT EXISTS crm.decision_entity_relation (
  rel_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_decision   UUID NOT NULL REFERENCES crm.decision(decision_id),
  to_entity       UUID NOT NULL,                 -- particles.id 或 exception id（不做跨表 FK）
  to_entity_type  TEXT NOT NULL CHECK (to_entity_type IN ('particle','exception')),
  rel_type        TEXT NOT NULL CHECK (rel_type IN ('DECIDED_ON','DERIVED_FROM_EXCEPTION')),
  serves_dimension TEXT NOT NULL,
  props           JSONB,
  source          TEXT NOT NULL DEFAULT 'engine',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (from_decision, to_entity, rel_type)
);
CREATE INDEX IF NOT EXISTS idx_crm_der_from ON crm.decision_entity_relation(from_decision);
CREATE INDEX IF NOT EXISTS idx_crm_der_to   ON crm.decision_entity_relation(to_entity);
```

| 维度 | 评价 |
|---|---|
| FK 纯洁性 | ✅ `decision_relation` 保持"决策↔决策"单一语义，不引入半吊子外键 |
| 语义清晰 | ✅ 边端点类型由表名+`to_entity_type` 自解释 |
| 改动面 | ❌ 读路径需 UNION，涉及 **4 处**（见下） |
| 未来扩展 | ✅ 后续"决策→任意实体"新边类型直接复用 |

**读路径改动清单（4 处）**：

| 位置 | 现状 | 改法 |
|---|---|---|
| `src/decision/relation.js:56` `listTypedEdges()` | 单表查询 | UNION 两表，返回行补 `to_entity_type` 字段（`decision`/`particle`/`exception`），保持既有字段不变以兼容消费方 |
| `src/decision/traceRootCause.js:126` | `SELECT ... FROM crm.decision_relation WHERE from_id=$1` | 同上 UNION |
| `src/monitor/attribution.js:80` | `SELECT rel_type FROM crm.decision_relation WHERE from_id=$1 OR to_id=$1` | 同上 UNION（只取 rel_type 列，改动最小） |
| `src/decision/closure.js:40` | `listTypedEdges()` | 无需改（随 relation.js 一并生效） |

#### 方案 B：`decision_relation` 加 `to_type` + 放宽 `to_id` 外键

```sql
ALTER TABLE crm.decision_relation
  ADD COLUMN IF NOT EXISTS to_type TEXT NOT NULL DEFAULT 'decision'
    CHECK (to_type IN ('decision','particle','exception'));
ALTER TABLE crm.decision_relation DROP CONSTRAINT IF EXISTS decision_relation_to_id_fkey;
```

| 维度 | 评价 |
|---|---|
| 改动面 | ✅ 极小，读路径**零改动** |
| 语义清晰 | ❌ 表变"混合端点表"，`to_id` 的含义依赖 `to_type` 列才能解释 |
| FK 纯洁性 | ❌ 彻底失去 `to_id` 参照完整性保护（悬空 id 无拦） |
| UNIQUE 约束 | ⚠️ `UNIQUE(from_id,to_id,rel_type)` 语义变弱（UUID 碰撞概率极低，但约束不再自解释） |

#### 推荐与理由

**推荐方案 A**。理由：本平台的差异化定位是"可问责的记忆"，`decision_relation` 是审计资产，其表语义纯洁性高于一次性的改动成本；方案 B 省下的 4 处读路径改动是**一次性**的，而失去 FK 保护是**永久性**的。若裁决倾向 B，则必须同步在应用层加"写入前校验 to_id 存在性"的守卫，否则悬空边无法在 DB 层拦截。

### 4.5 写入点补齐（BG-03b，两方案共用）

```js
// src/decision/decisionRepo.js:105-107（DECIDED_ON）—— 在 AGE 写之后补权威写
for (const ent of (Array.isArray(involved_entities) ? involved_entities : [])) {
  await addParticleVertex(ent.type, ent.id, ent.name || '').catch(() => {});
  await addEdge('DECIDED_ON', decision.decision_id, { id: String(ent.id), label: ent.type }, {}).catch(...);
  await linkEntity(decision.decision_id, ent.id, 'particle', 'DECIDED_ON', { source: 'engine' })
    .catch((e) => { emit('trace','decision-entity-relation-write-failed', {...}); recordFailure(...); });
}
// src/decision/decisionRepo.js:188（DERIVED_FROM_EXCEPTION）同理，to_entity_type='exception'
```

新增 `linkEntity()` 于 `src/decision/relation.js`（与 `linkDecisions()` 对称，内部做 PG 写 + AGE 镜像），保持"**单一写入口**"铁律。

### 4.6 验收

| # | 断言 |
|---|---|
| C1 | `createDecision({involved_entities:[{id,type:'CRM_ACCOUNT'}]})` 后，权威侧可查到 `DECIDED_ON` 边（方案 A：`decision_entity_relation`；方案 B：`decision_relation WHERE to_type='particle'`） |
| C2 | `createDecision({triggered_by_exception:{id}})` 后，权威侧可查到 `DERIVED_FROM_EXCEPTION` 边 |
| C3 | `listTypedEdges(decisionId,{direction:'both'})` 返回 7 类边全可达（含上述两类） |
| C4 | `computeEdgeCompliance(actual, {requiredDims:['identity','structure']}).required_missing` 在真实写入后为 `[]` |
| C5 | AGE 不可用时，权威表写入不受影响（`isAvailable()===false` 场景下单测） |
| C6 | 迁移幂等：重复执行 `db/migrate.js` 不报错、不重复建表 |

---

## §5 BG-04｜种子数据伪装为运行时产出（**P0 · 数据可信度**）

### 5.1 现象

决策边看板显示"7 类边齐备"（E1–E7 各 1 条），但**运行时产出为 0 条**——全部由种子脚本生成，看板未做来源区分。

### 5.2 证据

```js
// scripts/seed-decision-network.mjs:88
[fromId, toId, relType, servesDimension, JSON.stringify({ seeded: true, at: nowIso }), 'seed-script']
//                                                                                    ^^^^^^^^^^^^
```
```sql
-- 生产库实测（tmp/probe_edges2.mjs）
rel_type 件数  source
─────────────────────────────
E1..E7    各1   'seed-script'
SELECT count(*) FROM crm.decision_relation WHERE source <> 'seed-script';  -- → 0
```

**附加语义错误**：种子的 `DECIDED_ON` 因 FK 强制，`to_id` 被迫指向另一个 decision 而非粒子——**业务语义是错的，但看板显示为 present**。这是 BG-03 的下游污染。

### 5.3 影响

| 后果 | 说明 |
|---|---|
| 假绿掩盖 BG-03 | 如果没有种子数据，BG-03 在上线首日就会以"边恒缺"暴露；种子数据把它藏了 |
| 误导验收 | 前两轮分析中我曾据"7 类边各 1 行"判断边体系已通，实为误判 |
| 与 BG-05 叠加 | 看板说"边齐备"、巡检说"边缺失"——**同一系统自相矛盾** |

### 5.4 修复方案

**约束**：项目铁律**绝对禁止 DELETE**。本项不做数据删除，只做**口径隔离**。

| 步 | 改动 | 位置 |
|---|---|---|
| 1 | 定义**运行时口径常量**：`RUNTIME_SOURCES = source NOT IN ('seed-script','demo','import-test')` | 新增 `src/decision/edgeSource.js`（单一事实源） |
| 2 | `listTypedEdges()` / `getTypedEdges()` 增加 `{ runtimeOnly = false }` 选项，默认 `false`（行为不变，兼容存量消费方） | `src/decision/relation.js:56` |
| 3 | 权威读路径默认切运行时口径：`traceRootCause.js:126`、`attribution.js:80` | 2 处 |
| 4 | 巡检卡/边看板展示**双口径**：`运行时边 N 条 / 演示边 M 条`；演示边在图上以虚线渲染 | `src/http/routes.js:2056`、前端 Cytoscape 渲染 |
| 5 | `closure.js:96` 的 D2 判定（`m.edges.length > 0`）改用运行时口径，否则"演示数据即判定闭环成立" | `src/decision/closure.js:40,96` |
| 6 | 提供只读核验脚本：`node tmp/probe_edges2.mjs`（已存在），并在输出中显式区分口径 | 已具备 |

**种子脚本侧**（可选，低优先）：为 `DECIDED_ON` 种子行增加 `props.semantic_note` 标注"因 FK 限制 to_id 指向 decision，非业务语义"，避免后人误读。

### 5.5 验收

| # | 断言 |
|---|---|
| D1 | `listTypedEdges(id,{runtimeOnly:true})` 在纯种子环境下返回 `[]` |
| D2 | 消费方不传 `runtimeOnly` 时行为与修复前完全一致（无回归） |
| D3 | 巡检卡展示 `运行时边 0 条 / 演示边 7 条`，两者不混计 |
| D4 | 造一条运行时边后，运行时计数 +1，演示计数不变 |
| D5 | 全流程零 DELETE 语句（`grep -ri "delete from" ` 在改动文件中无命中） |

---

## §6 BG-05｜装弹后系统性 `EDGE_MISSING` 误报（**P0 · 逻辑炸弹**）

### 6.1 现象

6 个已装弹场景（含 `identity`/`structure`）的**每一条真实决策**，都会被判为 `EDGE_MISSING`，且该判定永不可消除。当前未爆发仅因真实决策只有 9 条。

### 6.2 证据链

```js
// scripts/seed-seven-dim.mjs:47-49 —— 装弹已完成
const dims = PRESET[r.scenario_id] || FALLBACK;   // FALLBACK = ['identity','structure','governance']
// 实测：CLIENT_STRATEGY/OPP_QUALIFY/LOSS_REVIEW/POST_CONTRACT = 7 维（含 identity+structure）
```
```js
// src/monitor/attribution.js:20-31 —— 应连边推导
requiredEdgesForDims(['identity','structure'])
// → 服务这两维的边 = [DECIDED_ON]（edgeDimensionSpec.js:31）
```
```js
// src/monitor/attribution.js:49 —— 应连未连
out.required_missing = req.filter((k) => !actual.has(k));   // 恒含 DECIDED_ON
```
```js
// src/decision/rootCauseClassifier.js:25-31 —— 判定 E 缺
const ec = (attribution && attribution.edge_compliance) || {};
return Array.isArray(ec?.required_missing) && ec.required_missing.length > 0;
// → :60  return { ...ROOT_CAUSES.EDGE_MISSING, ... }
```

**因果闭合**：装弹含 identity/structure → 应连边恒含 `DECIDED_ON` → BG-03 导致 `DECIDED_ON` 永不可写 → `required_missing` 恒非空 → 所有该场景决策误报。

**放大路径**：`decision/retro.js:84`、`calibration/autoSuggest.js:38`、`action/seed-actions.js:100,1060` 均消费 `edge_compliance` → 误报会污染**复盘报告、校准处方、决策回执**三条下游链路。

### 6.3 修复方案

#### BG-05a：装弹自检闸门（**可先于 BG-03 实施**）

新增**可写边集合**单一事实源：

```js
// src/decision/relation.js（或新建 writableEdges.js）—— 随 BG-02/BG-03 进展递增
export const WRITABLE_EDGES = {
  PG_AUTHORITY: ['REFERENCED_PRECEDENT','CAUSED','INFLUENCED','ESTABLISHES_FRAME'],           // 现状
  // 修完 BG-02 后 += 'OVERRIDES'
  // 修完 BG-03 后 += 'DECIDED_ON','DERIVED_FROM_EXCEPTION'
};
```

自检规则（S20 七维页保存 `required_dims` 时）：

```
requiredEdgesForDims(dims) ⊆ WRITABLE_EDGES.PG_AUTHORITY
  否 → 页面告警并拒绝保存，提示"维度 X 依赖边 Y，但 Y 当前不可写（结构性限制）"
```

同步提供**存量核验脚本**（只读）：遍历 `decision_scenario`，输出每个场景的 `required_dims → 应连边 → 不可写边清单`，作为 BG-03 完成前的风险台账。

#### BG-05b：装弹修正（依赖 BG-03 完成）

BG-03 落地后 `DECIDED_ON`/`DERIVED_FROM_EXCEPTION` 可写 → 误报自然消除。**此步无需修改装弹内容**。

**若业务侧要求 BG-03 延期**，则临时缓解方案（需单独批准）：将 `identity`/`structure` 从装弹的 `on_missing` 降为 `'info'`（只记录不判缺），并在文档中挂账。此为**降级止血**，不是修复。

### 6.4 验收

| # | 断言 |
|---|---|
| E1 | 自检脚本对当前生产库输出：`CLIENT_STRATEGY/OPP_QUALIFY/LOSS_REVIEW/POST_CONTRACT` 应连边含 `DECIDED_ON`（不可写）→ 告警 |
| E2 | S20 保存含 `identity` 的 `required_dims`（BG-03 未完成时）被拒绝并给出可读提示 |
| E3 | BG-03 完成后，同一保存操作通过 |
| E4 | 新建真实决策（场景 `CLIENT_STRATEGY`）后 `rootCauseClassifier` 不返回 `EDGE_MISSING` |
| E5 | `retro` 报告 / `autoSuggest` 处方中不再出现批量 `EDGE_MISSING` |
| E6 | 降级止血方案启用时，巡检卡明确标注"identity/structure 维度暂不判缺" |

---

## §7 BG-06｜边写降级无留痕（P2 · 可观测性缺陷）

### 7.1 现象与证据

```js
// src/decision/decisionRepo.js:106
await addEdge('DECIDED_ON', ...).catch(() => {});
// src/decision/decisionRepo.js:188
await addEdge('DERIVED_FROM_EXCEPTION', ...).catch(() => {});
```

`addEdge()` 在 AGE 不可用时返回 `{ok:false, skipped:'age-unavailable'}`（`ageGraph.js:138`）——**返回值被丢弃**，调用方无法区分"降级跳过"与"真失败"。

同文件其它失败点均留痕（`:117-119`、`:162-163`），唯独这两处 `catch(() => {})`。

### 7.2 判定

| 问 | 结论 |
|---|---|
| Q-A 规范是否要求 | 是——G3"不静默"铁律，同文件其它点均已遵守 |
| Q-B 实现是否达成 | 否 |
| Q-C 是否留痕 | 部分（`addEdge` 内部有 emit，但**降级跳过路径**在 `:138` 直接 return，无 emit） |

**性质**：数据不丢（`involved_entities` 在 decision 行），丢的是"边形态"与"降级可见性"。定 P2。

### 7.3 修复方案

```js
// 统一包装（新增 relation.js 或 ageGraph.js 内）
export async function mirrorEdge(relType, from, to, props = {}) {
  if (!isAvailable()) {
    emit('trace', 'decision-graph-degraded', { rel: relType, reason: 'age-unavailable' });
    return { ok: false, degraded: true };
  }
  const r = await addEdge(relType, from, to, props);
  if (!r.ok) emit('trace', 'decision-graph-sync-failed', { rel: relType, error: r.error });
  return r;
}
```
`decisionRepo.js:106`、`:188`、`:152` 三处改调 `mirrorEdge`，`.catch` 保留但不吞返回值。

### 7.4 验收

| # | 断言 |
|---|---|
| F1 | AGE 不可用时 emit `decision-graph-degraded` 事件（可通过事件总线订阅断言） |
| F2 | AGE 可用但写失败时 emit `decision-graph-sync-failed`（已有） |
| F3 | 三处调用点主流程均不因镜像失败而阻断 |
| F4 | 现有 `test/decision/*.test.js` 全绿 |

---

## §7B BG-08｜叙事时间线与因果图时间基准不一致（P2 · **本轮新增，待裁决 Q4**）

> 来源：2026-09-01 讨论轮追问"七维含 `time_config`/`decision_history`，为何说边承载不了时序"时发现的连带缺陷。详细论证见 `docs/2026-09-01-bug-verdict-and-tetrad-7dims-7edges-mapping.md` §2.5b。

### 7B.1 现象

叙事时间线、L2 上下文装配、决策边三者使用**不同的时间列**，语义分别为"记录创建时间"与"业务发生时间"。

| 位置 | 使用的时间列 | 语义 |
|---|---|---|
| 叙事时间线（`insightService.js:262`） | `created_at` | 记录创建时间 |
| L2 上下文装配（`assembler.js:73`） | `decided_at DESC` | 业务发生时间 |
| 决策边（`schema.sql:501`） | 仅 `created_at`（无业务发生时间、无有效期） | 记录时间 |

### 7B.2 证据

```js
// src/account/insightService.js:261-263 —— 叙事用 created_at
`SELECT 'decision' AS type, ... created_at,
 FROM crm.decision WHERE involved_entities @> $1::jsonb ORDER BY created_at DESC LIMIT 100`

// src/context/assembler.js:73 —— L2 用 decided_at
`WHERE ($1::text IS NULL OR scenario_id=$1) ORDER BY decided_at DESC LIMIT 5`
```

两类时间在 HITL 场景下**必然分离**：

- `decisionRepo.js:271`（`confirmDecision`）：`decided_at = now()`（人工确认时重写）
- `decisionRepo.js:340`：`human_decided_at = now()`
- `calibration/metrics.js:38-39`：正是以 `human_decided_at - created_at` 计算审批时延——**证明二者被设计为可分离**

生产库实测（`tmp/probe_timebase.mjs`，12 条决策）：`gap_hours` 全为 `0.00`，原因是现有决策均为自主决策、未走 HITL。**缺陷尚未暴露，非"不存在"**。

### 7B.3 判定（三问法）

| 问 | 结论 |
|---|---|
| Q-A 规范是否要求一致 | 是——时间线是唯一全序载体（`insightService.js:115`），基准不一致则全序失效；且叙事与 L2 排序不一致会直接产出矛盾上下文 |
| Q-B 实现是否达成 | 否 |
| Q-C 是否留痕 | 否（无任何告警或断言） |

**性质**：P2，但**与 BG-01b 强耦合**——若先做叙事进注入层而不统一基准，会把不一致固化进模型上下文，后续修正成本更高。故建议**随 BG-01b 一并处理**。

### 7B.4 修复方案

1. **统一时间基准**（BG-01b 内一并完成）：叙事时间线排序与展示时间改用 `COALESCE(decided_at, created_at)`，语义为"业务发生时间，缺失则以记录时间兜底"；
2. **边升为时态边**（独立子项，可与 BG-03 结构扩容合并）：`decision_relation` 增列 `valid_from TIMESTAMPTZ` / `valid_to TIMESTAMPTZ`，写入时取源/靶决策的 `decided_at`；`OVERRIDES` 语义要求"自某时起被覆盖"，无生效时点则该边语义不完整；
3. **一致性断言**：新增测试，构造 HITL 决策（created_at ≠ decided_at），断言时间线排序与 L2 排序一致。

### 7B.5 验收

| # | 断言 |
|---|---|
| F1 | 叙事时间线排序键为 `COALESCE(decided_at, created_at)` |
| F2 | 构造 `created_at` 早于 `decided_at` 24h 的决策，时间线将其排在同期更早创建的决策之后 |
| F3 | 同一批决策，时间线顺序与 L2 装配顺序一致 |
| F4 | 现有 `test/account/*.test.js` 与 `test/context.test.js` 全绿 |

---

## §8 待裁决项（**实施前必须闭环**）

| # | 问题 | 选项 | 建议 |
|---|---|---|---|
| **Q1** | BG-03 采用哪种结构扩容 | A 新建 `decision_entity_relation`（4 处读路径 UNION）<br>B `decision_relation` 加 `to_type` + 放宽 FK（读路径零改动） | **A**——审计资产的表语义纯洁性优先；若选 B 须补应用层存在性守卫 |
| **Q2** | BG-01b 叙事时间线的 scope 来源 | ① `intent.account_id` / `intent.entity_id`（任务载荷显式携带）<br>② 从 `actor` 的 scope 反查（当前客户/负责客户）<br>③ 两者结合，缺失则不注入 | **③**——① 精确但要求调用方改造，② 兜底但可能过宽 |
| **Q3** | BG-07（L1 哈希向量）是否纳入本次修复 | ① 纳入，一并换 SiliconFlow embedding<br>② 不纳入，另立任务 | **②**——按三问法"规范是否要求"存疑（`embedding.js:2` 注释自陈"生产可注入真模型"，属**未完成的集成**而非缺陷）；且它独立性强，混入会拉长关键路径 |
| **Q4** | BG-08（时间基准不一致）是否纳入本次修复 | ① 随 BG-01b 一并处理（含边升时态边）<br>② 仅做基准统一，时态边延后<br>③ 不纳入，另立任务 | **②**——基准统一成本极低（一个 `COALESCE`）且能避免固化错误；`valid_from/valid_to` 涉及 schema 变更，建议与 BG-03 结构扩容合并窗口做，不单独立项 |

### BG-07 补充说明（不纳入本文档范围，仅备案）

```js
// src/ontology/embedding.js:1-2
// 确定性哈希向量（零外部依赖，可跑全量测试）
// 生产可注入真模型（llm.ts 换 SiliconFlow embedding），向量维度须与 schema 对齐（vector(384)）
```

- 现状：`assembler.js:43` 用 `hashVector(q)`，语义检索实质无效；真正生效的是 `:50-62` 的**精确名匹配兜底**；
- 影响：无法支撑"张总上月提了什么顾虑"式语义查询；
- 建议：另立任务，注入 SiliconFlow embedding，维度须与 `vector(384)` 对齐，并保留 `hashVector` 作为测试/降级路径。

---

## §9 BG-01b｜叙事时间线进注入层（依赖 Q2）

### 9.1 现状：装配器已存在但只供页面

```js
// src/account/insightService.js:106 —— 统一的叙事装配器（多源事件 → 时间线，倒序 + 同秒同实体去重）
export function buildTimelineRows(sources) { ... }
// src/account/insightService.js:244 —— 数据源（events / tasks / decision / memory_log 四源归一）
export async function loadTimelineSources(accountId, dealIds = []) { ... }
```

调用点仅 `src/http/routes.js:1290`（客户 360 页面渲染）——**模型侧零消费**。

### 9.2 修复方案

```js
// src/context/assembler.js:69 retrieveL2 增加（伪代码）
async function retrieveL2(actor, intent) {
  const scenario = intent?.scenario || null;
  const r = await query(...);                       // 不变（:71-75）
  const m = await retrieveMemory(...);              // 不变（:76）
  let timeline = [];
  const scopeId = intent?.account_id || intent?.entity_id || null;   // 依赖 Q2
  if (scopeId) {
    const src = await loadTimelineSources(scopeId, intent?.deal_ids || []).catch(() => []);
    timeline = buildTimelineRows(src).slice(0, BUDGET.timeline_max);
  }
  return { decisions: r.rows, memories: m.rows, timeline };
}
```

```js
// src/context/injector.js 追加（伪代码）
if (layers.L2?.timeline?.length) {
  parts.push(`客户故事线(最近 ${layers.L2.timeline.length} 条):\n  `
    + layers.L2.timeline.map((t) => `${t.ts.slice(0,10)} ${t.source} ${t.title}${t.summary ? '｜'+t.summary : ''}`).join('\n  '));
}
```

### 9.3 关键约束

| 约束 | 说明 |
|---|---|
| **循环依赖** | `assembler.js` ← `account/insightService.js`：实施前须确认 `insightService.js` 未反向 import `context/*`。若存在，改为运行时惰性 `await import()` |
| **降级不抛** | `loadTimelineSources` 失败或 `scopeId` 缺失 → `timeline=[]`，**不标 degraded**（时间线是增强不是必需） |
| **token 预算** | `BUDGET.timeline_max` 默认 20，走 `config_store['context-budget']` |
| **版本化**（后续） | 叙事条目需带 `superseded_by`，后发生的同类条目注入时压掉先前的（不删除），否则不可审计。本次可先不做，但**注入格式需预留该字段位** |

### 9.4 验收

| # | 断言 |
|---|---|
| G1 | `intent.account_id` 存在时，`bundle.layers.L2.timeline` 非空且按 ts 倒序 |
| G2 | `intent` 无 account_id 时 `timeline=[]` 且 `degraded` 不被置为 true |
| G3 | `formatForPrompt` 输出含"客户故事线"块，条目格式含日期+来源+标题 |
| G4 | `timeline` 超过 `timeline_max` 时被截断 |
| G5 | 现有 `test/account-insight.test.js`（`buildTimelineRows` 用例）与 `test/context.test.js` 全绿 |

---

## §10 涉及文件清单

| 文件 | 关联缺陷 | 改动性质 |
|---|---|---|
| `src/context/injector.js` | BG-01a, BG-01b | 改格式串 + 新增 timeline 块 |
| `src/context/assembler.js` | BG-01a, BG-01b | `retrieveL2` 补 timeline 装配 |
| `src/account/insightService.js` | BG-01b | 仅被复用，**本次不改**（除非循环依赖） |
| `src/decision/relation.js` | BG-03, BG-05a | 新增 `linkEntity()`、`WRITABLE_EDGES`、`listTypedEdges` UNION/选项 |
| `src/decision/decisionRepo.js` | BG-02, BG-03b, BG-06 | `:106/:152/:188/:307` 四处改统一入口 |
| `src/decision/ageGraph.js` | BG-06 | 新增 `mirrorEdge()` |
| `src/decision/traceRootCause.js` | BG-03, BG-04 | `:126` 读路径 UNION + 运行时口径 |
| `src/decision/closure.js` | BG-04 | `:40` 运行时口径；`:96` D2 判定 |
| `src/monitor/attribution.js` | BG-03, BG-04, BG-05a | `:80` 读路径；装弹自检接入 |
| `src/http/routes.js` | BG-04 | `:2056` 边查询加口径区分 |
| `src/sevenDimensions/*` 或 S20 保存路径 | BG-05a | 装弹自检闸门 |
| `db/schema.sql` | BG-03 | 新增 `decision_entity_relation`（方案 A）或 ALTER（方案 B） |
| `db/migrate.js` | BG-03 | **必须**用独立 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` 段或独立 `CREATE TABLE IF NOT EXISTS`（整文件单事务，一处报错全量回滚） |
| `scripts/seed-decision-network.mjs` | BG-04 | 可选：种子行增加语义标注 |
| `test/**` | 全部 | 每 Task 配套用例 |

### 迁移铁律（项目踩坑记录，务必遵守）

> 新增列若只写在 `CREATE TABLE IF NOT EXISTS` 段内，旧库（表已存在）**不会补列**；后续依赖该列的 `CREATE INDEX IF NOT EXISTS` 会报列不存在，而 `db/migrate.js` 是**整文件单事务** → 一处报错导致**全量迁移整体回滚**。
> 新增表用独立 `CREATE TABLE IF NOT EXISTS`（BG-03 方案 A 安全）；新增列必须走独立 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` 段。

---

## §11 验收与回归策略

### 11.1 全量基线

- 修复前跑一次全量，记录基线（当前 **398/398 绿**）。
- **禁止并发两个 vitest**（互 TRUNCATE 同库导致伪失败）；全量单进程可能耗尽 `max_connections`（报 `too many clients already`）——判定真回归的标准是**失败文件单独小批量重跑仍红**。

### 11.2 每 Task 的最小回归集

| Task | 必跑 |
|---|---|
| T0/T1/T2 | `test/context.test.js`、`test/account-insight.test.js`、`test/decision/*` |
| T3 | `test/decision/decision-relation.test.js`、`test/decision/db-relation.test.js` |
| T4 | `test/decision/edgeCompliance.test.js`、`test/decision/edgeDimensionSpec*.test.js`、`test/decision/rootCause*.test.js` |
| T5/T6 | 上述 + `test/decision/drillthrough-fields.test.js`、`test/decision/closure*` |
| T7 | 全量 |
| T8 | `test/context.test.js`、`test/account-insight.test.js` |

### 11.3 生产库 vs 测试库双态

> `vitest` 强制连 `plm_test`（`vitest.config.js:9`），裸 `node` / 服务连生产库 `plm`。**测试全绿 ≠ 生产可用**。
> T5（DDL）完成后必须用 `information_schema.tables` / `information_schema.columns` **直查生产库**确认已应用；滞后时补跑 `PGDATABASE=plm node db/migrate.js`（幂等，但属生产写操作，需用户授权）。

---

## §12 非目标（本文档不做）

| 项 | 理由 |
|---|---|
| **D4 智能体接线修复** | 已有独立设计 `docs/2026-09-01-retro-agent-wiring-design.md`，待批准。注：BG-01 的收益（更好的上下文）以 SKILL 真被调用为前提，D4 是其**上游依赖**，建议优先裁决 |
| **BG-07 embedding 换真** | 见 §8-Q3，另立任务 |
| **visit_notes 双层化**（原始记录 + AI 派生） | 属增强非缺陷，需单独 brainstorming |
| **外部数据富化 / 邮件起草** | 属 Lightfield 对标的功能补齐，非缺陷 |
| **`REFERENCED_PRECEDENT` 可见性** | 经核实已双写（`decisionRepo.js:143` + `:157`），**非缺陷**。前两轮"权威表看不到"的判断已更正 |
| **删除任何演示数据** | 项目铁律禁止 DELETE，一律走口径隔离 |

---

## §13 附：核验脚本

| 脚本 | 用途 | 状态 |
|---|---|---|
| `tmp/probe_edges_readonly.mjs` | 边分布 + 决策数 + 场景装弹概览 | 已存在 |
| `tmp/probe_edges2.mjs` | 边明细（source / 端点是否为 decision）+ 装弹明细 | 已存在 |
| `tmp/probe_dims.mjs` | 逐场景 `required_dims` 明细 | 已存在 |

T4 需新增（只读）：`tmp/probe_edge_writability.mjs` —— 输出 `场景 → required_dims → 应连边 → 不可写边` 风险台账。

---

## §14 交付确认

- [ ] §8 三项裁决已闭环（Q1 结构方案 / Q2 scope 来源 / Q3 是否纳入 BG-07）
- [ ] D4 接线设计的处置已明确（并行 / 先行 / 后置）
- [ ] 本文档已由用户批准
- [ ] 批准后进入 `writing-plans` 产出实施计划，再进入实现
