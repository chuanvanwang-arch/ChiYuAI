# 决策质量闭环 · 开发计划（writing-plans）

> 落地对象：三份设计文档
> - `2026-08-30-decision-quality-closed-loop-redesign.md`（T1–T14，L1 上下文图谱 / L2 反馈 / L3 校准 / 前端作战室）
> - `2026-08-30-j2-j3-comprehensive-design.md`（T15–T24，J2/J3 四维度深化）
> - `2026-08-30-full-traceability-root-cause-design.md`（T25–T32，四层溯源 + 七类根因）
> 测试基准：`2026-08-30-decision-quality-test-spec.md`
> 命名体系：K 知识系统（原 L1–L4）/ M 记忆系统（L1–L7 维度 + E1–E7 边）/ J 决策脊柱（J1 上下文图谱 / J2 反馈回路 / J3 校准层）
> 铁律：每 Task 一 commit；TDD 红→绿→提交；写操作经第 0 闸；绝对禁删；UI 零硬编码色值。

## §0 依赖与阶段划分

依赖根：**T1（边↔维度规范）→ T2（决策边权威表）→ T3（createDecision 拦截）→ T11/T12（真图）**；L2 依赖 **T5/T6 → T15–T18**；L3 依赖 **T8/T9 → T19–T24**；溯源依赖 **T25–T32**。每个 Task 的落点 file:line 已在设计文档与源码扫描中明确。

## §1 Phase 1 — L1 基础（T1,T2,T3,T11,T12）

### T1 `src/decision/edgeDimensionSpec.js`（新建，纯）
- 落点：`src/decision/edgeDimensionSpec.js`；测试 `test/decision/edgeDimensionSpec.test.js`。
- 内容：`EDGE_DIMENSION_SPEC`（E1–E7 × L1–L7 的 `serves_dimension`/`required_facets`/`direction`）、`loadEdgeDimensionSpec()`、`validateEdgeDimensionSpec(spec)`。
- 验收：§2 T1 四条用例（7 边全覆盖、每维≥1 边、无悬空、默认映射正确）。

### T2 `decision_relation` + `src/decision/relation.js`（DB+新建）
- DDL（`db/schema.sql` 追加）：`crm.decision_relation(rel_id,from_id,to_id,rel_type enum(7),serves_dimension,props,created_at)` + 三索引。
- 新建 `src/decision/relation.js`：`linkDecisions(fromId,toId,relType,servesDimension,props)` 双写 AGE `addEdge` + PG；`listTypedEdges(entityId)` 读 PG。
- 降级：AGE 关时 `ctePrecedents` 改读 `decision_relation` 全 7 类边（parity 测试）。
- 验收：§2 T2 三用例。

### T3 `createDecision` 拦截闭环（`src/decision/decisionRepo.js:39` 改造）
- 落点：`decisionRepo.js` `createDecision` 写入前调 `sevenDimensionsCheck`；纯函数 `decideInterception(check)`（同文件或 `relation.js`）。`allowed=false` → 抛 `missing_context`（或置 `attribution.missing` 标红，`state` 不变）；已人工处置决策不回填拦截。
- 验收：§2 T3 单测+集成。

### T11 API 暴露 7 类边 + 鉴权（`src/http/routes.js:1876/1884` + `calibrationRouter` 同口径）
- `graphTraceHandler`/`graphImpactHandler` 返回节点/边含 `rel_type`+`serves_dimension`+`props`；新增 `GET /api/graph/edges?entityId=`；三端点加 `requireMe`+`enforceScope`。
- 验收：§2 T11 三用例。

### T12 Cytoscape 真图（`src/web/portal/`）
- `npm i cytoscape` → 拷 `node_modules/cytoscape/dist/cytoscape.min.js` → `src/web/portal/vendor/cytoscape.min.js`（离线随仓库）。
- `sales-decision-monitor.html` 嵌力导向图：节点分型、边按 `rel_type` 上色+标注 `serves_dimension`、点节点弹 7 维 facet；色值经 `getComputedStyle(document.documentElement).getPropertyValue('--x')` 注入。
- 验收：§2 T12（零硬编码色值断言）。

## §2 Phase 2 — L2 反馈（T5,T6,T15–T18）

### T5 `decision_outcome` + `src/decision/outcome.js`（DB+新建）
- DDL：`crm.decision_outcome(outcome_id,decision_id,outcome_type enum(6),source,payload,confidence,verified_at)` + `crm.outcome_event_map`。
- `src/decision/outcome.js`：`writeOutcome(decisionId,{outcome_type,source,payload})` 幂等 upsert → 回写 `decision.outcome_verified`；`outcomeIngester.js` 订阅事件总线按 `outcome_event_map` 匹配。
- 验收：§2 T5。

### T6 `monitorStore.getGateOutcome`（`src/monitor/monitorStore.js` 扩展）
- 按闸门聚合「决策通过率 vs 业务成功率」+ 隐性错误簇计数。
- 验收：§2 T6。

### T15–T18 J2 深化
- T15 DDL（`decision_outcome`/`outcome_event_map`/`decision.outcome_verified`/`decision.feedback` 幂等迁移）。
- T16 `outcome.js`+`outcomeIngester.js`+`monitorStore`+outcome 路由。
- T17 作战室 L2 区 + 巡检卡业务结果行 + 手动补录 + 重跑入口。
- T18 MCP `crm_decision_outcome_query/gate_outcome/write`（两阶段 + 第 0 闸）。

## §3 Phase 3 — L3 校准（T8,T9,T19–T24）

### T8 `decision.confidence` 提列 + 反算（`schema.sql` + `src/decision/confidence.js` 纯）
- DDL：`ALTER decision ADD COLUMN confidence REAL, confidence_source TEXT, confidence_at TIMESTAMPTZ`；删除 `calibrationRouter.js:35-41` 侧信道 JOIN。
- 纯函数 `computeConfidence({outcomeVerified, humanDisposition})`。
- 验收：§2 T8。

### T9 校准处方经第 0 闸回写（`store.js` 已含 `produceDecision`/`approvePatch`）
- 扩展 `knobs/` 注册新策略；`CALIBRATION_CHANGE` 处方批准后经第 0 闸写回 `sevenDimensionsCheck` 阈值/置信度模型。

### T19–T24 J3 深化
- T19 DDL（`calibration_patch.knob` 枚举扩至 7+ 类；`KNOBS` 同步；`config_store.edge_bindings`；`attribution.category` 七态）。
- T20 `rules.js` R7–R10（新 knob）+ `knobs/` 新增 4 策略（confidence/edge_binding/outcome_threshold/strictness）。
- T21 `autoSuggest.js` + SSE `calibration` 域 + 浮卡组件。
- T22 seven-dim 边绑定页签 + 处方看板增强。
- T23 MCP `crm_calibration_*` 6 工具（第 0 闸）。
- T24 SKILL 中性示例（不污染 10 基线）。

## §4 Phase 4 — 全链路溯源（T25–T32）

### T25 `traceRootCause`（`src/decision/traceRootCause.js` 新建）
- 四层链 J→M→K→粒子库；④ 跳三检（字段不一致/信息不完整/输入不及时）。

### T26 `decision.feedback` + `outcome_set` + J2 表单
### T27 `rootCauseClassifier`（`src/decision/rootCauseClassifier.js` 纯）
- 七类分类树（R0–R3）+ `crm_decision_root_cause` MCP。

### T28 `calibration_patch.knob` 扩枚举 + rules R11–R17
### T29 `attribution.edge_compliance`（E1–E7）+ `category` 七态
### T30 溯源面板 + J3 归因条 + 自动建议浮卡
### T31 `meta_attr` 加 `required`/`source_refresh_sla` + 种子
### T32 `config_store.edge_bindings` + `root_cause_thresholds` + seven-dim 页签

## §5 执行序（每 Task 一 commit，用户本地提交）

```
P1: T1 → T2 → T3 → T11 → T12
P2: T5 → T6 → T15 → T16 → T17 → T18
P3: T8 → T9 → T19 → T20 → T21 → T22 → T23 → T24
P4: T25 → T26 → T27 → T28 → T29 → T30 → T31 → T32
```

## §6 风险与注意
- DB 集成测试需 `plm_test` 已 apply 全量 schema（含本计划新增 DDL）；纯单测无需 PG。
- Cytoscape 为唯一破例引入（用户拍板），vendor 离线 + 配色接 `tokens.css`，不违反 UI 铁律。
- `decision_precedent_rel` ↔ `decision_relation` 双写统一收 `linkDecisions()` 单一入口，加一致性巡检。
- 全量 `vitest run` 可能因连接池耗尽报伪失败；失败文件小批量重跑验证。
