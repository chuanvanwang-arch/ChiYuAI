# C-DAI 决策问责闭环基础设施 — 测试计划（Test Plan）

> **For agentic workers:** REQUIRED SUB-SKILL: 本计划与 `2026-08-30-cdai-dev-plan.md` 配对使用；测试先行（先写失败测试 → 实现 → 通过 → commit）。步骤使用 checkbox（`- [ ]`）语法跟踪。

**Goal:** 为 C-DAI（三图 K/M/J 支撑的闭环底座）建立可机器验证的测试套件，覆盖"三闭环运作（感知-应用-反馈）"与"跨环数据传递与反馈溯源"两个维度，并锁定与在途 J2/J3、全链路溯源设计的一致性。

**Architecture:** 测试以真实代码状态为基准（非设计文档的状态标记）。代码已领先设计：`relation.js`(G1)、`provenance.js`(G3 链)、`confidence.js`(G5)、`calibration/store.js`(6.5 13 类 KNOBS + 第0闸) 及对应 schema 迁移均已落地，配套测试已存在。本计划「状态对账」一节据实区分**仅验证**与**需新建**两类，避免重复造轮子。

**Tech Stack:** Node 22 + vitest 3（`vitest.config.js` 强制 `PGDATABASE=plm_test`，`fileParallelism:false` + `singleFork` 单进程顺序执行）；PostgreSQL 16（plm_test @5433，与业务库 plm/crm 隔离）；测试库 `TRUNCATE` 仅清 plm_test。

---

## §1 当前状态对账（代码事实 vs 设计标记）

> 来源：`src/decision/*.js`、`src/ruleEngine.js`、`src/calibration/*.js`、`src/monitor/attribution.js`、`db/schema.sql` 迁移段（line 486–549）、`test/*`。

| 设施 | 设计标记 | 真实代码状态 | 测试现状 | 测试缺口（本计划覆盖） |
|---|---|---|---|---|
| **G1** `decision_relation` 7边+`serves_dimension` | ❌→建 | ✅ `relation.js` + `schema.sql:490-504`（`serves_dimension TEXT NOT NULL`）+ `edgeDimensionSpec.js` | ✅ `test/decision/db-relation.test.js`、`test/age-graph.test.js` | 补：`serves_dimension` 断言 + E1–E7×维度绑定断言 |
| **G2** `decision_rule`+`rule_hit`+mini-Rete | ❌→建 | ⚠️ `ruleEngine.js` 硬编码 2 规则；`alertRegistry.js` 内存 7 条；`approval/rules.js` 3 常量 | ❌ 无 `decision_rule`/`rule_hit` 表测试 | **新建**：规则 DB 化 + `rule_hit` 落库率 100% + 迁移 parity |
| **G3** PROV-O 链 + 导出 + 归档 | ❌→建 | ⚠️ `provenance.js` SHA-256 链 + `verifyChain` + `exportAudit`(JSON) 已落 | ⚠️ 无 PROV-O **标准格式**(Turtle/RDF) 测试 | **新建**：Turtle 导出 + EU AI Act 字段 + 归档分级 |
| **G4** 冲突 5 策略 + `source_credibility` | ❌→建 | ⚠️ `conflict.js` 仅 `adoptValue`；`assertions` 表无 `source_credibility` | ⚠️ `test/conflict.test.js` 仅测 `adoptValue` | **新建**：5 策略 + `source_credibility` 列 + 第0闸消解 |
| **G5** `decision.confidence` 提列 | 🟡→升 | ⚠️ `confidence.js` 纯函数存在；`schema.sql:531-538` 列已加；但 `decisionRepo` 写回路径**未接线**（import 未调用） | ⚠️ `test/decision/confidence.test.js` 仅测纯函数 | **新建**：写回路径测试（outcome/human → 列落库） |
| **G6** 记忆向量化 + RRF | ❌→建 | ⚠️ `memoryLog.js` `LIKE` 前缀检索；schema 仅 2 处 vector | ❌ 无 RRF 测试 | **新建**：dense+sparse 融合召回 + 混合排序 |
| **G7** 溯源端点鉴权 | 🟡→升 | ⚠️ `routes.js:1802-1823` `/api/graph/*` 无鉴权 vs `calibrationRouter` 全 sysadmin；`routes.js:1729-1756` DEPRECATED | ❌ 无鉴权测试 | **新建**：鉴权 + scope + DEPRECATED 下线 |
| **6.1** `outcome`/`feedback`/`root_cause` | ❌→建 | ⚠️ `schema.sql:531-538` 列已加；`outcome.js`/`outcomeIngester.js` 存在 | ⚠️ `test/decision/db-outcome*.test.js` 覆盖 outcome；`root_cause` 写入未测 | **新建**：`root_cause` 写入 + `feedback` JSONB 结构 |
| **6.2** `decision_relation.serves_dimension`+`config_store.edge_bindings` | ❌→建 | ⚠️ `serves_dimension` 列已加；`config_store.edge_bindings` 键未建 | ❌ | **新建**：edge_bindings 配置读写 + E1–E7×维度校验 |
| **6.3** `meta_attr.required`+`source_refresh_sla` | ❌→建 | ⚠️ `schema.sql:540-541` `source_refresh_sla` 已加;`required` 已存在 | ❌ | **新建**：溯源④跳"信息不完整/输入不及时"检测 |
| **6.4** `attribution.edge_compliance`+`category` 七态 | 🟡→升 | ⚠️ `attribution.js:13/30-31` 仅 `ok`/`input_missing`/`inference_bias` 三态 | ⚠️ `test/decision/attribution-writeback.test.js` 三态 | **新建**：扩七态 + `edge_compliance` 数组 |
| **6.5** `calibration_patch.knob` 7+ 类 | ❌→建 | ✅ `store.js:17-21` KNOBS 13 类；`schema.sql:545-549` 枚举已扩；第0闸已接线 | ✅ `test/calibration/*`（store/knobs/parity/rules/replay） | **仅验证**：parity 锁死 + EDGE_BINDING 别名 |
| **6.6** SHACL-equivalent 写时校验 | ❌→建 | ❌ 无 `normalizeFacts()` | ❌ | **新建**：写时类型归一化 + `meta_attr` 约束拦截脏事实 |

**结论**：G1/G5(纯函数)/6.5 已落地，属**仅验证**；G2/G3(导出)/G4/G6/G7/6.1(root_cause)/6.2/6.3/6.4/6.6 为**需新建**测试。测试计划据此分配工作量。

---

## §2 测试策略（全局约定）

1. **TDD 铁律**：每个新建设施先写失败测试（红）→ 实现（绿）→ commit。开发计划 §3 每 Task 与之对应。
2. **AGE 开/关 parity**：所有图遍历（trace/impact/relation）必须有「AGE 可用」与「AGE 不可用（降级走 PG）」双用例，断言逐边相等（`enrichTraceWithRelType` 输出一致）。依据：`relation.js:3` 单一事实源。
3. **单进程隔离**：`vitest` 已 `fileParallelism:false`+`singleFork`。**禁止并发两 vitest**（互 TRUNCATE 同库伪失败，见踩坑铁律）。
4. **测试库**：连 `plm_test`（`PGDATABASE` 由 `vitest.config.js` 强制）。业务脚本连 `plm`，互不干扰。
5. **决策第0闸**：所有写操作测试须经 `produceDecision`（`store.js:46`）产生真实 `decision_id`；断言 `calibration_patch.decision_id` 非空。
6. **禁物理删**：测试断言 `decision_provenance`/`assertions` 用 `invalidated`/`valid` 标记而非 DELETE（对齐 Semantica never hard delete）。
7. **归属代理契约**：所有 C-DAI 测试归 `decision-retro` 智能体（`src/agent/agentSpec.js`：knowledgeScope L1–L3、skillCalls `decision-retrospective`+`data-particle-read`）。测试文件头注释标注契约。

---

## §3 维度一：三闭环运作（感知-应用-反馈）测试矩阵

每个图本身是一个控制论闭环。下表把"感知/应用/反馈"三段的验证点映射到具体测试文件与断言。

### §3.1 K 知识图谱闭环
| 阶段 | 验证点 | 测试文件 | 关键断言 |
|---|---|---|---|
| 感知 | hooks 解析 + 21 谓词 + `meta_attr` 写时校验(6.6) | `test/particle/normalizeFacts.test.js`（新建） | 脏事实（类型不符/`required` 缺失）被 `normalizeFacts()` 拦截；合法事实落 `particles` |
| 感知 | `meta_attr.required`/`source_refresh_sla`(6.3) | `test/particle/metaAttr.test.js`（新建） | 缺失 `required` 字段 → 写入拒绝；`source_refresh_sla` 过期 → 标记 stale |
| 应用 | assembler L1–L4 装配 + 图遍历 | `test/context/assembler.test.js`（沿用） | L1–L4 装配结果与 `decision_relation` 一致 |
| 应用 | RRF 融合检索(G6) | `test/memory/rrf.test.js`（新建） | dense+sparse 融合排序优于单路；topk 可配 |
| 反馈 | dedup 软合并 + backfill | `test/particle/dedup.test.js`（沿用） | 软合并走 `merged_into`，无物理删；backfill 幂等 |

### §3.2 M 上下文图谱闭环
| 阶段 | 验证点 | 测试文件 | 关键断言 |
|---|---|---|---|
| 感知 | 七点 Schema + `decision_relation` E1–E7(G1) | `test/decision/db-relation.test.js`（扩） | `linkDecisions` 双写 AGE+PG；`serves_dimension` 落库；E1–E7 全有落点 |
| 感知 | `attribution` 七态 + `edge_compliance`(6.4) | `test/decision/attribution.test.js`（扩） | `category` ∈ 七态；`edge_compliance` 数组含 E1–E7 应存/实存/缺 |
| 应用 | trace/impact/precedent | `test/age-graph.test.js`（沿用）+ `test/decision/decisionRepo.test.js`（扩） | AGE 开/关 parity 逐边相等；`searchPrecedents` 相似度阈值生效 |
| 反馈 | 30 天蒸馏 + 不可变快照 | `test/decision/decisionRepo.test.js`（扩） | `distillPrecedents` 折扣非删除；`memory_snapshot` 时间点重放一致 |

### §3.3 J 决策图谱闭环（含 J1/J2/J3 三阶段）
| 阶段 | 验证点 | 测试文件 | 关键断言 |
|---|---|---|---|
| 感知(J1) | createDecision 第0闸 + confidence(G5) | `test/decision/decisionRepo.test.js`（扩）+ `test/decision/confidence.test.js`（扩） | 写回路径将 `computeConfidence` 结果写入 `decision.confidence`+`confidence_source`+`confidence_at` |
| 感知(J1) | `outcome`/`feedback`/`root_cause`(6.1) | `test/decision/db-outcome.test.js`（扩）+ `test/decision/rootCause.test.js`（新建） | `rootCauseClassifier` 七类 → `decision.root_cause` JSONB 落库 |
| 应用(J1) | mini-Rete 规则门(G2) + PROV-O(G3) | `test/rule/ruleEngine.test.js`（新建）+ `test/decision/provenance.test.js`（扩） | `rule_hit` 落库率 100%（含 block）；`verifyChain` 返回 OK |
| 反馈(J2) | 业务结果回写 + 双率 | `test/decision/db-outcome-ingester.test.js`（扩） | `outcomeIngester` 订阅 payment 总线；`getGateOutcome` 双率对比 |
| 反馈(J3) | 校准写回 K/M(6.5) + 冲突(G4) | `test/calibration/store.test.js`（沿用）+ `test/conflict.test.js`（扩） | `approvePatch` 经第0闸；5 策略消解经第0闸产生 decision 行 |

---

## §4 维度二：跨环数据传递与反馈溯源测试矩阵

### §4.1 五条跨环链路（D1–D5）
| 链路 | 方向 | 测试文件 | 关键断言 |
|---|---|---|---|
| **D1** K→M | 知识注入上下文 | `test/decision/attribution.test.js` | `computeAttribution` 读取 `meta_attr`/`particles` 生成 `required_fill` |
| **D2** M→J | 上下文注入决策 | `test/decision/decisionRepo.test.js` | `createDecision` 写入 `attribution`+`trigger_context` 来自 M |
| **D3** J→K | 校准回写知识 | `test/calibration/store.test.js` + `test/particle/normalizeFacts.test.js` | `approvePatch(knob=meta_attr_map/particle_attr_add)` 经第0闸改 K；`decision_id` 锚定 |
| **D4** J→M | 结果反哺记忆 | `test/decision/db-outcome.test.js` | `writebackOutcome` 更新 `attribution.outcome_verified` |
| **D5** K↔M | 双向写时约束 | `test/particle/metaAttr.test.js` + `test/decision/attribution.test.js` | `meta_attr.required` 变更触发 M 层 `edge_compliance` 重算 |

**关键判据**：D3/D4 是决策闭环反哺 K/M 的唯一受控通道，**必须 100% 经第0闸**。测试断言：凡改 K/M 的校准动作，`calibration_patch.decision_id` 非空且 `decision.scenario_id='CALIBRATION_CHANGE'`。

### §4.2 反馈溯源链路（四层 + provenance）
`粒子 → memory_snapshot → decision → outcome → calibration_patch`，每跳 provenance：
| 溯源跳 | 测试文件 | 关键断言 |
|---|---|---|
| 粒子 → snapshot | `test/memory/snapshot.test.js`（沿用） | `memory_snapshot` 不可变，`state_at(date)` 重放一致 |
| snapshot → decision | `test/decision/provenance.test.js` | `trackEntry` 链式 SHA-256；`verifyChain` OK |
| decision → outcome | `test/decision/db-outcome.test.js` | `outcome` 回写后 `attribution.outcome_verified` 更新 |
| outcome → calibration_patch | `test/calibration/store.test.js` | `createPatch` 经 `produceDecision`；`before/after` 留存 |
| ④跳整体 | `test/trace/full-trace.test.js`（新建） | 四层串联：粒子属性 → 决策上下文 → 业务结果 → 校准处方，全链 `decision_id` 可追溯 |

---

## §5 每设施具体测试套件（含新建测试代码骨架）

> 下列代码块为"失败测试"起点（红）。测试库 `plm_test`；`beforeEach` TRUNCATE 相关表。

### §5.1 G2 规则 DB 化 + `rule_hit`（新建 `test/rule/ruleEngine.test.js`）
```js
import { describe, it, expect, beforeEach } from 'vitest';
import { queryWrite, query } from '../../src/db.js';
import { ruleEngine } from '../../src/ruleEngine.js';

beforeEach(async () => {
  await queryWrite(`TRUNCATE crm.decision_rule, crm.rule_hit RESTART IDENTITY CASCADE`);
});

describe('G2 decision_rule + rule_hit', () => {
  it('迁移规则到 decision_rule 表并被 ruleEngine 加载', async () => {
    await queryWrite(
      `INSERT INTO crm.decision_rule (code, match_type, match_payload, check_payload, enabled)
       VALUES ('stage_forward_only','CRM_DEAL_advance','{}','{}',true)`);
    const r = await ruleEngine.check('CRM_DEAL', 'advance', { from: 'lead', to: 'lost' });
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain('stage_forward_only');
  });

  it('block 决策留痕 rule_hit 落库率 100%', async () => {
    const res = await ruleEngine.check('CRM_DEAL', 'advance', { to: 'lost' });
    const hits = (await query(`SELECT * FROM crm.rule_hit WHERE blocked=true`)).rows;
    expect(hits.length).toBeGreaterThanOrEqual(1);
  });
});
```

### §5.2 G3 PROV-O Turtle 导出 + 归档（扩 `test/decision/provenance.test.js`）
```js
describe('G3 PROV-O 标准导出', () => {
  it('exportAudit 产出 Turtle 含 entity/activity/agent', async () => {
    const { exportTurtle } = await import('../../src/decision/provenance.js');
    const tt = await exportTurtle({ decision_id });
    expect(tt).toContain('@prefix prov:');
    expect(tt).toMatch(/prov:Entity/);
    expect(tt).toMatch(/prov:wasAttributedTo/);
  });
  it('归档分级：超过 retention_days 的 entry 标记为 archived', async () => {
    const { applyArchival } = await import('../../src/decision/provenance.js');
    const r = await applyArchival({ decision_id, retentionDays: 365 });
    expect(r.archived).toBeGreaterThanOrEqual(0);
  });
});
```

### §5.3 G4 冲突 5 策略 + `source_credibility`（扩 `test/conflict.test.js`）
```js
describe('G4 冲突 5 策略', () => {
  it('timestamp 策略：取最新值', async () => {
    const { resolveConflict } = await import('../../src/decision/conflict.js');
    const r = await resolveConflict(entity, attr, 'timestamp');
    expect(r.winner.source_id).toBe(latestSource);
  });
  it('human_arbitration 策略：必须产出 decision 行（第0闸）', async () => {
    const r = await resolveConflict(entity, attr, 'human_arbitration', { produceDecision });
    expect(r.decisionId).toBeTruthy();
  });
  it('source_credibility 列影响 confidence_weighted 裁决', async () => {
    // 高 credibility 源胜出
  });
});
```

### §5.4 G5 写回路径（扩 `test/decision/confidence.test.js`）
```js
describe('G5 confidence 写回', () => {
  it('writebackOutcome 写入 decision.confidence', async () => {
    const { writebackOutcome } = await import('../../src/decision/decisionRepo.js');
    await writebackOutcome(decisionId, 'won');
    const d = (await query(`SELECT confidence, confidence_source FROM crm.decision WHERE decision_id=$1`,[decisionId])).rows[0];
    expect(d.confidence).toBeCloseTo(0.9);
    expect(d.confidence_source).toBe('outcome_verified');
  });
});
```

### §5.5 G6 RRF 融合（新建 `test/memory/rrf.test.js`）
```js
describe('G6 RRF dense+sparse 融合', () => {
  it('融合排序优于单路召回', async () => {
    const { rrfSearch } = await import('../../src/memory/memoryLog.js');
    const res = await rrfSearch(query, { entityId, k: 5, denseWeight: 0.5 });
    expect(res.length).toBeLessThanOrEqual(5);
    expect(res[0].score).toBeGreaterThanOrEqual(res[1]?.score ?? 0);
  });
});
```

### §5.6 G7 鉴权（新建 `test/http/graph-auth.test.js`）
```js
describe('G7 /api/graph/* 鉴权', () => {
  it('未授权访问 /api/graph/trace 返回 401', async () => {
    const res = await agent.get('/api/graph/trace?id=x');
    expect(res.status).toBe(401);
  });
  it('DEPRECATED 端点已下线（410）', async () => {
    const res = await agent.get('/api/graph/legacy'); // routes.js:1729-1756
    expect(res.status).toBe(410);
  });
});
```

### §5.7 6.1/6.2/6.3/6.4/6.6（新建测试骨架，详见开发计划 §3 对应 Task）
- **6.1** `test/decision/rootCause.test.js`：七类根因 → `decision.root_cause` JSONB。
- **6.2** `test/config/edgeBindings.test.js`：`config_store.edge_bindings` 读写 + E1–E7×维度校验。
- **6.3** `test/trace/infoCompleteness.test.js`：溯源④跳"信息不完整/输入不及时"检测。
- **6.4** `test/decision/attribution.test.js`（扩）：`category` 七态 + `edge_compliance` 数组。
- **6.6** `test/particle/normalizeFacts.test.js`：写时拦截脏事实。

---

## §6 验收闸（测试计划维度）

| 设施 | 测试验收闸 |
|---|---|
| G1 | `db-relation.test.js` 断言 E1–E7 全落点 + AGE 开/关 parity 逐边相等 |
| G2 | `ruleEngine.test.js`：迁移规则逐条 parity；`rule_hit` 落库率 100%（含 block）；规则 DML 100% 经第0闸 |
| G3 | `provenance.test.js`：Turtle 导出含 entity/activity/agent；归档分级可配；`verifyChain` OK |
| G4 | `conflict.test.js`：5 策略可配；自动消解经第0闸产生 decision 行 |
| G5 | `confidence.test.js`：写回路径写入 `decision.confidence`+`source`+`at` |
| G6 | `rrf.test.js`：融合排序优于单路；topk 可配 |
| G7 | `graph-auth.test.js`：未授权 401；DEPRECATED 410 |
| 6.1 | `rootCause.test.js`+`db-outcome.test.js`：`feedback`/`root_cause` 落库 |
| 6.2 | `edgeBindings.test.js`：edge_bindings 读写 + E1–E7×维度校验 |
| 6.3 | `infoCompleteness.test.js`：④跳检测触发 |
| 6.4 | `attribution.test.js`：`category` 七态 + `edge_compliance` 数组 |
| 6.5 | `calibration/parity.test.js`：KNOBS 13 类 parity 锁死（仅验证） |
| 6.6 | `normalizeFacts.test.js`：脏事实拦截 |

**全局**：全量 `vitest` 单进程通过；无并发两 vitest；所有写操作测试经第0闸。

---

## §7 与开发计划及在途文档交叉引用

- **配对文档**：`2026-08-30-cdai-dev-plan.md`（T1–T14，每 Task 失败测试即本节对应套件）。
- **设计源**：`2026-08-30-semantica-decision-accountability-design.md`（§4 设施清单 + §7 两维度细分）。
- **在途闭环**：`2026-08-30-j2-j3-comprehensive-design.md`（J2/J3 测试触发 T15–T32）、`2026-08-30-full-traceability-root-cause-design.md`（四层溯源测试 = §4.2 ④跳）。
- **单一事实源**：`decision.confidence`/`decision_relation` 由 C-DAI 唯一定义，闭环 T15–T32 复用，禁止重复建列（见设计 §4 铁律三）。
