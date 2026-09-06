# 决策质量稽核台重设计 · 销售决策监控台（sales-decision-monitor）

> 设计日期：2026-08-29 ｜ 状态：已批准（P5）｜ 承接：开发侧实现，契约 agent 锚定 `review-gate`
> 设计输入：用户对原「7 维红绿条」监控的质疑 + brainstorming 澄清（目的/骨架/信号/归因/实现 5 问）

## §0 背景与目的

原 `sales-decision-monitor.html` 的「7 维红绿条」是**场景级覆盖体检**（`monitorStore.getSevenDimCoverage` 按 `eval_dimensions` 前缀命中判定 provided/missing），与 S20 必填清单（`required_dims` + `on_missing`）完全脱钩。导致两个误导：

1. 7×7 矩阵里每个闸门必填维数不同（LEAD 5 维、OPP 7 维…），监控条却永远画 7 条，红绿不区分「必填但缺」与「非必填缺」。
2. 红绿表达的是「评估条件族覆盖度」，不表达用户真正关心的**决策质量**。

用户明确的监控目的（决策质量稽核三段）：
- **输入合规**：本次决策，必填的 N 维是否都「正确输入」了？
- **决策正确**：即便必填都输入对了，决策结果本身准不准？
- **归因调整**：不准时——是「输入缺/错」导致，还是「输入齐但对了还是错」（agent 推理偏差 / 规则误判 / 上下文不足）？后者需调 agent 而非补数据。

## §1 信息架构（左栏总览 + 右栏归因，去逐条流）

**左栏 · 闸门总览卡**（7 个 scenario 各一张，替代原 7 条红绿）
- 主指标：**决策准确率%**（近 30 天，`human_disposition` 非推翻占比）
- 副指标：**必填输入完整率%**（该闸门决策必填维均值齐）
- 归因条：4 类小色块各带计数（输入缺失 / 输入错误 / 推理偏差 / 上下文不足）
- 滞后标：`已结案 N / outcome 反证当初判错 M`

**右栏 · 归因面板**（4 类分组，可下钻）
- 每组：类别总错误数 + 按闸门分布
- 点开某错误决策 → **单次 7 维输入快照**（正确语义的「7 维」）：绿=必填且齐 / 红=必填缺或错 / 灰=非必填

## §2 颜色语义重置

| 位置 | 旧 | 新 |
|---|---|---|
| 总览卡主指标 | — | 绿≥80% / 黄 50–80% / 红<50% |
| 归因 4 类 | — | 输入缺失=橙、输入错误=红、推理偏差=紫、上下文不足=蓝（4 色中性区分，非二元红绿） |
| 下钻 7 维快照 | 场景级覆盖体检（误导） | **单次决策输入合规**：绿=必填且正确 / 红=必填缺错 / 灰=非必填 |

## §3 数据模型改动（写时物化 · 乙方案）

1. `decision` 表加 `attribution JSONB`：`{required_fill:{provided:[],missing:[]}, category, accuracy_signal, outcome_verified, computed_at}`
   - 现状：`decision` 表已有 `outcome TEXT`（db/schema.sql:167）与 `human_disposition`（:180），缺 `attribution` 列。
2. **写时物化**（`createDecision`，src\decision\decisionRepo.js:38）：**直接复用 `sevenDimensionsCheck(scenario_id, trigger_context)`**（src/sevenDimensions/engine.js:9）取 `missing`——与 S20 拦截引擎**同一份 `ctx[dim]` 空值判定**（`val==null || val==='' || 空数组→缺失`）。`required_fill.provided = 全部必填维 − missing`、`missing` 直接取引擎结果。初始 `accuracy_signal='pending'`、`category` 按「必填齐/缺」初判（ok / input_missing）。**`conditions_evaluated`（前缀匹配覆盖语义）不进 `required_fill` 主判定**，仅留作归因面板辅助维度。
3. **滞后校验回写**：
   - `human_disposition` 回写（现有校准链路）→ 更新 `accuracy_signal`；若被推翻且必填齐 → `category='inference_bias'`
   - `outcome` 写回（成交/丢单/回款，新增轻量端点或复用）→ 更新 `outcome_verified`（反标「当初判得对不对」）

## §4 与校准层关系

不重复造轮：准确率信号复用 calibration 的 `human_disposition` 同源数据；`attribution` 是 calibration 的**可视化物化层**——calibration 管「怎么调」（处方），本台管「哪错 / 错哪类」（稽核）。

## §5 任务分解（Living Contract 双轨）

```contract-yaml
- task: "schema 加 attribution 列 + 幂等迁移"
  agent: review-gate
  skills: [data-particle-read]
  memory: [review-gate]
  success: "db/migrate 跑通后 crm.decision 含 attribution JSONB 列且存量行 attribution 非空默认"
- task: "createDecision 写时物化 attribution"
  agent: review-gate
  skills: [data-particle-read, method-review-gate]
  memory: [review-gate]
  success: "createDecision 后 decision.attribution.required_fill 反映该 scenario 必填维齐缺，category 初判正确（单测覆盖）"
- task: "滞后校验回写 human_disposition/outcome → attribution"
  agent: review-gate
  skills: [method-review-gate]
  memory: [review-gate, quote-engine]
  success: "human_disposition 置 OVERRIDDEN 且必填齐时 attribution.category=inference_bias；outcome 写回更新 outcome_verified"
- task: "monitorStore 新增 getGateAttribution 聚合"
  agent: review-gate
  skills: [data-particle-read]
  memory: [review-gate]
  success: "GET /api/monitor/gates 返回每闸门 accuracy/required_fill_rate/4类归因计数"
- task: "前端左栏总览卡重做（替代 7 红绿）"
  agent: review-gate
  skills: [data-particle-read]
  memory: [review-gate]
  success: "sales-decision-monitor.html 左栏显示 7 闸门准确率/完整率/归因条，无 7 条固定红绿"
- task: "前端右栏归因面板 + 下钻 7 维快照"
  agent: review-gate
  skills: [data-particle-read]
  memory: [review-gate]
  success: "右栏 4 类归因可下钻，单次决策 7 维快照绿/红/灰语义正确"
- task: "vitest 覆盖 + validate-contract 自检"
  agent: review-gate
  skills: [method-review-gate]
  memory: [review-gate]
  success: "test/ 全绿；node scripts/validate-contract.mjs 退出码 0"
```

**契约说明**：本重设计由开发侧实现，agent 字段锚定 `review-gate`（决策质量评审语义，与稽核目的最贴）；skills/memory 落在 `review-gate` 注册表子集（`src/agent/agentSpec.js:40`）内以满足 §A 自校验。若需 workbench 运行时自动 monitor，后续可提议为 `review-gate` 增补 `ai-feedback-loop` skillCalls（需用户批准，非本次范围）。

## §6 验收口径

- 原「7 条固定红绿 = 场景覆盖体检」彻底移除，不再误导。
- 经理第一屏能答：哪个闸门最危险（准确率最低）+ 错在哪类（4 类分布）。
- 钻取能答：本次决策必填 5 维是否都正确输入 + 输入对了还错=推理偏差。

## §7 风险与注意

- **口径对齐（关键）**：`attribution.required_fill` 的「必填齐缺」判定**必须复用 `sevenDimensionsCheck` 的 `ctx[dim]` 空值语义**，严禁再用 `DIM_PREFIX` 前缀匹配（`monitorStore.getSevenDimCoverage` 旧口径）。二者结论不一致会导致稽核台「必填完整率%」与未来 7×7 拦截行为脱节。为单一事实源，`sevenDimensionsCheck` 返回体新增 `required` 字段（全必填维清单），`computeAttribution` 不另算。旧 `DIM_PREFIX` 仅保留给 legacy `getSevenDimCoverage`，与 attribution 解耦。
- `outcome` 滞后校验依赖业务结果回执链路存在；若该链路当前未接通，归因面板 `outcome_verified` 暂全为 null，不影响主流程（accuracy_signal 由 human_disposition 驱动）。
- 写时物化须与 `createDecision` 既有「不阻断主写」纪律一致（参照 provenance / graph-sync 的 `.catch` 可观测化模式，monitorStore 物化失败仅 `recordFailure` 不阻断）。

## §8 与 7×7 闭环的关系（现状澄清）

- **7×7 配置 ✅**：`scripts/seed-seven-dim.mjs` 幂等 seed + `src/http/sevenDimRouter.js`（sysadmin 闸 + 第0闸 config_change）+ `src/portal/decisionScenario.js`（校验/决策/写库内核，含 `validateScenarioPatch`）。
- **拦截引擎 ✅**：`sevenDimensionsCheck`（src/sevenDimensions/engine.js:9）→ `{missing, level, allowed}`，`block→allowed=false` 拒写语义完整。
- **决策写入拦截（闭环本体）❌ 未接**：`createDecision`（src/decision/decisionRepo.js:38-133）**全程不调用 `sevenDimensionsCheck`**，故 `required_dims` 当前对真实决策写入**零约束力**（决策照写、agent 照脑补）。`src/http/configRouter.js:99-108` 的 sevenCheck 只校验 config 值本身完整度，非决策写拦截；`src/pages/S07.schema.js:6` 仅注释「触发 sevenDimensionsCheck」未落地。
- **本方案不破坏、且主动对齐闭环**：
  - 不删不改 `required_dims` / `sevenDimensionsCheck` / 任何拦截逻辑；
  - `attribution.required_fill` 直接复用 `sevenDimensionsCheck` 的 `missing` 结果 → 未来把 `sevenDimensionsCheck` 接进 `createDecision`（闭环落地）时，稽核台「必填完整率%」将**自动与真实拦截口径一致**，无需再改。
- **建议（非本次范围）**：7×7 真正闭环的最后一步是在 `createDecision` 写入前调用 `sevenDimensionsCheck` 并据 `allowed` 决定拒写 / 打 `missing_context` 标；届时 attribution 物化与之天然共存，不构成冲突。

## 闭环回写

| task | agent | gap_type | observed | expected | severity | status |
|------|-------|----------|----------|----------|----------|--------|
| （待 P10 workbench 吸收后填） | | | | | | |

> 本表由 workbench 运行时监控 contract-yaml 执行并 upsert；同一 `(task, gap_type)` 复发 ≥2 次时产出 SKILL 改进提案（需用户批准）。
