# C-DAI 决策问责闭环基础设施 — 开发计划（Dev Plan）

> **For agentic workers:** REQUIRED SUB-SKILL: 与 `2026-08-30-cdai-test-plan.md` 配对；TDD 先写失败测试 → 实现 → 通过 → commit。步骤用 checkbox（`- [ ]`）。

**Goal:** 把 C-DAI 从"设计 v2 三图闭环"落地为可运行的确定性底座，补齐与在途 J2/J3、全链路溯源设计一致的 G1–G7 + 6.1–6.6 设施，并消除 `decision.confidence`/`decision_relation` 重复定义。

**Architecture:** 借鉴自研形态（不引 Semantica 依赖）。以真实代码状态为基准：G1/G5(纯函数)/6.5 已落地→**仅验证**；G2/G3(导出)/G4/G6/G7/6.1(root_cause)/6.2/6.3/6.4/6.6→**新建**。所有写操作经决策第0闸（`calibration/store.js:produceDecision`，`scenario_id='CALIBRATION_CHANGE'`）；禁物理删（用 `invalidated`/`valid` 标记）。

**Tech Stack:** Node 22 + ESM + Express 4 + PostgreSQL 16（plm_test @5433）；vitest 3（`fileParallelism:false`+`singleFork`）；受控渲染（`renderPage`+`page.css`）。

---

## §1 文件结构（创建/修改/测试）

| 设施 | 新建文件 | 修改文件 | 测试文件（见测试计划） |
|---|---|---|---|
| G2 | `src/decision/ruleStore.js`；`db/migration-decision-rule.sql` | `src/ruleEngine.js`（加载 DB 规则+落 `rule_hit`） | `test/rule/ruleEngine.test.js` |
| G3 | — | `src/decision/provenance.js`（加 `exportTurtle`+`applyArchival`） | `test/decision/provenance.test.js` |
| G4 | — | `src/decision/conflict.js`（加 `resolveConflict`+`source_credibility`）；`db/migration-assertions-cred.sql` | `test/conflict.test.js` |
| G5 | — | `src/decision/decisionRepo.js`（`writebackOutcome`/`writebackHumanDisposition` 接线 confidence） | `test/decision/confidence.test.js` |
| G6 | — | `src/memory/memoryLog.js`（加 `rrfSearch`） | `test/memory/rrf.test.js` |
| G7 | — | `src/http/routes.js`（加 `/api/graph/*` 鉴权 + 下线 DEPRECATED） | `test/http/graph-auth.test.js` |
| 6.1 | — | `src/decision/rootCauseClassifier.js`（写 `root_cause`）；`src/decision/outcomeIngester.js`（写 `feedback`） | `test/decision/rootCause.test.js` |
| 6.2 | — | `src/portal/configCenter.js`+`config.html`（加 `edge_bindings` 页签） | `test/config/edgeBindings.test.js` |
| 6.3 | — | `src/monitor/attribution.js`（加 stale/late 检测） | `test/trace/infoCompleteness.test.js` |
| 6.4 | — | `src/monitor/attribution.js`（扩七态 + `edge_compliance`） | `test/decision/attribution.test.js` |
| 6.6 | `src/particles/normalizeFacts.js` | `src/particles/particleRepo.js`（写前调用） | `test/particle/normalizeFacts.test.js` |
| G1/6.5 | — | （已落地，仅补断言/parity） | `test/decision/db-relation.test.js`、`test/calibration/parity.test.js` |

---

## §2 实施顺序与依赖

```
底座先行（确定性）→ 智能层（T15–T32 在途）
G1(已) → G5(接线) → G6 → 6.6 → 6.3 → 6.4   [K/M 底座]
  → G2(规则门) → G3(导出) → G7(鉴权)         [J 应用环]
  → G4(冲突) → 6.1(root_cause) → 6.2(edge_bindings) → 6.5(已) [J 反馈环]
  → T11/T12/T13/T14 (UI/配置集成)
```

**依赖**：G2/G3/G4 的写操作测试依赖第0闸（`store.js:produceDecision`，已就绪）。G6 依赖现有 `hashVector`（`ontology/embedding.js`）。6.2 依赖 `edgeDimensionSpec.js`（`primaryDimension`）。

---

## §3 逐设施 TDD 任务（bite-sized）

> 每个新建设施：先写测试计划 §5 对应失败测试 → 运行红 → 实现 → 运行绿 → commit。仅验证设施：先扩测试断言 → 运行 → 若绿则仅补 parity 注释。

### Task 1（G5）— confidence 写回路径接线
**Files:** Modify `src/decision/decisionRepo.js:294-301`（`writebackOutcome`）、`282-291`（`writebackHumanDisposition`）
- [ ] **Step 1: 写失败测试**（`test/decision/confidence.test.js` 扩，见测试计划 §5.4）
- [ ] **Step 2: 运行红** `npx vitest run test/decision/confidence.test.js` → FAIL（confidence 列为 null）
- [ ] **Step 3: 实现** 在 `writebackOutcome` 中加：
```js
import { computeConfidence } from './confidence.js'; // 已在 :14 import
// 在 applyOutcome 后：
const conf = computeConfidence({ outcomeVerified: outcome, humanDisposition: cur.human_disposition });
await queryWrite(
  `UPDATE crm.decision SET confidence=$2, confidence_source='outcome_verified', confidence_at=now() WHERE decision_id=$1`,
  [decisionId, conf]);
```
同理 `writebackHumanDisposition` 用 `humanDisposition` 反算，`confidence_source='human_disposition'`。
- [ ] **Step 4: 运行绿** → PASS
- [ ] **Step 5: commit** `git add src/decision/decisionRepo.js test/decision/confidence.test.js && git commit -m "feat(G5): wire computeConfidence into outcome/human writeback"`

### Task 2（G2）— 规则 DB 化 + `rule_hit`
**Files:** Create `db/migration-decision-rule.sql`、`src/decision/ruleStore.js`；Modify `src/ruleEngine.js`
- [ ] **Step 1: 写失败测试**（`test/rule/ruleEngine.test.js`，测试计划 §5.1）
- [ ] **Step 2: 运行红** → FAIL（无 `decision_rule`/`rule_hit` 表）
- [ ] **Step 3: 实现**
```sql
-- db/migration-decision-rule.sql
CREATE TABLE IF NOT EXISTS crm.decision_rule (
  id BIGSERIAL PRIMARY KEY, code TEXT UNIQUE NOT NULL,
  match_type TEXT NOT NULL, match_payload JSONB NOT NULL DEFAULT '{}',
  check_payload JSONB NOT NULL DEFAULT '{}', enabled BOOLEAN DEFAULT true,
  decision_id UUID REFERENCES crm.decision(decision_id)  -- 规则经第0闸
);
CREATE TABLE IF NOT EXISTS crm.rule_hit (
  id BIGSERIAL PRIMARY KEY, rule_code TEXT NOT NULL, decision_id UUID,
  blocked BOOLEAN NOT NULL, reasons JSONB, created_at TIMESTAMPTZ DEFAULT now()
);
```
`src/decision/ruleStore.js`：`loadRules()` 从 `decision_rule` 读；`recordHit()` 落 `rule_hit`。`ruleEngine.check` 改为先 `loadRules()` 再逐条 evaluate，block 时 `recordHit({blocked:true})`。迁移 `ruleEngine.js` 现有 2 规则 + `alertRegistry.js`(7) + `approval/rules.js`(3) 到 `decision_rule`（parity 测试锁死行为）。
- [ ] **Step 4: 运行绿** → PASS（含 `rule_hit` 落库率 100% 断言）
- [ ] **Step 5: commit** `git add db/migration-decision-rule.sql src/decision/ruleStore.js src/ruleEngine.js test/rule/ruleEngine.test.js && git commit -m "feat(G2): DB-ize rules + capture rule_hit"`

### Task 3（G3）— PROV-O Turtle 导出 + 归档分级
**Files:** Modify `src/decision/provenance.js`
- [ ] **Step 1: 写失败测试**（测试计划 §5.2）
- [ ] **Step 2: 运行红** → FAIL（`exportTurtle` 未定义）
- [ ] **Step 3: 实现** 在 `provenance.js` 加：
```js
export function exportTurtle({ decision_id, decision, entries, chainStatus }) {
  const L = [];
  L.push('@prefix prov: <http://www.w3.org/ns/prov#>.');
  L.push(`crm:decision_${decision_id} a prov:Entity ; prov:wasAttributedTo crm:agent_engine .`);
  for (const e of entries) L.push(`crm:entry_${e.entry_type} a prov:Activity .`);
  return L.join('\n');
}
export async function applyArchival({ decision_id, retentionDays = 365 }) {
  const r = await queryWrite(
    `UPDATE crm.decision_provenance SET archived=true
     WHERE decision_id=$1 AND created_at < now() - ($2||' days')::interval`,
    [decision_id, retentionDays]);
  return { archived: r.rowCount || 0 };
}
```
- [ ] **Step 4: 运行绿** → PASS
- [ ] **Step 5: commit**

### Task 4（G4）— 冲突 5 策略 + `source_credibility`
**Files:** Modify `src/decision/conflict.js`；Create `db/migration-assertions-cred.sql`
- [ ] **Step 1: 写失败测试**（测试计划 §5.3）
- [ ] **Step 2: 运行红** → FAIL（`resolveConflict` 未定义）
- [ ] **Step 3: 实现** 加 `source_credibility REAL` 列；`resolveConflict(entity,attr,strategy,{produceDecision})` 实现 `timestamp`/`source_priority`/`confidence_weighted`/`merge`/`human_arbitration`；`human_arbitration` 调 `produceDecision`（第0闸）产生 decision 行。
- [ ] **Step 4: 运行绿** → PASS
- [ ] **Step 5: commit**

### Task 5（G6）— RRF 融合召回
**Files:** Modify `src/memory/memoryLog.js`
- [ ] **Step 1: 写失败测试**（测试计划 §5.5）
- [ ] **Step 2: 运行红** → FAIL（`rrfSearch` 未定义）
- [ ] **Step 3: 实现** `rrfSearch(query,{entityId,k,denseWeight})`：dense=pgvector `<=>`、sparse=LIKE/tsvector，RRF 公式 `score=Σ 1/(rank+60)`，混合排序返回 topk。
- [ ] **Step 4: 运行绿** → PASS
- [ ] **Step 5: commit**

### Task 6（G7）— 溯源端点鉴权
**Files:** Modify `src/http/routes.js:1802-1823`（加鉴权中间件）、`1729-1756`（DEPRECATED→410）
- [ ] **Step 1: 写失败测试**（测试计划 §5.6）
- [ ] **Step 2: 运行红** → FAIL（200 而非 401）
- [ ] **Step 3: 实现** 对 `/api/graph/*` 套用与 `calibrationRouter` 同款 sysadmin 鉴权；DEPRECATED 端点返回 410 并移除路由。
- [ ] **Step 4: 运行绿** → PASS
- [ ] **Step 5: commit**

### Task 7（6.1）— `root_cause`/`feedback` 写回
**Files:** Modify `src/decision/rootCauseClassifier.js`、`src/decision/outcomeIngester.js`
- [ ] **Step 1: 写失败测试**（`test/decision/rootCause.test.js`）
- [ ] **Step 2: 运行红** → FAIL（`decision.root_cause` 为 null）
- [ ] **Step 3: 实现** `rootCauseClassifier` 七类归因后 `UPDATE crm.decision SET root_cause=$2::jsonb WHERE decision_id=$1`；`outcomeIngester` 在回写 `outcome` 同时写 `feedback` JSONB（订阅 payment 总线，见设计 §3.2）。
- [ ] **Step 4: 运行绿** → PASS
- [ ] **Step 5: commit**

### Task 8（6.6）— SHACL-equivalent 写时校验
**Files:** Create `src/particles/normalizeFacts.js`；Modify `src/particles/particleRepo.js`
- [ ] **Step 1: 写失败测试**（`test/particle/normalizeFacts.test.js`）
- [ ] **Step 2: 运行红** → FAIL（`normalizeFacts` 未定义）
- [ ] **Step 3: 实现** `normalizeFacts(fact, metaAttr)`：类型归一化 + `required` 缺失/类型不符抛 `ValidationError`（不静默）；`particleRepo` 写前调用，拦截脏事实防误触发 G2 规则。
- [ ] **Step 4: 运行绿** → PASS
- [ ] **Step 5: commit**

### Task 9（6.3）— 溯源④跳信息完整性检测
**Files:** Modify `src/monitor/attribution.js`
- [ ] **Step 1: 写失败测试**（`test/trace/infoCompleteness.test.js`）
- [ ] **Step 2: 运行红** → FAIL（未检测 stale/late）
- [ ] **Step 3: 实现** `computeAttribution` 增加：读 `meta_attr.source_refresh_sla`，超期标记 `category='context_stale'`；`required` 缺失标记 `input_missing`；溯源④跳据此触发"信息不完整/输入不及时"告警。
- [ ] **Step 4: 运行绿** → PASS
- [ ] **Step 5: commit**

### Task 10（6.4）— attribution 七态 + `edge_compliance`
**Files:** Modify `src/monitor/attribution.js`
- [ ] **Step 1: 写失败测试**（扩 `test/decision/attribution.test.js`）
- [ ] **Step 2: 运行红** → FAIL（`category` 仅三态）
- [ ] **Step 3: 实现** `category` 扩至七态（`ok`/`input_missing`/`inference_bias`/`context_stale`/`edge_missing`/`conflict_unresolved`/`rule_blocked`）；加 `edge_compliance` 数组（E1–E7 应存/实存/缺），由 `decision_relation` 实存边比对 `serves_dimension` 期望。
- [ ] **Step 4: 运行绿** → PASS
- [ ] **Step 5: commit**

### Task 11（6.2）— `edge_bindings` 配置中心
**Files:** Modify `src/portal/configCenter.js` + `config.html`（加页签）；`db` 加 `config_store.edge_bindings`
- [ ] **Step 1: 写失败测试**（`test/config/edgeBindings.test.js`）
- [ ] **Step 2: 运行红** → FAIL（键未定义）
- [ ] **Step 3: 实现** `configCenter.js` 加 `EDGE_BINDINGS` 配置项（CONFIG_ITEMS id 扩展）；校验 E1–E7 × 维度绑定完整性；三处同步（configCenter.js / config.html GROUPS / configCenter.test.js）。
- [ ] **Step 4: 运行绿** → PASS
- [ ] **Step 5: commit**

### Task 12（G1/6.5）— 仅验证：parity 补强
**Files:** 扩 `test/decision/db-relation.test.js`、`test/calibration/parity.test.js`
- [ ] **Step 1: 扩断言** `serves_dimension` 落库 + E1–E7×维度绑定（G1）；KNOBS 13 类 parity 锁死 + `EDGE_BINDING` 别名（6.5）
- [ ] **Step 2: 运行** `npx vitest run test/decision/db-relation.test.js test/calibration/parity.test.js` → PASS（已落地，仅补断言）
- [ ] **Step 3: commit** `git commit -m "test(G1/6.5): strengthen parity assertions"`

### Task 13（T11/T12/T13）— 作战室溯源面板 / 巡检卡 / SSE 浮卡骨架
**Files:** Modify `src/web/sales-decision-monitor.html`、`src/portal/...巡检卡`、`src/decision/autoSuggest.js`
- [ ] **Step 1: 写失败测试**（前端/集成测试断言面板渲染溯源抽屉、SSE `calibration` 域）
- [ ] **Step 2: 实现** 单决策四层溯源抽屉（粒子→snapshot→decision→outcome）；巡检卡业务结果行 + 溯源入口；`autoSuggest.js` SSE `calibration` 域推送自动建议浮卡
- [ ] **Step 3: 运行绿** → PASS
- [ ] **Step 4: commit**

### Task 14（T10 / T9）— 双时态 replay(P2) + 可视化
**Files:** `src/decision/provenance.js`（`state_at(date)`）、`src/portal/renderPage.js` + `page.css`
- [ ] **Step 1: 写失败测试**（双时态 `state_at` 重放；可视化受控渲染）
- [ ] **Step 2: 实现** `state_at(date)` 基于 `decision_provenance`+`memory_snapshot` 时间点重放；决策图谱 Cytoscape 受控渲染（复用 `enrichTraceWithRelType`）
- [ ] **Step 3: 运行绿** → PASS
- [ ] **Step 4: commit**

---

## §4 决策第0闸契约（每 Task 写操作）

所有改 K/M/J 的写操作（G2 规则 DML、G4 消解、6.1 root_cause、6.2 edge_bindings、6.5 calibration）必须经 `produceDecision`（`src/calibration/store.js:46`）产生真实 `decision_id`，且 `scenario_id='CALIBRATION_CHANGE'`。测试断言 `calibration_patch.decision_id`/对应表 `decision_id` 非空。

**归属代理**：`decision-retro`（`src/agent/agentSpec.js`：knowledgeScope L1–L3、skillCalls `decision-retrospective`+`data-particle-read`）。

---

## §5 验收（开发计划维度，对齐测试计划 §6）

- **底座**：G1 E1–E7 全落点 + AGE parity；G5 confidence 写回；G6 RRF 优于单路；6.6 脏事实拦截；6.3 ④跳检测；6.4 七态 + edge_compliance。
- **应用环**：G2 `rule_hit` 落库 100%；G3 Turtle 导出 + 归档；G7 鉴权 401/410。
- **反馈环**：G4 5 策略经第0闸；6.1 root_cause/feedback 落库；6.2 edge_bindings 校验；6.5 parity 锁死。
- **全局**：全量 `vitest` 单进程通过；无并发两 vitest；写操作 100% 经第0闸；禁物理删。

---

## §6 风险与开放问题

1. **EU AI Act 导出格式优先级**：Turtle/RDF vs PDF——需确认（Task 3）。
2. **双时态 replay（Task 14/T10）**：与 Datalog 同源评估，P2 暂缓。
3. **Rete 护城河**：G2 mini-Rete 须补 property-based 测试防"类型静默漏网"（外部学习#3）。
4. **`decision_rule` 管理入口**：配置中心卡片 vs `/rules.html`——开放问题。
5. **状态对账风险**：设计文档标记已过时，本计划以代码事实为准；若实施中发现某"已落地"项实际缺失，回落 Task 对应新建步骤。

---

## §7 Self-Review（计划自检）

- **Spec 覆盖**：G1–G7 + 6.1–6.6 均有对应 Task（1–11,12）；UI/配置集成 Task 13；P2 Task 14。无遗漏。
- **Placeholder 扫描**：无 TBD/TODO；每新建 Step 3 含实际代码或 SQL。
- **类型一致性**：`produceDecision` 在所有写操作 Task 中签名一致；`computeConfidence` 入参 `outcomeVerified/humanDisposition` 与 `confidence.js:4` 一致；`resolveConflict` 5 策略名全局统一。
- **状态对账**：§1 文件结构 + §3 Task 12 显式标注"仅验证"，避免对 G1/6.5 重复造轮子（符合用户"不照搬、消除重复"要求）。
