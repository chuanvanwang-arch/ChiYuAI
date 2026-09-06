# 单决策穿透追溯 + 字段全落库 — 开发计划

- 日期：2026-08-30
- 配套设计：`docs/2026-08-30-decision-drillthrough-design.md`（已批准）
- 配套测试计划：`docs/superpowers/plans/2026-08-30-decision-drillthrough-test-plan.md`
- 关联：C-DAI v2 设计 + `2026-08-30-cdai-dev-plan.md`（T1–T14）
- 状态：待执行（TDD：失败测试→实现→验证→commit）

---

## §1 文件结构

| 操作 | 文件 | 任务 |
|---|---|---|
| 修改 | `db/schema.sql` | T-D1 列（已定义，确认幂等）、T-D2/T-D3 表（已定义 `:490`/`:507`） |
| 修改 | `scripts/seed-test-config.mjs` | T-D1/T-D2/T-D3 补 `ensureDecisionColumns` / `ensureDecisionRelationTables` 步骤 |
| 修改 | `src/decision/decisionRepo.js` | T-D1 INSERT 修复 + T-D5 守卫 + T-D2 写 7 边 |
| 修改 | `src/monitor/attribution.js` | T-D4 七态 + edge_compliance |
| 修改 | `src/decision/confidence.js` | T-D1 接入（已存在，仅调用） |
| 新建 | `src/decision/closure.js` | T-D6 聚合服务（K/M/J + crossLoopMap） |
| 修改 | `src/http/routes.js` | T-D6 `GET /api/decision/:id/closure`（requireMe） |
| 修改 | `src/web/sales-decision-monitor.html` | T-D7 `openDnModal` 三图闭环页签 |
| 新建 | `scripts/seed-closed-loop-demo.mjs` | T-D8 端到端闭环种子 |
| 新建测试 | `test/decision/{drillthrough-fields,decision-relation,decision-outcome}.test.js` `test/monitor/attribution.test.js` `test/http/decision-closure.test.js` `test/web/decision-drillthrough-ui.test.js` `test/decision/closed-loop-demo.test.js` | 对应任务 |

---

## §2 真实代码锚点（evidence-driven）

- `decisionRepo.js:68-79` — createDecision INSERT 漏写 confidence/root_cause/feedback/feedback_link。
- `confidence.js:4-14` — `computeConfidence({outcomeVerified,humanDisposition,engineConfidence})` 纯函数已存在，直接调用。
- `attribution.js:14-21` — 当前 category 仅 3 态，需扩 7 态 + `edge_compliance`。
- `schema.sql:490-504` — `decision_relation` 表定义（含 `serves_dimension`/`props`/`rel_type` 枚举）。
- `schema.sql:507-519` — `decision_outcome` 表定义（含 `confidence REAL`）。
- `schema.sql:531-538` — `decision` 提列 ALTER（confidence/confidence_source/confidence_at/outcome_verified/feedback/feedback_link/root_cause）。
- `routes.js:1792` — `requireMe` 鉴权（读 authorization 头）。
- `sales-decision-monitor.html:877` — `openDnModal(id)` 弹窗，现有"决策网络"页签，新增"三图闭环"页签。
- `auth.js:33-42` — `login({username,password})` 返回 token；测试用 alice/secret123。
- `seed-test-config.mjs:109-147` — 现有幂等 ALTER/CREATE 步骤模式（步骤 ⑧⑨），照此补 ⑩⑪。

---

## §3 逐任务 TDD 实施（失败测试→实现→验证→commit）

### T-D1 字段全落库 + INSERT 修复
- **失败测试**：`test/decision/drillthrough-fields.test.js`（见测试计划 §4 T-D1）。
- **实现**：
  1. `decisionRepo.js:43` 入参增 `outcome_verified, feedback, feedback_link, root_cause`；计算 `const confidence = computeConfidence({ outcomeVerified: outcome_verified, humanDisposition: input.human_disposition, engineConfidence: input.engineConfidence })`（动态 import `confidence.js` 或顶层 import）。
  2. INSERT（`:68-79`）列增 `confidence, confidence_source, confidence_at, outcome_verified, feedback, feedback_link, root_cause`，VALUES 增 `$17..$23`。
     - `confidence_source` = `'computed'`，`confidence_at` = `now()`。
  3. `seed-test-config.mjs` 新增步骤 ⑩ `ensureDecisionColumns`：`ALTER TABLE crm.decision ADD COLUMN IF NOT EXISTS confidence REAL, confidence_source TEXT, confidence_at TIMESTAMPTZ, outcome_verified TEXT, feedback TEXT, feedback_link TEXT, root_cause JSONB;`（幂等）。
- **验证**：`npx vitest run test/decision/drillthrough-fields.test.js` 转绿。
- **commit**：`T-D1 落库 confidence/root_cause/feedback 列 + 修复 createDecision INSERT`

### T-D2 decision_relation 表 + 7 边写库（D2 承载）
- **失败测试**：`test/decision/decision-relation.test.js`。
- **实现**：
  1. `seed-test-config.mjs` 步骤 ⑪ `ensureDecisionRelationTables`：幂等 `CREATE TABLE IF NOT EXISTS crm.decision_relation (...)` + `decision_outcome (...)`（直接内联 schema.sql:490-519 的 DDL）。
  2. `decisionRepo.js` createDecision 末尾（`:137` 先例循环后）新增：写 `DECIDED_ON` 边（from=decision, to=每个 involved_entity）+ 若 `override_target` 存在写 `OVERRIDES` + 若 `derived_from_exception` 写 `DERIVED_FROM_EXCEPTION`。用 `queryWrite('INSERT INTO crm.decision_relation (from_id,to_id,rel_type,serves_dimension,props) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', ...)`。
     - `serves_dimension`：从 `trigger_context` 抽维度键，缺省 `'L1'`。
- **验证**：`vitest run test/decision/decision-relation.test.js`。
- **commit**：`T-D2 迁移 decision_relation/outcome 表 + createDecision 写 7 类边`

### T-D3 decision_outcome 表（D4 承载）
- **失败测试**：`test/decision/decision-outcome.test.js`。
- **实现**：表已在 T-D2 建。新增 `src/decision/outcomeIngester.js`（或复用现有 `outcome.js`）：`recordOutcome(decisionId, {outcome_type, outcome_detail})` 写 `decision_outcome`。J2 消费总线（task/trace/approval/particle/payment）触发时回写。
  - 本任务最小实现：导出函数 + closure 端点读取；J2 总线接线的完整消费并入 j2-j3 T15–T32，此处仅打通落库与读取。
- **验证**：`vitest run test/decision/decision-outcome.test.js`。
- **commit**：`T-D3 decision_outcome 落库 + 读取路径`

### T-D4 attribution 七态 + edge_compliance
- **失败测试**：`test/monitor/attribution.test.js`。
- **实现**：`attribution.js` `computeAttribution` 扩展 `category` 取值为 `COMPLETE/PARTIAL/MISSING_CONTEXT/CONFLICT/WEAK/STALE/OVERRIDDEN`（七态）；新增 `edge_compliance`：遍历 E1–E7，按 `应存(set)/实存(exist)/缺(missing)` 三态标注（对照 `required_dims` 与 `trigger_context` 实际键）。
- **验证**：`vitest run test/monitor/attribution.test.js`。
- **commit**：`T-D4 attribution 七态 + E1-E7 edge_compliance`

### T-D5 写时非空守卫
- **失败测试**：`test/decision/drillthrough-fields.test.js` 新增两条（见测试计划 §4 T-D5）。
- **实现**：`decisionRepo.js` 在 `sevenDimensionsCheck`（`:63`）之前新增：`if (Object.keys(trigger_context||{}).length===0) throw new Error('missing_context: trigger_context 为空'); if (!Array.isArray(conditions_evaluated)||conditions_evaluated.length===0) throw new Error('missing_context: conditions_evaluated 为空');` ——复用 `missingContextMessage`。
- **验证**：`vitest run test/decision/drillthrough-fields.test.js`（含 T-D1 用例仍绿，因种子均带非空）。
- **commit**：`T-D5 createDecision 写时非空守卫`

### T-D6 closure 聚合端点（核心）
- **失败测试**：`test/http/decision-closure.test.js`。
- **实现**：
  1. 新建 `src/decision/closure.js`：`getDecisionClosure(decisionId)` 返回：
     - `k`：involved_entities → `particles` 解析（type/title/payload）+ `meta_attr.source_refresh_sla` 新鲜度。
     - `m`：`decision` 行（conditions_evaluated/effective_policy_version/attribution）+ `memory_log` 关联 + `decision_relation` 7 边（含 serves_dimension）。
     - `j`：`decision` 判定（disposition/confidence/rationale）+ `decision_outcome` + `calibration_patch`。
     - `crossLoopMap`：D1 K→M（`involved_entities` 非空→exists）、D2 M→J（`decision_relation` 非空）、D3 J→K（`calibration_patch` 非空且 status=APPLIED）、D4 J→M（`decision_outcome` 非空）、D5 K↔M（`meta_attr` 写时约束生效）。每条 `{exists:bool, carrier:string}`。
     - `provenance`：`provenance.js` 溯源链（SHA-256）。
  2. `routes.js` 新增（紧邻 graph 处理层，`routes.js:1810` 后）：
     ```js
     app.get('/api/decision/:id/closure', async (req, res) => {
       const me = requireMe(req, res); if (!me) return;
       try { const data = await getDecisionClosure(req.params.id); res.json(data); }
       catch (e) { res.status(404).json({ error: e.message }); }
     });
     ```
- **验证**：`vitest run test/http/decision-closure.test.js`。
- **commit**：`T-D6 GET /api/decision/:id/closure 聚合 K/M/J + D1-D5`

### T-D7 前端三图闭环页签（零硬编码）
- **失败测试**：`test/web/decision-drillthrough-ui.test.js`。
- **实现**：`sales-decision-monitor.html` `openDnModal`（`:877`）新增页签「三图闭环」：
  - 调 `fetch('/api/decision/'+id+'/closure', {headers:{authorization:'Bearer '+token}})`（复用 `:303` token 注入逻辑）。
  - 渲染三区容器 `#k-zone/#m-zone/#j-zone`（`.panel/.sect/.card` 类，色值走 `tokens.css` CSS 变量，**禁止硬编码**）。
  - 渲染 `#cross-loop` 状态条：D1–D5 绿/红 + 断点提示。
  - 现有"决策网络"页签保留（概念层级区分：网络=决策之间，闭包=单决策内部）。
- **验证**：`vitest run test/web/decision-drillthrough-ui.test.js` + 本地 `npm start` 手测（用户侧）。
- **commit**：`T-D7 openDnModal 三图闭环页签（零硬编码）`

### T-D8 端到端闭环 demo 种子
- **失败测试**：`test/decision/closed-loop-demo.test.js`。
- **实现**：新建 `scripts/seed-closed-loop-demo.mjs`（复用测试库连接）：
  1. createDecision（带完整 trigger_context + involved_entities + conditions_evaluated）。
  2. 写 decision_relation（DECIDED_ON/OVERRIDES）。
  3. 写 decision_outcome（J2）。
  4. 经第0闸写 calibration_patch（scenario_id='CALIBRATION_CHANGE', decision_id=该决策, knob='threshold'）+ APPLY（写回 meta_attr/edge_bindings）。
  - 固定 UUID + `ON CONFLICT DO NOTHING` 幂等。
- **验证**：`vitest run test/decision/closed-loop-demo.test.js`（D1–D5 全 exists）。
- **commit**：`T-D8 端到端闭环 demo 种子（闭包 100%）`

---

## §4 决策第0闸契约（写操作纪律）

所有写回 K/M 的操作（T-D2 写边、T-D3 outcome、T-D8 calibration 写回）必经 `produceDecision`/calibration 第0闸，`scenario_id='CALIBRATION_CHANGE'`，携带 `decision_id`（设计铁律：写操作必经决策第0闸，绝对禁止 DELETE，冲突走软合并 `merged_into`）。

---

## §5 执行顺序与收敛

```
T-D1(列) → T-D2(relation表+边) → T-D3(outcome表) → T-D4(attribution七态)
   → T-D5(非空守卫) → T-D6(closure端点) → T-D7(前端页签) → T-D8(闭环种子)
```
- 与 C-DAI 开发计划 **T1/T2/T3/T11/T12** 对齐（C-DAI 的 G 系列设施为 T-D 提供基座）。
- 与 j2-j3 **T15–T32** 衔接：T-D3 落库基座供 J2 总线消费；T-D8 首个闭环证据供 J3 校准写回验证。
- 生产库对齐：`npm run migrate`（db/migrate.js 应用 schema.sql:490-538）使 `plm` 与 schema 对齐，消除"运行库落后"根因。

---

## §6 Self-Review（提交前自检）

- [ ] spec 覆盖：8 套件对应 8 任务，无遗漏。
- [ ] placeholder 扫描：无 `TODO`/`XXX` 遗留。
- [ ] 类型一致：INSERT 列数=VALUES 占位符数（T-D1 改后复核）。
- [ ] 状态对账：运行库 `plm` 经 migrate 后 T-D1/T-D2/T-D3 表/列存在（探针复核）。
- [ ] UI 铁律：T-D7 全走 tokens.css 语义变量，无 `#fff`/`#1e293b` 硬编码。
- [ ] 每任务一 commit，未提交（沙箱无凭证，用户本地 commit）。
