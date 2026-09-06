# 决策质量校准闭环设计（Decision Quality Calibration Loop）

- 日期：2026-08-28
- 状态：设计（待用户评审 → writing-plans）
- 关联：`docs/2026-08-25-sales-decision-monitoring-design.md`（监控台）、`docs/2026-08-28-s20-seven-dim-matrix-design.md`（7×7）、总体设计 §6（决策事件主轴）

---

## §0 背景：监控与调整之间缺一整层

用户提出的目标链路是**预设值 → 运行 → 反馈 → 调整 → 运行更好**。现状是：

- **预设**：7×7 矩阵（`decision_scenario.required_dims`，S20 设计中，尚未实施）
- **运行**：`autonomyEngine.js` 产出 `crm.decision`
- **监控**：`/sales-decision-monitor`（`monitorStore.js` 指标聚合）
- **调整**：7×7 配置面（开发中）

监控与调整之间**没有"度量—归因—处方"层**，导致三处断裂：

| # | 断裂 | 后果 |
|---|---|---|
| 1 | 无被调量（ground truth） | 不知道"决策对不对"，任何自动调整只能优化内部一致性 |
| 2 | 无归因映射 | 监控看的是自主率/升级率，7×7 调的是上下文完整性，两者不是同一组变量，无因果链 |
| 3 | 无处方载体与治理 | 无"建议 → patch → 审批 → 灰度 → 回测"链路，调完无法证明变好还是变坏 |

### §0.1 代码级现状核实（本设计的全部证据）

| # | 事实 | 证据 |
|---|---|---|
| F1 | `decision` 表预留 `outcome` / `feedback_link`，但 `feedback_link` **0 处写入**；`outcome` 仅 `AUDIT_HIGHLIGHT`、`REVERSED` 两种值 | `db/schema.sql:162-163`；`autonomyEngine.js:132`；`decisionRepo.js:216` |
| F2 | **`confirmDecision` 与 `reverseDecision` 全仓 0 调用方**（仅定义） | 全仓 grep：`decisionRepo.js:195` / `:214` 无其他引用 |
| F3 | 由 F2 推得：`state='CONFIRMED'` 与 `outcome='REVERSED'` 恒不产生 → `reversal_rate` 恒为 0 | `decisionTrace.js:22,29` |
| F4 | `decision` 表**无人工最终处置字段**，人工覆写信号无采集点 | `db/schema.sql:148-169` |
| F5 | `crm.tasks`（待办工作台）**无 `decision_id` 列** → 决策与人工处置结构未关联 | `db/schema.sql:47-71` |
| F6 | `decided_at` 在 INSERT 时即写入 `now()`（非真正决策时刻），仅 `confirmDecision` 时更新 | `decisionRepo.js:53`；`:198` |
| F7 | 置信度存在 `decision_event.payload.confidence`，**不在 `decision` 行上** | `autonomyEngine.js:114,134`；`decisionRepo.js:184-191` |
| F8 | 监控只聚合 `state` 分布（自主/升级/人工），是过程量非质量量 | `monitorStore.js:45-65` |
| F9 | 阈值与权重硬编码，`DEFAULT_CONF` 无配置面 | `autonomyEngine.js:8` |
| F10 | 7×7 闸门从未生效：全部场景 `required_dims = []` | S20 设计 §0 表第 1 项 |

**关键结论（修正初版假设）**：初版判断"人工信号零新增采集即可获得"是**错误的**。由 F2/F4/F5，人工处置动作从未回写到决策表，人工信号链路根本不存在。因此本设计将**HITL 处置回写接线列为 P0 前置任务**，不可省略。

---

## §1 目标与范围

**目标**：在监控与配置之间建立校准层，使系统能自动输出**可归因、带预期影响、可批准可回滚**的调整处方，把"管理员凭感觉调参"变成"管理员审处方"。

### 分期

| 期 | 内容 | 依赖 |
|---|---|---|
| **P0** | HITL 处置回写接线（采集人工信号） | 无 |
| **P1** | 度量集 + 归因规则 + 处方生成 + 影子重放（阈值/权重旋钮） | P0 |
| **P2** | 监控页「校准」页签：指标 → 归因 → 处方批准/驳回/回滚 + 回测 | P1 |
| **P3** | `required_dims` 类处方（7×7） | S20 落地后 |

**范围内**
- 旋钮：`threshold`、`weights.{similarity,coverage,method,allMet}`
- 被调量：人工处置信号（覆写率 / 改判 / 延迟 / 升级疲劳）
- 载体：监控页新增页签 + `/api/calibration/*`

**范围外**
- `required_dims` 处方（P3，S20 之后）
- LLM 解释层（二期可选，本设计只留接口位）
- 业务结果回写（赢单/丢单/回款，二期）
- A/B 分流与因果推断（样本量不足，不成立）

---

## §2 数据模型增量

### §2.1 新增列

```sql
ALTER TABLE crm.decision
  ADD COLUMN IF NOT EXISTS human_disposition    TEXT,
  ADD COLUMN IF NOT EXISTS human_decided_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS human_decider_id     TEXT,
  ADD COLUMN IF NOT EXISTS human_decider_role   TEXT;

ALTER TABLE crm.tasks
  ADD COLUMN IF NOT EXISTS decision_id UUID REFERENCES crm.decision(decision_id);
CREATE INDEX IF NOT EXISTS idx_crm_tasks_decision ON crm.tasks(decision_id);
```

**设计说明**
- `human_disposition` 与 `disposition` 分离：后者是引擎建议，前者是人工最终处置。**二者不等即覆写**——这是本设计的核心被调量。
- `human_decided_at` 独立于 `decided_at`：因 F6，`decided_at` 在 INSERT 时即为 `now()`，不能用于度量人工延迟。
- `crm.tasks.decision_id` 建立"决策 → 待办 → 人工处置"的可 JOIN 链路（F5）。

### §2.2 新表 `crm.calibration_patch`

```sql
CREATE TABLE IF NOT EXISTS crm.calibration_patch (
  patch_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario_id     TEXT NOT NULL REFERENCES crm.decision_scenario(scenario_id),
  knob            TEXT NOT NULL CHECK (knob IN ('threshold', 'weight', 'required_dims')),
  target          TEXT,                    -- threshold: NULL；weight: 权重键；required_dims: 维度键
  from_value      JSONB NOT NULL,
  to_value        JSONB NOT NULL,
  evidence        JSONB NOT NULL,          -- 命中规则 + 指标快照 + 样本 decision_id 列表
  expected_impact JSONB,                   -- 影子重放输出
  risk            TEXT NOT NULL CHECK (risk IN ('LOW','MEDIUM','HIGH')),
  status          TEXT NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING','APPROVED','REJECTED','APPLIED','ROLLED_BACK')),
  decision_id     UUID REFERENCES crm.decision(decision_id),   -- 第0闸
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at     TIMESTAMPTZ,
  resolved_by     TEXT
);
CREATE INDEX IF NOT EXISTS idx_calibration_patch_status
  ON crm.calibration_patch(status, created_at DESC);
```

> `knob` 枚举含 `required_dims` 是为 **P3 预留，本期不实现**（§1 范围外）。提前入枚举可避免 P3 时再做 DDL 变更；本期 `attribute()` 只产出 `threshold` 与 `weight` 两类处方。

### §2.3 配置外置

`config_store['autonomy-conf']`：

```json
{ "threshold": 0.8,
  "weights": { "similarity": 0.4, "coverage": 0.3, "method": 0.2, "allMet": 0.1 } }
```

初值必须与 `autonomyEngine.js:8` 的 `DEFAULT_CONF` **逐字一致**，由 parity 测试锁死（§8）。

> **不新增列**：`suggested_confidence` 列曾被考虑，但因 F7（`decision_event.payload.confidence` 已存）而取消——影子重放的校验直接从 `decision_event` 取值，遵循 YAGNI。若后续出现高频查询需求再物化。

### §2.4 决策场景种子

处方批准属配置写，需携带第0闸 decision。新增场景（幂等，与 `ATTR_SCHEMA_CHANGE` 同款写法，写入 `db/seed.sql:263` 之后与 `db/test-setup.sql:49` 之后）：

```sql
('CALIBRATION_CHANGE', 'meta', '决策引擎校准参数变更（阈值/权重）',
 '{"action":["calibration-patch-apply"]}'::jsonb,
 ARRAY[]::TEXT[],
 '[{"cond":"impact","label":"影响面","weight":1,"required":true},{"cond":"evidence","label":"证据充分性","weight":1,"required":true},{"cond":"rollback","label":"可回滚性","weight":1,"required":true}]'::jsonb,
 'HIGH', FALSE)
ON CONFLICT (scenario_id) DO NOTHING;
```

`HIGH` + `autonomous_allowed=FALSE` 的原因：改阈值直接影响自主放行边界，与 `ATTR_SCHEMA_CHANGE` 同级，不允许自主执行。

---

## §3 P0：HITL 处置回写接线

新建 `src/decision/disposition.js`，作为人工处置的**唯一出口**：

```js
recordHumanDisposition(decision_id, { disposition, by_id, by_role, note })
```

行为：
1. 校验 `decision_id` 存在且 `state IN ('HUMAN','AUTONOMOUS','REQUIRED')`，否则 404/409
2. 写 `human_disposition` / `human_decided_at=now()` / `human_decider_id` / `human_decider_role`
3. `state` 迁移：覆写（与 `disposition` 不等）→ `REVERSED` 并置 `outcome='REVERSED'`；一致 → `CONFIRMED`
4. 审计留痕：写 `crm.audit_event`（`target_particle_type='decision'`、`source='approval'`、`action='human-disposition'`、`decision_id=<本决策自身>`、payload 含前后处置、checksum 链）。
   **不另建 decision**：人工处置是对既有决策的补全，若要求它"携带一个 decision_id"，将出现决策自引用，语义不成立。第0闸在此处的正确形态是复用被处置决策自身的 id 落审计链（`schema.sql:273` 已为此设计 `audit_event.decision_id` 列）。
5. `recordDecisionEvent('human-disposition', { decision_id, disposition, overridden })`
6. `reverseDecision` 的既有 AGE 图 `OVERRIDES` 边逻辑收敛到此处（覆写分支）

**接线点**：升级（`mode === 'escalated'`）决策生成待办时携带 `decision_id`。
锚点：`routes.js:193`（注释已声明"产出 HUMAN 态决策供审批流消费"，但消费侧缺失）、`routes.js:216`。

**收敛**：`confirmDecision` / `reverseDecision` 降级为内部函数，不再直接对外调用（消除无调用方的死代码，F2）。

---

## §4 P1：度量集（人工信号）

`src/calibration/metrics.js` —— **纯函数**，输入决策数组，输出指标对象，便于测试：

| 指标 | 定义 | 用途 |
|---|---|---|
| `sample_size` | 样本量 | 样本闸门（§5 R6） |
| **`autonomy_override_rate`** | `state='AUTONOMOUS'` 中 `human_disposition` 非空且与 `disposition` 不等的比例 | **核心质量指标**：AI 自主拍板的对不对 |
| `escalate_rate` | `state='HUMAN'` 占比 | 放权/收权依据 |
| `escalation_fatigue_rate` | `state='HUMAN'` 且超过 24h 无 `human_disposition` 的比例 | 判断升级是否虚设 |
| `human_latency_p50` | `human_decided_at - created_at` 中位数 | 人工负担 |
| `reversal_rate` | `outcome='REVERSED'` 占比（P0 接线后才有真实值） | 事后逆转 |
| `precedent_coverage_avg` | `referenced_precedents` 长度 / k 的均值 | 先例充分度 |

---

## §5 P1：归因规则

`src/calibration/rules.js` —— 规则以数据表 `RULES` 声明，纯函数求值 `attribute(metrics, ctx) → patches[]`。

| 规则 | 触发条件 | 处方 | 风险 |
|---|---|---|---|
| **R6** | `sample_size < 20` | **不出方**，标记"样本不足" | — |
| **R5** | `precedent_coverage_avg < 0.3` 持续 | **不出方**，提示"先例不足，调参无效" | — |
| R1 | `autonomy_override_rate > 0.25` 且平均置信度距阈值 < 0.05 | `threshold +0.05` | LOW |
| R2 | `escalate_rate > 0.6` 且升级件中覆写率 < 0.05 | `threshold -0.05`（放权） | MEDIUM |
| R3 | 单场景 `escalation_fatigue_rate > 0.3` | `threshold -0.05` 或提示精简升级条件 | MEDIUM |
| R4 | 权重敏感性：`methodScore` 与覆写相关性显著高于其他分项 | 调对应 `weight` ±0.05 | MEDIUM |

**R5/R6 是拒绝出方的规则**，优先级高于所有出方规则。这比"会出方"更重要——小样本上出方等于过拟合噪声。

规则表本身可配置（存 `config_store['calibration-rules']`），二期开放编辑；一期只读，改规则走代码。

---

## §6 P1：影子重放（Shadow Replay）

`src/calibration/replay.js` —— 本设计技术含量最高的部分，让处方带上**预期影响**而非拍脑袋。

### 可行性依据

置信度公式所需输入**全部已落库**：

| 输入 | 来源 | 证据 |
|---|---|---|
| `conditions_evaluated`（各维 `met`/`weight`） | `decision` 行 | `decisionRepo.js:51` |
| `referenced_precedents[].similarity` | `decision` 行 | `decisionRepo.js:51` |
| `business_tier` | `decision` 行 | `schema.sql:161` |
| `trigger_context.relations`（champion/relationship 强度） | `decision` 行 | `autonomyEngine.js:88` |
| `k`（先例数） | 运行时 `opts.k \|\| 5` | `autonomyEngine.js:79` |

因此给定候选参数，**可精确重算**历史每条决策的置信度与自主/升级判定，属纯确定性计算、零 LLM 成本。

### 接口

```js
replayConfidence(decision, cfg)  // → conf（与 autonomyEngine 同公式）
replayScenario(decisions, cfg)   // → { autonomy, escalated, delta, estimated_override_rate }
```

`estimated_override_rate` 为**一阶近似**：重放后判定为自主的样本按当前 `autonomy_override_rate` 加权，判定为升级的按当前升级件覆写率加权。必须在 UI 上标注"估算，非承诺"。

### 准确性校验

对历史**自主**决策重放得到的 `conf`，应与 `decision_event.payload.confidence`（F7）一致，误差阈值 `< 1e-6`。此校验进测试（§8），是重放可信度的守卫。

### 已知约束

- `k` 未落库。约定运行端与重放端均取常量 5；若未来运行端传入自定义 `k`，需同步落库或配置化，否则重放失真（记为技术债，见 §10）。
- 先例库随时间变化，重放使用**决策当时**的 `referenced_precedents.similarity`（已存），因此不受先例库演化影响。这一点是本方案成立的前提。

---

## §7 端点与 UI

### 端点（全部 `sysadmin`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/calibration/metrics?scenario_id=&window_days=30` | 6 项指标 |
| GET | `/api/calibration/patches?status=PENDING` | 处方列表 |
| GET | `/api/calibration/replay?scenario_id=&threshold=&weight_*` | 重放预览（不落库） |
| POST | `/api/calibration/patches/:id/approve` | 第0闸：`createDecision({scenario_id:'CALIBRATION_CHANGE'})` → 写 `config_store['autonomy-conf']` → patch 置 `APPLIED` 并回写 `decision_id` |
| POST | `/api/calibration/patches/:id/reject` | `REJECTED` |
| POST | `/api/calibration/patches/:id/rollback` | 恢复 `from_value` → `ROLLED_BACK` |

> 挂载位置：`routes.js` 中 `/api/monitor/*` 段之后（`routes.js:1265` 后）。
> **routes.js 改动需重启 server 才生效**（既有约定）。

### UI：`/sales-decision-monitor` 新增「校准」页签

`sales-decision-monitor.html`（现 507 行）内追加一个页签，四段式：

1. **指标卡**：`autonomy_override_rate` 主卡 + 5 项辅卡 + 样本量提示
2. **归因面板**：命中的规则 + 证据（可下钻到具体 `decision_id`）
3. **处方卡片**：`knob` / `from→to` / 预期影响（重放）/ 风险 / 批准·驳回
4. **历史区**：已应用处方的 before/after 对比

LLM 解释层**不在本期实现**，但处方数据结构的 `evidence` 字段预留 `narrative` 键位，二期填充。

---

## §8 测试计划

| 文件 | 覆盖 |
|---|---|
| `test/decision/disposition.test.js`（新） | 人工处置回写；覆写→`REVERSED`；一致→`CONFIRMED`；未知 id→404；第0闸产生 decision |
| `test/calibration/metrics.test.js`（新） | 6 项指标纯函数；空样本；全自主无人工处置 |
| `test/calibration/rules.test.js`（新） | R1–R4 出方；**R5/R6 拒绝出方**；规则优先级 |
| `test/calibration/replay.test.js`（新） | **重放 conf 与 `decision_event.payload.confidence` 误差 < 1e-6**；阈值上调后自主数下降 |
| `test/calibration/router.test.js`（新） | 非 sysadmin→403；批准产生 `CALIBRATION_CHANGE` decision；回滚恢复原值 |
| `test/calibration/parity.test.js`（新） | **parity**：`config_store['autonomy-conf']` 缺省时引擎行为与 `autonomyEngine.js:8` 的 `DEFAULT_CONF` 完全一致；场景 `CALIBRATION_CHANGE` 存在于 seed 与 test-setup 两处 |
| 回归 | 全量 |

> 测试目录约定：`test/` 下按子域分目录（现有 `test/db`、`test/http`、`test/sevenDimensions` 等），故新建 `test/calibration/`。
> 注意：`test/` 根下已有 `decision.test.js` / `decision-gate.test.js` / `decision-trace.test.js`，**不存在** `test/decision/autonomyEngine.test.js`，parity 断言不得挂到不存在的文件上。

---

## §9 风险与验收

### 风险

1. **P0 接线是本期最大工作量与回归面**：`tasks` 表加列 + 待办生成侧改造，触及既有待办链路。
2. **阈值外置的行为回归**：初值必须与 `autonomyEngine.js:8` 逐字一致，parity 测试锁死。
3. **样本量噪声**：一期必须由 R6 闸门兜底，否则指标全是噪声、处方全是过拟合。
4. **P3 依赖 S20**：`required_dims` 处方需等 7×7 落地（`seven-dim.html` 现仅 51 行，改造未实施）。本期只注册旋钮位，不实现。
5. **`k` 未落库**：见 §6 已知约束。

### 验收口径

- 升级决策产生的待办携带 `decision_id`；人工处置后 `decision.human_disposition` 被写入
- `GET /api/calibration/metrics` 返回 6 项指标，且有真实样本时 `autonomy_override_rate` 非零（P0 前恒为 0，可作为接线成功的判据）
- 影子重放对历史自主决策复算的 `conf` 与 `decision_event.payload.confidence` 误差 `< 1e-6`
- 样本量 < 20 时**不产生任何处方**
- 批准处方产生 `CALIBRATION_CHANGE` decision（第0闸），`config_store['autonomy-conf']` 生效；回滚后恢复原值
- 非 `sysadmin` 访问 `/api/calibration/*` → 403

---

## §10 未决项与技术债

| # | 项 | 处理 |
|---|---|---|
| 1 | 运行端 `k` 未落库，重放端取常量 5 | 本期约定常量；若运行端未来传自定义 `k`，需同步落实 |
| 2 | LLM 解释层 | 二期；`evidence.narrative` 已预留 |
| 3 | 业务结果回写（赢单/丢单/回款） | 二期；`decision.feedback_link` 列已预留（`schema.sql:163`） |
| 4 | `required_dims` 处方 | P3，依赖 S20 |
| 5 | 规则可编辑化 | 二期；本期只读 |
