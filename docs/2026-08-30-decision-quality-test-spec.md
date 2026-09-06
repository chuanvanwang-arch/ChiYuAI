# 决策质量闭环 · 测试文档（TDD 验收基准）

> 设计输入：`2026-08-30-decision-quality-closed-loop-redesign.md`（T1–T14）
> `2026-08-30-j2-j3-comprehensive-design.md`（T15–T24）
> `2026-08-30-full-traceability-root-cause-design.md`（T25–T32）
> 配套开发计划：`2026-08-30-decision-quality-implementation-plan.md`
> 状态：本测试文档为落地基准；每 Task 一 commit，红→绿→提交。

## §0 测试纪律（铁律派生）

1. **TDD 顺序**：先写失败测试 → 实现 → 跑绿 → commit（用户本地提交，沙箱无私有库凭证）。
2. **DB 隔离**：集成测试连 `plm_test`（`vitest.config.js:9` 强制 `PGDATABASE=plm_test`）；`beforeEach` TRUNCATE 仅清测试库。**禁止并发两个 vitest**（同库互 TRUNCATE 伪失败）；全量 `vitest run` 可能耗尽 `max_connections` 报 `too many clients already`，判定真回归 = 失败文件小批量重跑全绿即伪象。
3. **纯函数优先单测**：`sevenDimensionsCheck` / `attribute` / `edgeDimensionSpec` / `rootCauseClassifier` / `computeConfidence` 一律用注入 `fakeQuery` 或纯输入，不连 PG。
4. **写操作必经第 0 闸**：所有写回 K/M 的测试必须断言产生真实 `decision_id`（CALIBRATION_CHANGE 场景），且 `calibration_patch.decision_id` 非空。
5. **绝对禁删**：测试不得含 `DELETE`/`DROP`；去重走软合并 `meta.merged_into`；清理用 TRUNCATE 且仅测试库。
6. **UI 一致性**：前端测试断言零硬编码色值（颜色 100% 走 `tokens.css` 语义变量）；Cytoscape `style` 色值经 `getComputedStyle(document.documentElement).getPropertyValue('--x')` 注入。
7. **parity 守卫**：AGE 开/关两种模式下同一 decision 的 trace 结果逐边相等（G1 验收）。

## §1 测试分层与命名

| 层 | 目录/文件约定 | 是否需 PG |
|---|---|---|
| 单元（纯函数） | `test/decision/*.test.js` | 否 |
| 单元（引擎/规则） | `test/sevenDimensions/*.test.js`、`test/calibration/*.test.js` | 否（fakeQuery） |
| 集成（DB 写读） | `test/decision/db-*.test.js` | 是（plm_test） |
| API（路由） | `test/http/*.test.js` | 是 |
| UI（页面/组件） | `test/web/*.test.js` | 否（DOM 断言） |

## §2 逐 Task 验收与测试用例

### T1 边↔维度规范（edgeDimensionSpec）【纯单测】
- `src/decision/edgeDimensionSpec.js` 导出 `EDGE_DIMENSION_SPEC`（7 边 × 7 维）、`loadEdgeDimensionSpec()`、`validateEdgeDimensionSpec(spec)`。
- 用例：
  1. 7 边全覆盖 7 维；每维 ≥1 条边服务（`validateEdgeDimensionSpec` 返回 `valid:true`）。
  2. 无悬空边（`serves_dimension` 指向不存在维度 → 返回 `valid:false`）。
  3. 无悬空维（某维无任一边服务 → `valid:false`）。
  4. `loadEdgeDimensionSpec()` 默认返回定稿映射（REFERENCED_PRECEDENT→#5 等）。

### T2 decision_relation 权威表 + linkDecisions【集成】
- 用例：
  1. `decision_relation` 落 7 类边枚举；写非法 `rel_type` 被 CHECK 拒绝。
  2. `linkDecisions(from,to,relType,servesDimension,props)` 双写 AGE + PG；AGE 关时 PG 仍可查全 7 类边（降级读 PG）。
  3. parity：AGE 开/关 trace 结果逐边相等。

### T3 createDecision 拦截闭环【集成+单元】
- 单元：`decideInterception(check)` 纯函数——`allowed=false` → 返回 `{blocked:true,missing}`，`allowed=true` → 透传。
- 集成：`required_dims` 含 `on_missing:'block'` 维缺失 → `createDecision` 拒写（抛 `missing_context`）或 `attribution.missing` 标红；存量已人工处置决策仍可落库（不回填拦截）。

### T5 decision_outcome 回写【集成】
- 用例：
  1. `POST /api/decision/:id/outcome` 落 `decision_outcome` 并回写 `decision.outcome_verified`；幂等 upsert（同 `(decision_id,outcome_type,source)` 不翻倍）。
  2. `outcome='won'` 驱动 `outcome_verified='won'`；并发安全。

### T6 monitorStore.getGateOutcome【集成】
- 用例：返回每闸门 `decision_pass_rate` vs `business_success_rate`；隐性错误簇（人工 disposition=采纳 但 `outcome_verified=lost/partial`）计数 >0 时可被聚合。

### T8 decision.confidence 提列 + 反算【纯+集成】
- 纯：`computeConfidence({outcomeVerified, humanDisposition})` → 0~1；`outcome='won'` 且 `CONFIRMED` → 高；`REVERSED`/重大偏差 → 低。
- 集成：`crm.decision.confidence` 由写路径落库；`calibrationRouter` 不再侧信道 JOIN `decision_event.payload`。

### T11 API 暴露 7 类边 + 鉴权【API】
- 用例：
  1. `graphTraceHandler`/`graphImpactHandler` 返回节点/边含 `rel_type`(7 类)+`serves_dimension`+`props`。
  2. 新增 `GET /api/graph/edges?entityId=` 返回 typed 边；降级回 `ctePrecedents` 时仅含 `REFERENCED_PRECEDENT`。
  3. `/api/graph/*` 加 `requireMe`+`enforceScope`；越权（`sales` 跨 `org_subtree`）被拒。

### T12 Cytoscape 真图【UI】
- 用例：节点按类型分型、`rel_type` 上色+标注 `serves_dimension`；配置色值经 `getComputedStyle` 注入（断言无 `#fff`/`#1e293b` 硬编码）；点节点弹 7 维 facet 抽屉。

### T15–T18 J2 字段/后端/页面/MCP【集成+API+UI】
- 字段：`decision_outcome`/`outcome_event_map`/`decision.outcome_verified`/`decision.feedback` 迁移幂等。
- 后端：`outcomeIngester` 订阅事件总线按 `outcome_event_map` 匹配 → `writeOutcome`；`crm_decision_outcome_*` MCP 工具经第 0 闸。
- 页面：L2 区「通过率 vs 成功率」对比条；隐性错误簇标红；巡检卡业务结果行支持手动补录。

### T19–T24 J3 字段/规则/自动建议/页面/MCP/SKILL
- T19：`calibration_patch.knob` 枚举扩至 7+ 类；`KNOBS` 同步；`config_store.edge_bindings`；`attribution.category` 七态。单测：新 knob 不被 CHECK 拒。
- T20：`rules.js` R7–R10（新 knob）；`knobs/` 注册 4 策略（confidence/edge_binding/outcome_threshold/strictness）。
- T21：`autoSuggest.js` 订阅偏差事件 → `attribute()` → `savePatches` 幂等 → SSE `calibration` 域推浮卡；R5/R6 守卫优先（小样本零处方）。
- T22：seven-dim 边绑定页签 + 处方看板状态机可视化。
- T23：`crm_calibration_*` 6 工具经第 0 闸。
- T24：`ai-feedback-loop`/`ai-memory-lifecycle`/`ai-context-layering` 加中性示例，不污染 10 基线编号。

### T25–T32 全链路溯源 + 七类根因
- T25：`traceRootCause(decisionId)` 四层链 J→M→K→粒子库；④ 跳三检（字段不一致/信息不完整/输入不及时）。
- T26：`decision.feedback` 结构化回写 + `outcome_set` + J2 表单。
- T27：`rootCauseClassifier(input)` 七类命中且 evidence 链可追。构造 7 类样例各命中 1 类。
- T28：`calibration_patch.knob` 扩枚举 + `KNOBS` + rules R11–R17（覆盖七类根因处方）。
- T29：`attribution.edge_compliance`（E1–E7 应存/实存/缺）+ `category` 七态。
- T30：溯源面板 + J3 归因条 + 自动建议浮卡。
- T31：`meta_attr` 加 `required`/`source_refresh_sla` + 种子数据。
- T32：`config_store.edge_bindings` + `root_cause_thresholds` + seven-dim 页签。

## §3 回归与验收总口径（来自三文档 §验收）

- L1 真图可见（Cytoscape 力导向、7 类边上色、零硬编码色值）。
- L1 闭环（`required_dims` 拦截 / `decision_relation` 降级可读全 7 类）。
- L2 闭环（业务结果回写驱动 `outcome_verified`、监控台双率对比 + 隐性错误）。
- L3 闭环（confidence 反算、处方经第 0 闸回写留痕、R5/R6 守卫）。
- 全链路溯源（`crm_decision_trace` 返回四层链 + 字段 diff）。
- 七类归因各可一键批准经第 0 闸写回 K/M，重跑后同类偏差率下降。
- 铁律：全程零 DELETE、UI 零硬编码色值、10 SKILL 不污染。

## §4 测试执行命令

```bash
# 纯单测（无需 PG，优先跑，验证逻辑）
node --experimental-vm-modules ./node_modules/.bin/vitest run test/decision/edgeDimensionSpec.test.js test/decision/rootCauseClassifier.test.js test/decision/confidence.test.js test/calibration/rules.test.js

# 集成测试（需 plm_test 已 apply schema）
PGDATABASE=plm_test node ./node_modules/.bin/vitest run test/decision/db-relation.test.js test/decision/db-outcome.test.js

# 小批量重跑避免连接池耗尽
node ./node_modules/.bin/vitest run <失败文件单文件>
```

> 注：纯单测是本次落地的主验证面（可在无 PG 环境稳定通过）；DB 集成测试需在已部署 schema 的 `plm_test` 上跑，沙箱若无 PG 则标记 pending。
