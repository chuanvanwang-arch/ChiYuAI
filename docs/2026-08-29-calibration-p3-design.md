# P3 决策质量校准 · required_dims 处方（七维严格度旋钮）设计文档

> 状态：**已批准**（2026-08-29，brainstorming 一次一问澄清 → 方案 B 旋钮抽象重构 → 用户批准）
> 前置：本文档是 `docs/2026-08-28-decision-quality-calibration-design.md` 的 P3 续篇。P0/P1/P2 已实现并接线、有测试护体（见该文档与本轮核查结论）。
> 铁律对齐：设计先行，未批准不写实现代码；写操作必经决策第 0 闸；绝对禁止 DELETE；每 Task 一 commit（沙箱无凭证，由用户本地提交）。

---

## §0 目标与范围

解锁 `required_dims` 处方（七维严格度旋钮），与 P1 的 `threshold`/`weight` 处方**统一抽象为旋钮策略类**，消除 `src/calibration/store.js` 的 if/else 硬编码分支。

四决策点（brainstorming 一次一问澄清已定）：

1. **产出模式**：手动发起 + 审批留痕（不做自动归因产出；自动度量归因留待后续，P3 仅治理通道）。
2. **单一写通道**：七维页编辑改为「发起处方草稿」，校准页 sysadmin 批准后才写 `decision_scenario.required_dims`；不保留 sevenDimRouter 直写同字段的双通道。
3. **预期影响**：量化重放（预估拦截率，复用 `sevenDimensionsCheck` 对历史 ctx 重算）。
4. **升降级范围**：升严 + 降级都支持；降级处方标 `HIGH` 风险 + 前端二次确认。

**不做**：自动归因产出 `required_dims` 处方的规则（P1 的 `attribute()` R1-R4 不新增 P3 分支）；七维页直写入口保留（改为发起草稿）。

---

## §1 架构总览（旋钮策略抽象）

新增 `src/calibration/knobs/` 策略目录，定义统一接口 `KnobStrategy`：

- `readCurrent(ctx)` → 读当前值（from_value 来源）
- `apply(client, toValue, ctx)` → 写回（落点因 knob 而异，必须传入事务 client）
- `replayImpact(decisions, toValue)` → 预期影响（影子重放）
- `riskLevel(from, to)` → `'LOW'|'MEDIUM'|'HIGH'`

`store.js` 的 `approvePatch` / `rollbackPatch` 改为按 `patch.knob` 路由到策略实例，**删除 L122 / L161 的 `required_dims` 硬拒守卫**，不再有 threshold/weight/required_dims 的硬编码分支。

策略注册表 `getStrategy(knob)`：

| knob | 策略类 | 写落点 |
|---|---|---|
| `threshold` | `ThresholdStrategy` | `config_store['autonomy-conf']` |
| `weight` | `WeightStrategy` | `config_store['autonomy-conf'].weights[target]` |
| `required_dims` | `RequiredDimsStrategy`（P3 新增） | `decision_scenario.required_dims` |

---

## §2 数据模型（零 DDL 变更）

证据：`db/schema.sql:403-419` 的 `crm.calibration_patch` 已为 P3 预留：

- `knob CHECK IN ('threshold','weight','required_dims')`（`db/schema.sql:406`）✓ 枚举已含 `required_dims`
- `from_value / to_value JSONB`（`db/schema.sql:408-409`）可存 `required_dims` 数组快照 `[{dim,on_missing}]` ✓
- `expected_impact JSONB`（`db/schema.sql:411`）存量化重放结果 ✓
- `risk CHECK IN ('LOW','MEDIUM','HIGH')`（`db/schema.sql:412`）降级可标 HIGH ✓
- `scenario_id REFERENCES decision_scenario`（`db/schema.sql:405`）+ `decision_id` 强 FK 锚定（`db/schema.sql:415`）✓

量化重放 `ctx` 源：`crm.decision.trigger_context JSONB NOT NULL`（`db/schema.sql:156`）——窗口内该 scenario 历史决策的触发上下文，作 `sevenDimensionsCheck` 的 ctx。（假设其含七维字段；e2e 验证，若部分缺失则 sample 受限、非阻塞）

**结论：P3 零数据库迁移（DDL）变更**，设计文档 §2.2 的预留已生效。

---

## §3 旋钮策略接口（base）

```js
// src/calibration/knobs/base.js
export class KnobStrategy {
  constructor(knob) { this.knob = knob; }
  async readCurrent(ctx) { throw new Error('not implemented'); }
  async apply(client, toValue, ctx) { throw new Error('not implemented'); }
  async replayImpact(decisions, toValue) { throw new Error('not implemented'); }
  riskLevel(from, to) { return 'LOW'; }
}
```

---

## §4 三策略实现

- **`ThresholdStrategy`**（`knob='threshold'`）：
  - `readCurrent` → `config_store['autonomy-conf'].threshold`
  - `apply` → 写 `config_store`（沿用 `store.js` 现有 L127 逻辑，迁至策略）
  - `replayImpact` → 调 `replayScenario`（autonomyEngine 公式，与 P1 一致）

- **`WeightStrategy`**（`knob='weight'`）：
  - `readCurrent` → `config_store['autonomy-conf'].weights[target]`
  - `apply` → 写 `config_store['autonomy-conf'].weights[target]`（沿用 L128）
  - `replayImpact` → `replayScenario`

- **`RequiredDimsStrategy`**（`knob='required_dims'`，**P3 新增**）：
  - `readCurrent` → `decision_scenario.required_dims`（与 `src/sevenDimensions/engine.js:12` 同源）
  - `apply` → 写 `decision_scenario.required_dims`（落点与 `src/http/sevenDimRouter.js:93` 同，但经校准第 0 闸 + 事务原子）
  - `replayImpact` → **量化重放**（见 §7）
  - `riskLevel(from, to)` → 降级（block→warn / 移除某 dim 要求）返回 `HIGH`；升严（warn→block / 新增 dim）返回 `LOW` 或 `MEDIUM`

---

## §5 store.js 重构

- 删 `src/calibration/store.js:122`（`approvePatch` 内 `if (patch.knob === 'required_dims') throw ...本期不可批准`）守卫。
- 删 `src/calibration/store.js:161`（`rollbackPatch` 内同款 `本期不可回滚`）守卫。
- `approvePatch` 写段（L125-144）与 `rollbackPatch` 写段（L163-175）的 if/else 分支消除，改为：

```js
const strat = getStrategy(patch.knob);
await strat.apply(client, patch.to_value, { scenario_id: patch.scenario_id, target: patch.target });
```

- `KNOBS` 枚举（`store.js:15`）已含 `'required_dims'`，无需改。`withTx` 事务原子沿用（与 P1 同款，批准/回滚要么全成要么全败）。

---

## §6 calibrationRouter 改造

- 删 `src/http/calibrationRouter.js:181` 的 `return p; // required_dims 属 P3，本期规则不产出`。
- 新增手动发起端点 `POST /api/calibration/patches/generate`（七维页调用，sysadmin 闸）：
  - 入参 `{ scenario_id, required_dims_draft: [{dim,on_missing}] }`
  - 校验：复用 `src/portal/sevenDimRender.js:33` 的 `validateRequiredDimsPatch`（维度合法性 + on_missing ∈ {warn,block}）
  - `from_value = 当前 decision_scenario.required_dims`
  - `to_value = required_dims_draft`
  - `risk = RequiredDimsStrategy.riskLevel(from, to)`
  - 生成 PENDING 处方（幂等：同 scenario_id + 同 to_value 的 PENDING 跳过，返回已存在）
  - 第 0 闸：`generate` 仅落 `calibration_patch` 草稿（PENDING），**不**写 `decision` 行；批准时才产生 `CALIBRATION_CHANGE` 真实决策行（与 P1 一致）
- 现有自动产出（`attribute()` R1-R4）保持，仅路由统一经策略类（产出时 `knob` 决定策略，`required_dims` 不在自动产出范围，仅手动发起）。

---

## §7 量化重放（预期影响）

新增 `src/calibration/replayDims.js`：

- `replayDims(scenarioId, toRequiredDims, windowDays=30)`：
  1. 取窗口内 `crm.decision`（`WHERE scenario_id=$1 AND created_at >= now()-$2::int`，按 `scenario_id` + `created_at`）
  2. 对每条 `sevenDimensionsCheck(scenarioId, decision.trigger_context)` 用 `toRequiredDims` 重算 missing（`src/sevenDimensions/engine.js:21-34` 真消费）
  3. 统计 `blocked / total` = **预估拦截率**

- 返回 `expected_impact = { sample_size, intercepted_before, intercepted_after, estimated_block_rate, estimated_block_rate_delta }`。
- 复用 `src/sevenDimensions/engine.js:21-34` 的 `sevenDimensionsCheck`（不重造）。
- 若 `sample_size < 20`（与 P1 `rules.js:82-91` R6 守卫口径一致），`estimated_block_rate_delta` 标 `insufficient_sample`，处方卡显示样本不足提示（不阻断发起，但预期影响区标注）。

---

## §8 七维页交互（单一写通道）

- `src/web/seven-dim.html` 的「保存」按钮改为：调用 `POST /api/calibration/patches/generate`（发起草稿）→ 提示「已生成校准处方，需 sysadmin 在监控页批准生效」。
- **不再直调 `sevenDimRouter.js` PUT**（避免双通道写同字段 `decision_scenario.required_dims`）。
- 七维页「读取 / 展示」仍走 `GET /api/config/seven-dim`（不变）。
- 注：`sevenDimRouter.js` 的 PUT 端点**保留但不再被前端调用**（或按评审决定保留为内部/只读展示用）；若需彻底单一通道，可在本 Task 内将其 sysadmin 闸收紧为「仅生成处方」语义——本设计定为：前端改发起草稿，PUT 端点保留备用（不删除，避免影响其它潜在调用方），但前端唯一写入口改为校准处方通道。

---

## §9 前端风险标注

- `src/portal/calibrationRender.js:74` 处方卡已有 `cal-risk-${risk}` 样式类；降级处方 `risk='HIGH'` 自动高亮。
- `src/web/sales-decision-monitor.html` 的 `bindActions` 批准降级处方前加 `confirm()` 二次确认（「此处方将放宽拦截：block→warn / 移除 dim 要求，确认？」）——仅当 `risk==='HIGH'` 时弹确认。
- 处方卡预期影响区：升严/降级均显示 §7 的 `estimated_block_rate` 数值（与 threshold/weight 处方视觉一致）。

---

## §10 第 0 闸语义（铁律对齐，无冲突）

- `required_dims` 处方的批准 / 回滚仍走 **`CALIBRATION_CHANGE` 真实决策行**（`calibration_patch.decision_id` 强 FK 锚定 `crm.decision`，与 P1 一致）。
- 写落点改为 `decision_scenario.required_dims`（同 S20 的 TEXT 无 FK 形态），落点差异不破坏第 0 闸语义。
- 批准 / 回滚事务原子（沿用 `withTx`），与 P1 同款：写落点 + 处方状态迁移打包，要么全成要么全败（修复 P1 曾暴露的「writeConf 先提交、patch UPDATE 失败」污染教训）。

---

## §11 测试计划

- `test/calibration/knobs.test.js`：三策略接口 + `RequiredDimsStrategy.apply` 写 `decision_scenario`、`不`写 `config_store`（落点正确性）。
- `test/calibration/store-p3.test.js`：删守卫后批准/回滚 `required_dims` 处方 → 写回 → `engine.js` 复验 `allowed=false`（block 生效）/ `allowed=true`（warn 生效）；降级标 HIGH。
- `test/calibration/replayDims.test.js`：量化重放预估拦截率（基于种子 `decision.trigger_context`）。
- `test/calibration/router-p3.test.js`：手动发起端点生成 PENDING + 幂等跳过 + risk 标注；sysadmin 闸。
- `test/calibration/parity.test.js` 扩展：三 knob 配置经策略写回后与 `DEFAULT_CONF` / `config_store` 逐字一致（锁死抽象重构不破坏 P1 行为）。
- `test/http/account-360` 同款 e2e：批准 → `sevenDimensionsCheck` 实际拦截（整链路）。

---

## §12 验收口径

- 七维页编辑 → 生成 PENDING 处方（不再直写）；校准页批准 → `decision_scenario.required_dims` 生效 → 写引擎据 `src/sevenDimensions/engine.js:30-34` 实际拦截。
- 量化重放处方卡显示预估拦截率（数值，非纯文字）。
- 降级处方标 HIGH + 二次确认；升严/降级均经 `CALIBRATION_CHANGE` 第 0 闸留痕。
- P1 的 50/50 测试 + parity 仍全绿（抽象重构无行为回归）。
- 全量回归 `PGDATABASE=plm_test node node_modules/vitest/vitest.mjs run` 零失败（单进程顺序跑，禁并发 vitest）。

---

## §13 实施任务拆分（每 Task 一 commit）

1. **T1 旋钮基类 + 策略注册表**：`src/calibration/knobs/base.js` + `index.js`（`getStrategy`）。迁移 `ThresholdStrategy`/`WeightStrategy`（从 store.js 抽出），测试锁死行为不变。
2. **T2 RequiredDimsStrategy**：`src/calibration/knobs/requiredDims.js`（readCurrent/apply/replayImpact/riskLevel）。
3. **T3 store.js 重构**：删 L122/L161 守卫，写段改策略路由；事务原子保留。
4. **T4 calibrationRouter 手动发起端点**：`POST /api/calibration/patches/generate` + 删 L181 `return p`；幂等 + sysadmin 闸 + 校验。
5. **T5 replayDims 量化重放**：`src/calibration/replayDims.js`（复用 `sevenDimensionsCheck`）。
6. **T6 七维页单一写通道**：`seven-dim.html` 保存改发起草稿；`GET` 展示不变。
7. **T7 前端风险标注**：`calibrationRender.js` 风险高亮 + 监控页 `bindActions` 降级二次确认。
8. **T8 测试 + 全量回归**：§11 六测试文件 + parity 扩展；全量归零。

---

## §14 自查（占位符/一致性/范围/歧义）

| 项 | 结果 |
|---|---|
| 占位符 `<...>` / `TODO` | 无；所有 `Lxx` 引用为真实代码锚点 |
| 与 P1 设计文档一致性 | §2/§6/§10 与 `docs/2026-08-28-decision-quality-calibration-design.md` 第 0 闸/FK 语义一致；P3 仅扩展 knob 枚举 |
| 范围 | 不含自动归因产出（明确不做）；不含 DDL 变更（零迁移） |
| 歧义 | `sevenDimRouter.js` PUT 端点去留——本设计定为「保留备用、前端改发起草稿」，非删除（避免影响未知调用方） |
| 风险点 | `decision.trigger_context` 是否含七维字段 → e2e 验证，缺失则 sample 受限非阻塞（§7 已声明） |

---

## §15 提交指引（沙箱无凭证）

设计文档由用户本地提交（勿 `git add -A`，工作树另有并行未提交改动）：

```
git add docs/2026-08-29-calibration-p3-design.md
git commit -m "design: P3 决策质量校准 required_dims 处方（旋钮抽象重构）"
```

批准后转 `writing-plans` 生成 §13 的 T1-T8 详细实现计划（每 Task 一 commit）。
