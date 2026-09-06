# J2/J3 详细设计：反馈回路 + 校准层（决策问责闭环的"单薄两段"补完）

> 本文是 `docs/2026-08-30-decision-quality-closed-loop-redesign.md` 的**专项深化**。  
> 主体文档的 T5–T10 只给了 J2/J3 的骨架 DDL 与一句话任务；本文把 J2（反馈回路）、J3（校准层）按**四个维度（字段属性 / 后端模块 / 页面修改 / MCP 修改 / SKILL 修改）**&#x5C55;开为可实施的详细设计。  
> 命名体系采用 K/M/J（`ai-context-layering` 的 Universal Context L1–L4 已改名 **K1–K4**；七维度+七边记忆矩阵为 **M**；决策问责脊柱为 **J1–J3**）。本文旧称 **L2 = J2 反馈回路**、**L3 = J3 校准层**。

---

## §0 现状证据（为什么"单薄"是事实，非主观）

| 子系统               | 现状                                                                         | 证据 file:line                                             | 单薄程度    |
| ----------------- | -------------------------------------------------------------------------- | -------------------------------------------------------- | ------- |
| **J2 结构化结果**      | `decision` 表仅 `outcome TEXT` + `feedback_link UUID`，无 `decision_outcome` 表 | `db/schema.sql:167-168`                                  | **缺失**  |
| **J2 业务事件触发**     | 无"成交/丢单/回款→决策结果"的 ingester；`outcome_verified` 仅能靠手动写回                      | `src/monitor/attribution.js:40`                          | **缺失**  |
| **J2 结果对比呈现**     | 监控台只有 `accuracy_signal`（人工判），无"决策通过率 vs 业务成功率"对比区                          | `src/web/sales-decision-monitor.html:330`                | **缺失**  |
| **J2 MCP 出口**     | `mcp/tools.js` 未注册任何 decision/calibration/outcome 工具                       | `src/mcp/tools.js:34-48`（仅协议层 decision_id）               | **缺失**  |
| **J3 knob 范围**    | `calibration_patch.knob` 仅 `threshold/weight/required_dims`；`KNOBS` 同      | `db/schema.sql:414` / `src/calibration/store.js:16`      | **窄**   |
| **J3 规则库**        | `rules.js` R1–R4 只出 threshold/weight；无 confidence/edge_binding/outcome 规则  | `src/calibration/rules.js:9-73`                          | **窄**   |
| **J3 confidence** | `decision.confidence` 无列，藏 `decision_event.payload`（G5 未解）                 | 设计文档 G5 / `src/decision/decisionRepo.js`                 | **未提列** |
| **J3 归因粒度**       | `category` 仅 ok/inference_bias/input_missing 单标签；无金律 19 四象限矩阵              | `src/monitor/attribution.js` + `gateAttribution.test.js` | **粗**   |
| **J3 自动建议**       | `generate` 端点存在但页面需手动点"生成处方"；无偏差触发自动浮卡                                     | `src/web/sales-decision-monitor.html:755`                | **未自动** |
| **SKILL 接驳**      | `ai-feedback-loop` 金律 18/19/21 为通用方法论，未接平台实现                               | `ai-feedback-loop/SKILL.md:342-352`                      | **脱节**  |

**结论**：J2 几乎为零（只有 attribution 里的 outcome_verified 占位），J3 有骨架但 knob/规则/置信度/归因/自动建议五处单薄。本文逐一补完。

---

## §1 总体闭环定位

追溯

- **J2 的职责**：把"决策 → 业务结果"接通，回&#x7B54;**"当初判得准不准"**（金律 18 滞后业务信号）。
- **J3 的职责**：据 J1+J2 偏差**自动**生成校准处方，经第0闸写回 K/M，使闭环**周而复始**（金律 21 拒绝出方守卫）。

---

## §2 J2 反馈回路详细设计

### §2.1 字段属性（必须改）

**(a) 新增 `decision_outcome` 表（结构化业务结果，替代松散 `outcome TEXT`）**

```sql
-- 替代 crm.decision.outcome(TEXT) 的松散字段；单一事实源
CREATE TABLE IF NOT EXISTS crm.decision_outcome (
  outcome_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id   UUID NOT NULL REFERENCES crm.decision(decision_id),
  outcome_type  TEXT NOT NULL CHECK (outcome_type IN ('won','lost','paid','stalled','partial','other')),
  source        TEXT NOT NULL,                 -- 触发源：opportunity_won / deal_lost / payment_received / manual
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,  -- 金额/周期/关联单据等
  confidence    REAL,                          -- 结果本身的置信度（如人工补录 vs 系统回执）
  verified_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_do_dec ON crm.decision_outcome(decision_id);
CREATE INDEX IF NOT EXISTS idx_crm_do_type ON crm.decision_outcome(outcome_type);
```

**(b) `decision.outcome` 降级为派生/冗余字段**，新增 `outcome_verified` 提为**表列**（原在 attribution JSONB，跨查询不便）：

```sql
ALTER TABLE crm.decision
  ADD COLUMN IF NOT EXISTS outcome_verified TEXT CHECK (outcome_verified IN ('won','lost','paid','stalled','partial',NULL)),
  ADD COLUMN IF NOT EXISTS confidence      REAL;   -- G5：从 payload 提列，J3 反算写入
```

> `confidence` 列是 J3 反算（outcome + human_disposition）后落库的单一事实源；`calibrationRouter` 不再侧信道 JOIN `decision_event.payload` 取置信度。

**(c) 业务事件 → 决策结果映射表**（让"成交/丢单/回款"自动回写，而非手动）：

```sql
CREATE TABLE IF NOT EXISTS crm.outcome_event_map (
  map_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type    TEXT NOT NULL,               -- 业务事件总线类型（如 crm.opportunity.won）
  outcome_type  TEXT NOT NULL,               -- 映射到 decision_outcome.outcome_type
  scenario_id   TEXT REFERENCES crm.decision_scenario(scenario_id),
  matcher       JSONB NOT NULL DEFAULT '{}'::jsonb,  -- 事件 payload→decision 关联键（如 opportunity_id→involved_entities）
  enabled       BOOLEAN NOT NULL DEFAULT true
);
```

### §2.2 后端模块

| 模块                                            | 职责                                                                                                                                    | 落点           |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `src/decision/outcome.js`                     | `writeOutcome(decisionId, {outcome_type,source,payload})` 幂等 upsert → 回写 `decision.outcome_verified` + `attribution.outcome_verified` | 新建           |
| `src/decision/outcomeIngester.js`             | 订阅业务事件总线（task/trace/approval/particle/**payment**），按 `outcome_event_map` 匹配 → 调 `writeOutcome`                                        | 新建           |
| `src/monitor/monitorStore.js`                 | 新增 `getGateOutcome(scenarioId)`：按闸门聚合"决策通过率 vs 业务成功率"，暴露**隐性错误簇**（人工未推翻但业务失败）                                                         | 扩展 `:117` 附近 |
| `src/http/decisionRouter.js`（或 outcomeRouter） | `POST /api/decision/:id/outcome`（写，第0闸 READ 放行、写经 confirmation）、`GET /api/monitor/gate-outcome`                                       | 扩展           |

> **幂等关键是 `decision_outcome` 以 `(decision_id, outcome_type, source)` 去重**（呼应 `ai-feedback-loop` 金律 13：写入幂等键防翻倍）。

### §2.3 页面修改（`sales-decision-monitor.html` 作战室）

- **L2 反馈区（新增，模型 Y 环的"L2业务结果"节点）**：
  - 每闸门卡片加「决策通过率 vs 业务成功率」双环对比（数据 `getGateOutcome`）。
  - "隐性错误簇"列表：人工 disposition=采纳 但 `outcome_verified=lost/partial` 的决策 → 红色高亮，直链到该决策 7×7 巡检卡。
  - 单决策巡检卡（T12b）底部加"业务结果"行：显示 `outcome_type` + `source` + `verified_at`，并支持**手动补录**（触发 `POST /api/decision/:id/outcome`）。
- **重跑入口**：隐性错误簇 / 建议卡提供「去重跑场景」按钮 → 跳转 `decision-scenarios.html?decisionId=...`，跑完回作战室，闭环可见。

### §2.4 MCP 修改（`src/mcp/tools.js`）

新增 2 读 + 1 写工具（复用现有 `mcpReadDirect` / `mcpWritePhase1`+`mcpConfirmPhase2` 两阶段协议与第0闸）：

| 工具名                          | 类型     | inputSchema                                    | 后端调用                                                                   |
| ---------------------------- | ------ | ---------------------------------------------- | ---------------------------------------------------------------------- |
| `crm_decision_outcome_query` | 读      | `{decision_id?, scenario_id?, outcome_type?}`  | `monitorStore.getGateOutcome` / `outcome.js listByDecision`            |
| `crm_gate_outcome`           | 读      | `{scenario_id, window_days?}`                  | `monitorStore.getGateOutcome`                                          |
| `crm_decision_outcome_write` | 写（两阶段） | `{decision_id, outcome_type, source, payload}` | `outcome.js writeOutcome`（phase2 确认执行，第0闸生成 CALIBRATION 类 decision 凭证） |

> 不新增 MCP 传输/端口，沿用 3001 `/mcp`。写工具走 confirmation_token 两阶段，与现有 `mcpWritePhase1/Phase2` 一致。

### §2.5 SKILL 修改

- **`ai-feedback-loop` 增加"平台实例化对照"小节**（不污染 10 SKILL 基线，仅以本平台为**中性示例**）：把金律 18（准否双信号）映射到 `decision.attribution.accuracy_signal`（即时人工判）+ `decision_outcome.outcome_verified`（滞后业务校验）；金律 13 映射到 `decision_outcome` 幂等键。属"跨域通用方法论 + 中性示例"，合规。
- **不新建 CRM 专属 SKILL**：J2 实现全部落在项目 `src/decision/outcome*.js` + `db`，领域实例化按铁律不进 10 SKILL。

---

## §3 J3 校准层详细设计

### §3.1 字段属性（必须改）

**(a) 扩展 `calibration_patch.knob` 枚举**（放开 DB 约束）：

```sql
ALTER TABLE crm.calibration_patch
  DROP CONSTRAINT IF EXISTS calibration_patch_knob_check;
ALTER TABLE crm.calibration_patch
  ADD CONSTRAINT calibration_patch_knob_check
  CHECK (knob IN ('threshold','weight','required_dims','confidence','edge_binding','outcome_threshold','strictness'));
```

**(b) `KNOBS` 常量同步扩展**（`src/calibration/store.js:16`）：

```js
export const KNOBS = ['threshold','weight','required_dims','confidence','edge_binding','outcome_threshold','strictness'];
```

**(c) `config_store['seven-dim']` 增加 `edge_bindings` 字段**（T1 配置驱动；seed 用已在对话定稿的 7 边↔7 维映射）。存 `{edge_type, serves_dimension[], direction, required_facets[]}`，供 `edgeDimensionSpec.loadEdgeDimensionSpec()` 读取。

**(d) 归因四维度扩展**（金律 19 四象限）：`attribution.category` 由单标签改为四分类枚举：

```sql
-- attribution JSONB 内 category 取值语义升级
-- input_missing(输入缺失型) | input_wrong(输入错误型) | inference_bias(推理偏差型) | context_insufficient(上下文不足型)
```

> `gateAttribution.test.js` 的分类断言需同步更新为四象限。

### §3.2 后端模块

**(a) `rules.js` 新增规则（R7–R10）**，覆盖新 knob 与四象限归因：

| 规则  | 触发条件（metrics）                                     | 出方 knob                               | 动作                    |
| --- | ------------------------------------------------- | ------------------------------------- | --------------------- |
| R7  | `outcome_mismatch_rate`（人工采纳但业务失败占比）> 0.2 且样本足    | `outcome_threshold` / `required_dims` | 收紧该场景必填维度（如补 L6 运行状态） |
| R8  | `avg_confidence` 系统性偏高但 `outcome_mismatch_rate` 高 | `confidence`                          | 下调 confidence 校准系数    |
| R9  | 某 `edge_type` 应存缺率高（如 CAUSED 缺失）                  | `edge_binding`                        | 强化该边写入校验（写入前拦）        |
| R10 | `context_insufficient` 类占比高                       | `required_dims`                       | 扩该场景维度集合              |

> R5/R6 守卫（样本/先例不足）**优先级仍高于 R7–R10**（金律 21：拒绝出方守卫先行）。

**(b) 自动建议触发器（偏差→浮卡）**：`src/calibration/autoSuggest.js`：

- 订阅 `monitorStore` 的闸门标红 / `outcome_mismatch` / 边应存缺事件；
- 调用 `attribute(metrics)` → 生成 `patches`（走 `savePatches` 幂等）；
- 经 SSE 推到作战室前端（复用现有 SSE 总线 `approval/particle` 域，新增 `calibration` 事件域）。

**(c) 批准/回滚**：复用 `approvePatch` / `rollbackPatch`（`store.js:117/149`）——**已含第0闸 `produceDecision` + 事务原子**，新 knob 需在 `knobs/index.js` 注册对应 `Strategy`（threshold/weight/requiredDims 已有；新增 confidence/edge_binding/outcome_threshold/strictness 四策略）。

### §3.3 页面修改

- **自动建议卡（浮动，模型 Y 环的"L3校准建议"节点）**：作战室顶部/侧浮卡，内容 = `偏差→根因(Rule id)→建议修正(to_value)→预期影响(expected_impact)`；提供「一键批准」（→ `POST /api/calibration/patches/:id/approve`，经第0闸）+「去重跑场景」（→ `decision-scenarios.html`）+「驳回」。
- **seven-dim.html 扩展**：在现有 7 维矩阵下加「7 边 × 维度绑定」页签（复用 sysadmin + 第0闸，编辑走 `/api/calibration/patches/generate`，与 `seven-dim.html:55-59` 同口径）；`strictness` 全局严格度作为 `edge_binding` 同页可调项。
- **校准处方看板增强**：列表增加 `knob` 类型色标 + `expected_impact` 折叠 + 状态机（PENDING→APPROVED→APPLIED/REJECTED→ROLLED_BACK）可视化。

### §3.4 MCP 修改（`src/mcp/tools.js`）

新增 1 读 + 1 敏感读 + 4 写（全部接现有 gateway 协议）：

| 工具名                              | 类型  | inputSchema                       | 后端                                          |
| -------------------------------- | --- | --------------------------------- | ------------------------------------------- |
| `crm_calibration_patches`        | 读   | `{status?, scenario_id?, limit?}` | `store.listPatches`                         |
| `crm_calibration_metrics`        | 敏感读 | `{scenario_id, window_days?}`     | `computeMetrics` + `attribute`（经 confirm 闸） |
| `crm_calibration_patch_generate` | 写   | `{scenario_id?}`                  | `POST /api/calibration/patches/generate`    |
| `crm_calibration_patch_approve`  | 写   | `{patch_id}`                      | `store.approvePatch`（第0闸）                   |
| `crm_calibration_patch_reject`   | 写   | `{patch_id}`                      | `store.rejectPatch`                         |
| `crm_calibration_patch_rollback` | 写   | `{patch_id}`                      | `store.rollbackPatch`                       |

### §3.5 SKILL 修改

- **`ai-feedback-loop` 增加"拒绝出方守卫↔平台 produceDecision 第0闸"对照**：金律 21（样本/覆盖不足不出方）↔ `rules.js` R5/R6 + `store.produceDecision` 第0闸。说明平台以"校准处方经 createDecision 第0闸"落实"调整须可追溯"。
- **`ai-memory-lifecycle`（M）与 `ai-context-layering`（K）增加交叉引用**：M 的 L1–L7/E1–E7 是 J2/J3 的被校准对象；K 的 K1–K4 是 J3 写回的目标（阈值/边绑定）。仅加指针，不注入 CRM 业务名词（合规）。

---

## §4 周而复始闭环编排（偏差→建议→批准→修正→重跑→再监控）

1. **监测**：`monitorStore` 周期聚合 J1（维度/边齐全度）+ J2（outcome 对比）+ J3（confidence）。
2. **偏差**：闸门标红 / `outcome_mismatch` / 边应存缺 / confidence 漂移 → 触发 `autoSuggest`。
3. **建议**：`attribute(metrics)` → `savePatches`（幂等，R5/R6 守卫优先）→ SSE 推作战室浮卡。
4. **批准**：用户一键 approve → `approvePatch` 经第0闸 `produceDecision` + 事务写回 K（`autonomy-conf` 阈值/权重/`edge_binding`/`strictness`）与 M（`required_dims`/边写入校验）。
5. **重跑**：浮卡「去重跑场景」→ `decision-scenarios.html` 以新配置重跑受影响的场景/决策。
6. **再监控**：重跑后作战室指标刷新，闭环在**同一个生命周期环**上可见。

---

## §5 任务拆分（承接主体文档 T5–T10，深化为可实施）

| 任务              | 维度    | 落点                                                                                                | Success                         |
| --------------- | ----- | ------------------------------------------------------------------------------------------------- | ------------------------------- |
| **T15 J2 字段**   | 字段    | `decision_outcome` + `decision.outcome_verified/confidence` + `outcome_event_map` DDL             | 迁移脚本可重跑幂等                       |
| **T16 J2 后端**   | 后端    | `outcome.js` + `outcomeIngester.js` + `monitorStore.getGateOutcome` + outcome 路由                  | 业务事件→outcome 自动回写；隐性错误簇可聚合      |
| **T17 J2 页面**   | 页面    | 作战室 L2 区 + 巡检卡业务结果行 + 手动补录 + 重跑入口                                                                 | 决策通过率 vs 业务成功率可见                |
| **T18 J2 MCP**  | MCP   | `crm_decision_outcome_query/gate_outcome/write`                                                   | MCP 可查可写结果，第0闸生效                |
| **T19 J3 字段**   | 字段    | `calibration_patch.knob` 扩展 + `KNOBS` + `config_store.edge_bindings` + `attribution.category` 四象限 | DB 约束放开；单测断言新 knob 不被拒          |
| **T20 J3 规则**   | 后端    | `rules.js` R7–R10 + `knobs/` 新增 4 策略                                                              | 新 knob 处方可生成可批准                 |
| **T21 J3 自动建议** | 后端+前端 | `autoSuggest.js` + SSE `calibration` 域 + 浮卡组件                                                     | 偏差即浮卡，一键批准→重跑                   |
| **T22 J3 页面**   | 页面    | seven-dim 边绑定页签 + 处方看板增强                                                                          | 边↔维可配；处方状态机可视                   |
| **T23 J3 MCP**  | MCP   | `crm_calibration_*` 6 工具                                                                          | MCP 全链路校准可读可写                   |
| **T24 SKILL**   | SKILL | `ai-feedback-loop` + `ai-memory-lifecycle` + `ai-context-layering` 增加平台实例化对照（中性示例）                | 金律 18/19/21 接平台；不污染 10 SKILL 基线 |

---

## §6 验收口径

- **J2**：业务事件（成交/丢单/回款）发生后 ≤ 1 分钟 `decision_outcome` 落库且 `decision.outcome_verified` 回写；`getGateOutcome` 暴露"隐性错误簇"；MCP `crm_gate_outcome` 返回双率对比。
- **J3**：`calibration_patch` 可针对 confidence/edge_binding/outcome_threshold/strictness 生成并批准；R5/R6 守卫在小样本时**零处方**；批准后经第0闸写回且 `autonomy-conf` 即时生效；`attribution.category` 四象限断言通过；自动建议卡在偏差出现后 ≤ 5s 浮出。

---

## §7 约束对齐（铁律）

- **写操作必经第0闸**：outcome 写、calibration 批准/回滚全部经 `produceDecision`（`store.js:41`）或 confirmation_token 两阶段；MCP 写工具同口径。
- **绝对禁删**：`outcome_event_map` / `calibration_patch` / `decision_outcome` 仅 upsert/状态迁移，无 DELETE 端点（呼应主体文档 G 系列）。
- **UI 一致性**：作战室/Cytoscape/浮卡全部走 `tokens.css` 语义变量，零硬编码色值（铁律 2026-08-30）。
- **10 SKILL 基线不污染**：J2/J3 领域实例化只进项目 `src/` + `db/` + 本文档；对 `ai-*` SKILL 仅加"中性示例"对照，不写 CRM/P2P 业务名词。
- **未批准不写实现**：本文为设计基线，进入实施需 writing-plans 拆分、逐 Task commit。
