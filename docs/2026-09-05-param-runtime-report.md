# 20260905 参数闭环运行报告

> 报告时间：2026-09-05 14:56（北京时间）
> 报告生成方：`scripts/prod-param-nightly-verify.mjs --prod`（真实 `inspectAll` + 真实生产库 `crm_native`）
> 批准执行方：admin（2026-09-05 14:57，HTTP 200，decision_id `de14b0be-6ee4-45b3-8a91-0337095b62fc`）
> 报告范围：算法/参数配置全量闭环监控 · 22 项参数 · 第 02:00 夜批第三段参数体检

---

## §0 一句话结论
- **共运行 22 项参数体检**：成功 **20 项**（healthy，verdict=keep），失败 **2 项**（drift，verdict=adjust）
- **失败原因 2 条**：① `rubric-thresholds.good` 评分阈值偏离样本实际表现；② `precedent-conf.minSimilarity` 先例检索相似度阈值偏离期望值
- **建议调整措施 1 条**：`rubric-thresholds.good` **0.75 → 0.6**（MEDIUM 风险）；`precedent-conf.minSimilarity` 因 `retro-knob-map` 缺规则，本次**未生成自动处方**
- **审批结果**：✅ **已批准并生效**（good 0.75→0.6 已写入 `config_store`，decision_id 锚定）

---

## §1 总体运行结果（22 项体检）

| 类别 | 数量 | 占比 |
|---|---|---|
| **总任务** | **22** | 100% |
| **成功（healthy）** | **20** | 90.9% |
| **失败（drift）** | **2** | 9.1% |
| 未知 / 冷却 / 降级 | 0 | 0% |
| 生成 PENDING 处方 | 1 | — |
| 已批准处方 | 1 | — |

---

## §2 失败明细（2 项 drift）

### 失败 ①：`rubric-thresholds.good`（评分阈值"好"）
- **当前值**：0.75
- **判据**：drift（verdict=adjust）
- **失败原因**：
  - 样本 183 条决策事件中 adopted=176（96.2% 采纳），但其中 **hit_rate=0.0**、**scene_pass_rate=0.25**（25%）
  - 阈值 0.75 与样本实际表现（运动差）偏离：**当前高分阈值无法区分场景过/欠判据**
  - override_rate=3.83%（人工覆盖率偏大，说明阈值在自动化层判不准，靠人工拉齐）

### 失败 ②：`precedent-conf.minSimilarity`（先例检索相似度阈值）
- **当前值**：0.45
- **判据**：drift（verdict=adjust）
- **失败原因**：
  - 阈值偏低（0.45），导致先例库检索召回过多低质量案例，context 注入噪声偏大
  - 与候选池容量 `candidatePool=40` 配合下，候选命中率被压低
- **自动处方状态**：**未生成**（根因：`config_store['retro-knob-map']` 为空，缺 minSimilarity 的 `target` 规则函数），需人工插方

---

## §3 建议调整措施（并已批准）

### 措施 ①：`rubric-thresholds.good`
| 字段 | 值 |
|---|---|
| 配置位置 | `config_store['rubric-thresholds'].good` |
| **从（当前）** | **0.75** |
| **调整到（建议）** | **0.6**（下调 0.15，降低高分阈值以贴合样本 scene_pass_rate=25%）|
| 风险等级 | MEDIUM（业务评分阈值变动，影响下游 rubric-weights 联动）|
| 审批人 | admin |
| **状态** | ✅ **已批准并生效**（2026-09-05 14:57，decision_id `de14b0be`）|

### 措施 ②：`precedent-conf.minSimilarity`
- **状态**：⏳ **本次未生成自动处方**（规则缺失）
- **人工建议方向**：**0.45 → 0.55~0.60**（上调，提高先例检索质量，减小召回噪声）
- **后续路径**：在 `config_store['retro-knob-map']` 配置 `minSimilarity` 的 target 规则函数（待办，下次夜批可自动出方）

---

## §4 22 项明细清单

| # | 配置项 | 体检结论 | 当前值 |
|---|---|---|---|
| 1 | autonomy-conf.threshold | healthy / keep | — |
| 2 | autonomy-conf.weights | healthy / keep | — |
| 3 | **rubric-thresholds.good** | **drift / adjust** | 0.75 → **0.6 ✅** |
| 4 | rubric-weights.weights | healthy / keep | — |
| 5 | **precedent-conf.minSimilarity** | **drift / adjust** | 0.45 |
| 6 | sales-thresholds.bantcc | healthy / keep | `{pass:0.6,unknown:0.5}` |
| 7 | behavior-standard.daily_visits | healthy / keep | — |
| 8 | named-account-targets.visit_freq | healthy / keep | — |
| 9 | alert-rules.threshold | healthy / keep | — |
| 10 | approval-config.amount_tiers | healthy / keep | — |
| 11 | event-retro.cooldown_hours | healthy / keep | 24 |
| 12 | agent-event-trigger.cooling_ms | healthy / keep | — |
| 13 | decision-retro.min_sample | healthy / keep | 20 |
| 14 | decision-retro.window_extend_hours | healthy / keep | 168 |
| 15 | hindsight-deviation.deviation_threshold | healthy / keep | — |
| 16 | decision-context-guard.guard_threshold | healthy / keep | — |
| 17 | seven-dim.dim_levels | healthy / keep | — |
| 18 | business-tier.tier_matrix | healthy / keep | — |
| 19 | llm.temperature | healthy / keep | — |
| 20 | pool-config.recycle | healthy / keep | — |
| 21 | billing-plans.entitlements | healthy / keep | — |
| 22 | context-routing.scene_matrix | healthy / review | — |

> 注：`context-routing.scene_matrix` 健康但 verdict=review，需例行检查路由矩阵一致性（非紧急，平台核心配置，本会话不触碰）。

---

## §5 审批与留痕

| 字段 | 值 |
|---|---|
| 处方 ID | `10e4996f-af15-4628-9b2a-241430e66917` |
| 处方生成时间 | 2026-09-05 13:56:16 GMT+0800 |
| 批准时间 | 2026-09-05 14:57:54 GMT+0800 |
| 批准人 | admin |
| decision_id（决策链锚定） | `de14b0be-6ee4-45b3-8a91-0337095b62fc` |
| 状态 | **APPLIED**（已生效） |
| config_store 终值 | `rubric-thresholds.good = 0.6` ✅ |
| warn 字段未变 | `0.5`（本次仅调 good）|

---

## §6 下一步动作建议

| # | 建议 | 优先级 | 说明 |
|---|---|---|---|
| 1 | 监控 `rubric-thresholds.good=0.6` 下次评分分布变化 | P0 | 阈值下调 0.15 后，若 scene_pass_rate 仍 ≤25%，考虑继续下调至 0.5 或重审权重 |
| 2 | 在 `retro-knob-map` 补 `minSimilarity` 的 target 规则 | P1 | 使下次夜批对 minSimilarity 自动出方（替代人工插方）|
| 3 | 观察 3 天后 `context-routing.scene_matrix` review 项是否仍为 review | P2 | 如持续 review，发起路由矩阵专项体检 |

---

## 附：执行证据链

- 体检脚本：`scripts/prod-param-nightly-verify.mjs --prod`
- 真实路径：production `crm_native` + 真实 `inspectAll` + 真实 `runParamInspectionPass`
- 处方写脚本：`scripts/prod-param-nightly-write.mjs --prod --replace-manual 33a2bb85-…`
- 批准接口：`POST /api/my-todo/tune-approve`（HTTP 200, decision_id `de14b0be-…`）
- 验证脚本：`scripts/prod-param-nightly-verify.mjs` + ad-hoc DB read
