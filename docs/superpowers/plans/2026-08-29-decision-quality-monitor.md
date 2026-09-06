# 实施计划 · decision-quality-monitor-redesign 写时物化落地

> 设计锚定：`docs/2026-08-29-decision-quality-monitor-redesign.md`（P5 批准）
> 承接：general-purpose-1（只读调研 + 编码，不提交、不跑测试运行器）
> 现状复核：经 grep 确认 `src/monitor/attribution.js`（computeAttribution/applyHumanDisposition/applyOutcome）、`db/schema.sql` 的 `attribution JSONB` 列（:187-189）、`test/monitor/attribution.test.js` 已存在。故本次只落地「写时物化接线 + 聚合端点 + 前端面板」。

## Task 1 · schema 加 attribution 列（幂等迁移）
- 现状：已完成。`db/schema.sql:187-189` 已 `ALTER TABLE crm.decision ADD COLUMN IF NOT EXISTS attribution JSONB;`。
- 本 Task 不重复改 schema；仅确认幂等。存量行 attribution 为 null（迁移回写依赖运行期，非本次范围，遗留风险见末）。
- commit 说明：`chore(schema): attribution JSONB 列已幂等存在`

## Task 2 · createDecision 写时物化 attribution
- 文件：`src/http/decisionRepo.js`
- 改动：`createDecision` 在 INSERT 前调用 `computeAttribution({scenario_id, trigger_context})`（内部复用 `sevenDimensionsCheck` 的 `ctx[dim]` 空值语义，单一事实源），可选 `human_disposition` 即时 apply。
- 纪律：物化失败仅 `emit('trace')` + `recordFailure`，不阻断主写（对齐 G3 R1 可观测化）。
- 列写入：INSERT 增 `attribution` 列（param $16），`attribution ? JSON.stringify(attribution) : null`。
- commit 说明：`feat(decision): createDecision 写时物化 attribution`

## Task 3 · monitorStore 新增 getGateAttribution 聚合
- 文件：`src/monitor/monitorStore.js`
- 改动：新增 `getGateAttribution(tenantId, {query})`，按 `GATE_SCENARIOS` 聚合近 30 天有 attribution 的决策：
  - `accuracy`（accurate/inaccurate/pending + accuracy_rate）
  - `required_fill_rate`
  - `categories` 4 类交叉矩阵：input_missing（必填缺+非不准）/ input_error（必填缺+不准）/ inference_bias（必填齐+不准）/ context_insufficient（必填齐+level=warn 无推翻）
  - `cross`：filled/missing × accurate/inaccurate 2×2
- commit 说明：`feat(monitor): getGateAttribution 闸门归因交叉矩阵聚合`

## Task 4 · 新增端点 GET /api/monitor/gate-attribution
- 容器：`src/http/calibrationRouter.js`（已 `app.use(createCalibrationRouter())` 挂载于根，免改 `routes.js`，避免与并行子代理冲突）。
- 路由：`router.get('/api/monitor/gate-attribution', ...)` 免鉴权（与 `/api/monitor/gates` 同口径），调用 `getGateAttribution`，返回 `{gates}`。
- commit 说明：`feat(api): GET /api/monitor/gate-attribution 归因面板数据源`

## Task 5 · 前端右栏归因面板 + 下钻 7 维快照
- 文件：`src/web/sales-decision-monitor.html`
- 改动：左栏 gates 总览保持；新增右栏 `#attribution-panel` 渲染 `getGateAttribution`：每闸门准确率/完整率/4 类计数色块。点闸门下钻 → 弹窗读 `/api/monitor/decisions` 取 `attribution.required_fill`：绿=必填且齐、红=必填缺、灰=非必填（单次决策 7 维快照）。
- commit 说明：`feat(web): 决策质量归因面板 + 7 维快照下钻`

## Task 6 · 测试（不运行）
- 新增 `test/monitor/gateAttribution.test.js`：验证 getGateAttribution 的交叉矩阵分类（inject fake query）。
- 现有 `test/monitor/attribution.test.js` 已覆盖 computeAttribution（无需改）。
- commit 说明：`test(monitor): gateAttribution 交叉矩阵单测`

## 验收对齐（§6）
- 移除「7 条固定红绿 = 场景覆盖体检」误导（前端改为归因面板，旧 `getSevenDimCoverage` 仍服务于 legacy 不删）。
- 经理第一屏：最危险闸门（accuracy_rate 最低）+ 4 类分布。
- 钻取：单次决策必填齐缺 + 输入对了还错=推理偏差。

## 遗留风险
- 存量 decision.attribution 为 null，getGateAttribution 仅聚合新决策；需运行期回写迁移（非本次）方可纳入历史。
- `context_insufficient` 当前由 `level='warn' 且无推翻` 近似，未来若七个维度引擎新增上下文维度再细化。
- 多租户：getGateAttribution 接受 tenantId 但 decision 表无 tenant 列，暂为空操作（留签名兼容）。
