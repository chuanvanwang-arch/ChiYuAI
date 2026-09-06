# context-routing 自适应回路设计（时间片 A/B 轮换 → 反推 tracks 与权重）

- 日期：2026-09-05
- 状态：**待批准**（未写任何实现代码）
- 触发：用户要求把 `context-routing`（场景路由：故事线/图谱/结构化轨道映射）的优化调整纳入 L3 与每日复盘，按"某场景注入叙事后决策质量分是否提升"反推 tracks 与权重
- 方案选型：**时间片 A/B 轮换**（用户 2026-09-05 确认）

---

## §0 红线声明与合规边界

`context-routing`（config_center id36）于 2026-09-04 被用户明确列为**平台核心配置、禁止任何修改**（含配置页保存、后端写、字段增删、默认值/权重调整）。本设计严格遵守，方式是**把"探索"与"改写"彻底解耦**：

| 行为 | 是否触碰 `config_store['context-routing']` | 载体 | 合规 |
|---|---|---|---|
| 时间片 A/B 轮换（实验臂） | **否** — 只在装配时做**运行时覆盖**，配置原值一字不动 | 新表 `crm.routing_experiment`（append-only） | ✅ 不触碰红线 |
| 反推结论 | **否** — 只产出 `calibration_patch` PENDING 处方 | `crm.calibration_patch` | ✅ 不触碰红线 |
| 人工批准应用 | **是** — 显式经第0闸 + 人工批准后才写 | `config_store['context-routing']` | ✅ 经你批准 |

**硬约束**：系统**永不自动**改写 `context-routing`。所有 `routing_*` 处方一律 `PENDING`，必须人工批准。

---

## §1 问题陈述（代码级证据）

当前 `context-routing` 是**纯人工静态配置**，零自适应回路。要"根据运行结果反推"，有 5 个硬缺口：

| # | 缺口 | 证据（file:line） | 后果 |
|---|---|---|---|
| **A** | 决策**未留存**当时用的轨道 | `crm.decision` 无 routing/tracks 列；`crm.decision_context_snapshot` 亦无（`assembleContextV2.js` 的 `base.routing` 只在内存 bundle，INSERT 未含该字段 → 落库即丢） | 无法回算"这条决策当时注入叙事了吗" |
| **B** | Q 采样器 skill 是**自我代理** | `closureLoop.js:373` `sampleQSkillT(row.scenario_id, row.scenario_id, q)` — skill 列恒等于 scenario_id | 无分组维度，做不了对照 |
| **C** | **无反事实样本**（致命） | routing 确定性：场景 tracks 不含 narrative → **永远**不注入 → 对照组恒空 | 反推在数学上不可能 |
| **D** | 传播中枢**无对应旋钮** | `store.js:29` KNOBS 13 类全落 `config_store['seven-dim']`（`knobs/index.js:16-31`）；`context-routing` 不在其内 | 算出建议也无处应用 |
| **E** | 触碰**禁改红线** | 见 §0 | 自动改配置被禁止 |

**已有可用信号**（无需新建）：

| 信号 | 来源 | 性质 |
|---|---|---|
| `Q` 决策质量分 | `crm.decision.rubric->>'weighted_total'`（`rubricScorer.js:228`，`closureLoop.js:368` 已在采） | 内在质量，决策当下即得 |
| `O` 业务结果 | `crm.decision.outcome_verified` ∈ {won,lost,paid,stalled,partial}（schema.sql:674） | 外在真值，滞后但硬 |
| `R` 覆写率 | `metrics.js:7` `isOverridden`（human_disposition ≠ disposition） | 人机分歧信号 |

---

## §2 目标 / 非目标

**目标**
1. 决策可持续回算"当时走了哪条轨道"（补 A）
2. 产生可信的反事实对照样本（补 C）
3. 每日复盘自动收口实验、产出**可执行处方**（补 D）
4. 一线/智能体在 L3 能感知"本场景当前轨道 + 是否在实验期"（可解释性）
5. 反推 tracks 增删 与 dims 权重/thresholds 调整，且**全部人工批准**

**非目标**
- ❌ 自动改写 `context-routing`（红线）
- ❌ 逐条随机探索（会让同场景不同决策上下文不一致，一线不可解释）
- ❌ 用 LLM 做反推（本设计全确定性算法，可复现、可回归）
- ❌ 改动 `classifyScene` 的值→分数映射语义（`routing.js:127-139`，属算法内置语义）

---

## §3 总体架构（数据流）

```
                      ┌──────────────────────────────────────────┐
   配置（只读）        │ config_store['context-routing']          │
   context-routing ──▶│ dims / scene_matrix / thresholds         │
                      └───────────────┬──────────────────────────┘
                                      │ resolveTracks()
                      ┌───────────────▼──────────────────────────┐
   实验臂（运行时覆盖）│ routing_experiment 表（append-only）      │
   不改配置！         │ (scenario, track, arm=on|off, window)     │
                      └───────────────┬──────────────────────────┘
                                      │ applyExperimentArm()
                      ┌───────────────▼──────────────────────────┐
   装配                │ assembleContextV2 / assembleContext       │
                      │  → routing{tracks, mode, score, exp_arm}  │
                      └───────┬───────────────────┬──────────────┘
                              │                   │
                 落快照（补A）│                   │ L3 注入 brief（§9）
                              ▼                   ▼
              decision_context_snapshot.routing   layers.L3.routing_brief
                              │
                      ┌───────▼──────────────────────────────────┐
   质量采样（补B）     │ Q 按 (scenario, track:xxx) 分组采样        │
                      │ decision_skill_quality（旧行不删）          │
                      └───────┬──────────────────────────────────┘
                              │
                      ┌───────▼──────────────────────────────────┐
   每日复盘（§10）     │ routingReview()：收口到期实验 → 判据 §7    │
                      │ → calibration_patch(PENDING, routing_*)   │
                      └───────┬──────────────────────────────────┘
                              │
                      ┌───────▼──────────────────────────────────┐
   人工批准（§8）      │ approvePatch → 第0闸 produceDecision       │
                      │ → KnobStrategy.apply → 才写 config_store   │
                      └──────────────────────────────────────────┘
```

---

## §4 数据底座补齐

### D1 — routing 落库（补缺口 A）

**迁移**（`db/migrate.js` 新增独立 `ALTER`，**遵守项目铁律**：不得写进 `CREATE TABLE IF NOT EXISTS` 段，否则旧库不补列 → 连带报错 → 整文件单事务回滚）

```sql
ALTER TABLE crm.decision_context_snapshot ADD COLUMN IF NOT EXISTS routing JSONB;
CREATE INDEX IF NOT EXISTS ix_crm_dcs_routing ON crm.decision_context_snapshot((routing->>'scene'));
```

**写入**：`assembleContextV2.js` 两处快照 INSERT（:200 / :317）增加 `routing` 列，值 = 昨天（2026-09-05）已加入的 `base.routing`（`assembleContextV2.js:302`）扩展为：

```js
routing: {
  scene, tracks, mode, score,
  exp_id:   experiment?.experiment_id ?? null,  // 所属实验
  exp_arm:  experiment?.arm ?? null,            // 'on' | 'off'
  exp_track:experiment?.track ?? null,          // 'narrative' | ...
}
```

**不加列到 `crm.decision`**：避免宽表与兼容成本，通过 `assembly_id → snapshot.routing` 关联（索引已存在）。

### D2 — Q 采样分组维度修复（补缺口 B）

`closureLoop.js:364 registerQSkillSampler` 当前 `skill = scenario_id`（自我代理）。改为**按真实轨道分组**：

```sql
SELECT d.scenario_id, d.decision_id, (d.rubric->>'weighted_total')::numeric AS q,
       s.routing->>'exp_track' AS track, s.routing->>'exp_arm' AS arm
FROM crm.decision d
JOIN crm.decision_context_snapshot s ON s.decision_id = d.decision_id
WHERE d.rubric IS NOT NULL AND d.rubric ? 'weighted_total'
```

采样键改为 `` `track:${track}:${arm}` ``（如 `track:narrative:on`）。旧行（skill=scenario_id）**保留不删**（禁 DELETE），与新键天然可区分。

---

## §5 时间片 A/B 轮换机制（补缺口 C，核心）

### 5.1 新表（append-only，禁 DELETE）

```sql
CREATE TABLE IF NOT EXISTS crm.routing_experiment (
  experiment_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT NOT NULL DEFAULT 'system',
  scenario_id   TEXT NOT NULL,
  track         TEXT NOT NULL,          -- 'narrative' | 'graph_decision' | 'graph_entity' | 'structured'
  arm           TEXT NOT NULL CHECK (arm IN ('on','off')),
  baseline      TEXT NOT NULL,          -- 配置原值（'on'|'off'），用于回滚与"是否真反转"校验
  window_start  TIMESTAMPTZ NOT NULL,
  window_end    TIMESTAMPTZ NOT NULL,
  status        TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','running','done','aborted')),
  decision_id   UUID REFERENCES crm.decision(decision_id),   -- 第0闸锚定（创建实验即留决策产证）
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_crm_rexp_active
  ON crm.routing_experiment(scenario_id, track, status, window_end);
```

**关键**：`arm` 与 `baseline` 同时记录 —— 若 `arm === baseline` 则该实验无对照价值，创建时直接拒绝（防"假实验"假绿）。

### 5.2 运行时覆盖（不写配置）

新增 `src/context/routingExperiment.js`：

```js
export function applyExperimentArm(tracks, exp)  // 纯函数，易测
export async function resolveActiveArm(scenarioId, track, { tenantId })  // 读表，fail-open
```

- `arm === 'on'`  → `tracks ∪ {track}`
- `arm === 'off'` → `tracks \ {track}`
- 无实验 / 读表失败 → **原样返回 tracks**（fail-open，绝不阻断装配）

**接入点**：`assembleContextV2.js`（决策落库主路径）与 `assembler.js:181`（agentLoop 路径）**两处**都要接，否则重演昨天修复的"两条路径行为分裂"。

### 5.3 轮换调度

- 周期：`config_store['routing-explore'].window_days`，**出厂兜底 14 天**（阈值配置化铁律，禁硬编码）
- 节奏：同一 (scenario, track) 一个时间片只跑一个 arm；收口后若证据不足（`n < MIN_ARM_SAMPLE`）→ **自动排下一个反向 arm**（把对照补齐），否则状态转 `done`
- 并发上限：全局同时 `running` ≤ 2；单场景同时只允许 1 个 track 实验（防全局抖动）
- 业务高风险场景**默认黑名单**：`QUOTE_PRICING`、`SIGN_RISK`（报价与签单风险，错配上下文代价高）→ 需显式加入白名单才实验

---

## §6 质量信号与聚合判据

按 `(scenario_id, track, arm)` 分组聚合：

| 指标 | 计算 | 方向 |
|---|---|---|
| `n` | 样本数 | 门槛 |
| `Q̄` | `AVG(rubric->>'weighted_total')` | 越高越好 |
| `success_rate` | `outcome_verified IN ('won','partial')` 占比 | 越高越好 |
| `override_rate` | `human_disposition IN ('OVERRIDDEN','CORRECTED')` 占比 | 越低越好 |

**最小样本**：`MIN_ARM_SAMPLE` 默认 **20**（配置化），任一组不足 → **不出结论**（对齐 `retro.js:194` R6 守卫精神，杜绝小样本假绿）。

---

## §7 反推算法（确定性，无 LLM）

### 7.1 tracks 增删判据

```
ΔQ  = Q̄(on) − Q̄(off)
ΔO  = success_rate(on) − success_rate(off)
ΔR  = override_rate(on) − override_rate(off)      // 越低越好，故"有利"= ΔR < 0
```

**显著性**（三取二 + 符号一致）：

| 条件 | 阈值（配置化） |
|---|---|
| 质量显著 | `|ΔQ| ≥ Q_EPS`（默认 0.05） |
| 业务同向 | `ΔO` 与 `ΔQ` 同号 且 `|ΔO| ≥ O_EPS`（默认 0.10） |
| 人机佐证 | `ΔR ≤ −R_EPS`（默认 0.05） |

- **三取二成立** → 出 `routing_tracks` 处方：`Δ > 0` 且当前 off → 建议**加入**；`Δ < 0` 且当前 on → 建议**移除**
- 不足 → 出 `null` 结论 + 记录 `insufficient_evidence`（诚实留痕，不硬凑）

### 7.2 权重 / 阈值反推

把"实测最优 arm"当作该场景的**真实标签**：

- 最优 arm = `on`（叙事有利）→ 真实倾向 `STORY_PRIMARY`
- 最优 arm = `off` → 真实倾向 `GRAPH_PRIMARY`

若 `classifyScene(scenarioId).mode` 与实测标签**不符** → 说明该场景 dims 权重/阈值把分型推错了，生成 `routing_weight` 处方：

- 单处方**权重调整幅度 ≤ 0.05**（防震荡）
- 调整后 dims 权重**归一化**（和恒为 1）
- 目标：使 score 跨过 `thresholds.graph` / `thresholds.story` 边界（留 0.02 余量防抖动）
- **冷却期**：同 (scenario, dim) 30 天内不重复出权重处方

若多个场景长期堆积在 `BOTH` 区（0.4 < score < 0.6）→ 生成 `routing_threshold` 处方（±0.05）。

**risk 分级**：`routing_tracks` = MEDIUM；`routing_weight` / `routing_threshold` = **HIGH**（影响面覆盖全场景）→ 走既有 `autonomyEngine` 强制人工升级闸。

---

## §8 传播中枢新增旋钮（补缺口 D）

| 文件 | 改动 |
|---|---|
| `src/calibration/store.js:29` | `KNOBS` 增 3 类：`routing_tracks` / `routing_weight` / `routing_threshold` |
| `src/calibration/knobs/routingStrategy.js` | **新文件**：3 个 `KnobStrategy` 子类（`readCurrent` / `apply` / `replayImpact` / `riskLevel`，接口见 `knobs/base.js:7-13`） |
| `src/calibration/knobs/index.js:16` | REGISTRY 注册 3 项 |

`apply()` 落点 = `config_store['context-routing']`，**必须经事务 client + 第0闸 `produceDecision`**（复用 `store.js:58`），且 `from_value` 存旧值供回滚（复用既有 `rollback` 端点）。

**注意**：`propagationRoutes.js:115` 对 `config_store` 类目标要求 **ADMIN** 权限 —— `routing_*` 属此列，天然满足最小权限。

---

## §9 L3 注入（可解释性，纳入 L3）

`assembler.js:110 retrieveL3` 当前只取 `tasks + agent_health`。扩展返回：

```js
return { tasks: r.rows, agents: h.rows, routing_brief: {...} };
```

```js
routing_brief: {
  scene, mode, score, tracks,
  experiment: experiment ? { track, arm, window_end, experiment_id } : null,
  q_trend: { q0, qn, n, improved }     // 复用 qSkillComposite 口径（closureLoop.js:336）
}
```

**目的**：一线/智能体在执行协同层能回答"为什么这次没给我看历史时间线"——答案来自 `routing_brief.experiment`，而不是黑盒。

**注入量控制**：只注 brief（约 5 字段），不注全量 `scene_matrix`，防 prompt 膨胀。

---

## §10 每日复盘接入

`src/decision/retro.js` 增一个**独立 pass** `routingReview({ windowHours })`，**不改既有 LLM 聚类路径**（避免干扰 `clusters` / `draft_patches` 既有契约）：

1. 扫 `crm.routing_experiment` 中 `window_end <= now AND status='running'` → 收口 `status='done'`
2. 对每组跑 §6 聚合 + §7 判据 → 产出 `draft_patches`（knob ∈ {routing_tracks, routing_weight}）
3. 结果并入 `decision_retro_report.summary.routing`（**追加式**，禁 DELETE、不触碰 `calibration_patch` 写通道，对齐 `retro.js:325` 既有铁律）
4. 若证据不足 → `status` 转回 `planned` 并排下一个**反向 arm**（补对照）

**调度**：挂到 `scheduler/timers.js:27 runRetroOnce` 之后（每日 02:00 + `catchUpRetro` 补跑），失败仅 `emit('trace')` + `recordFailure`，不阻断。

---

## §11 安全边界与守卫（汇总）

| 守卫 | 规则 |
|---|---|
| **红线** | 系统永不自动写 `config_store['context-routing']`；所有处方 PENDING |
| **第0闸** | 创建实验、应用处方均须 `produceDecision` 锚定 decision_id |
| **并发** | 全局 running ≤ 2；单场景同时 1 个 track 实验 |
| **黑名单** | `QUOTE_PRICING` / `SIGN_RISK` 默认不实验，需显式开 |
| **最小样本** | `MIN_ARM_SAMPLE = 20`（配置化），不足不出结论 |
| **防震荡** | 权重单步 ≤ 0.05，归一化；同 (scenario, dim) 30 天冷却 |
| **fail-open** | 实验表读取失败 → 按配置原样，绝不阻断装配 |
| **禁 DELETE** | 实验表 / 快照 / Q 采样全 append-only；收口改 status 不删行 |
| **可回滚** | 每个处方 `from_value` 存旧值；复用既有 rollback 端点 |
| **禁裸 catch** | 所有失败路径 `emit('trace')` + `recordFailure`（对齐项目铁律） |

---

## §12 测试计划

| 文件 | 覆盖 |
|---|---|
| `test/context/routingExperiment.test.js`（新） | `applyExperimentArm` on/off/无实验；`arm===baseline` 被拒；fail-open；落快照含 exp_id |
| `test/decision/routingRetro.test.js`（新） | 判据显著/不显著/样本不足；反向下期排程；报告 summary.routing |
| `test/calibration/routingKnob.test.js`（新） | 3 个策略 `readCurrent`/`apply`/`riskLevel`；权重归一化与 ≤0.05 约束；回滚 |
| 回归 | `test/context/*`（含昨天新增 `assembleContextV2Routing.test.js`）、`test/decision/*retro*`、`closureLoop`、`test/context-supply-7x7.test.js` |

---

## §13 实施分期

| 期 | 内容 | 行为变更 | 价值 |
|---|---|---|---|
| **P0** 观测底座 | §4（routing 落库 + Q 分组修复）+ §9（L3 brief） | **零** | 先把可回算数据攒起来，无风险 |
| **P1** 实验与反推 | §5（实验表 + 轮换调度）+ §6 + §7 + §8（旋钮） | 实验期内该场景轨道被覆盖（可解释、可回滚） | 产出可执行处方 |
| **P2** 复盘接入 | §10（每日自动收口）+ 监控台浮卡 | 每日 02:00 自动跑 | 闭环可见 |

建议 **P0 先上、跑满 2 周攒基线**，再启 P1 —— 否则实验一开始就没有对照基准。

---

## §14 风险与未决

| 风险 | 说明 | 缓解 |
|---|---|---|
| 实验期上下文变化影响真实客户决策 | 某场景临时不给叙事时间线，可能漏看历史 | 黑名单 + 并发上限 + 人工批准 + L3 brief 可解释 |
| Q（rubric 自评）与 O（业务结果）背离 | 两个信号可能给出相反结论 | 三取二 + 符号一致判据；背离时降级为 `insufficient` |
| 权重反解震荡 | 反复微调导致分型跳变 | 单步 ≤0.05 + 30 天冷却 + 阈值留 0.02 余量 |
| L3 brief 增加 prompt 长度 | token 成本 | 只注 5 字段 brief；P1 上线后实测 token 增量 |
| **未决 1** | 时间片 14 天是否合适（销售决策量低可能攒不够 20 样本/期） | 需 P0 上线后看实际决策密度再定；可能要放宽到 30 天或降 MIN_ARM_SAMPLE |
| **未决 2** | 是否允许对 `graph_decision` / `structured` 也做实验（本设计四轨通用，但优先级建议先只做 `narrative`） | 建议 P1 只开 `narrative`，跑通再扩展 |

---

## §15 自查

- [x] 无占位符 / TBD
- [x] 与 §0 红线一致：全文无"自动改写配置"路径
- [x] 与既有铁律一致：禁 DELETE、第0闸、阈值配置化、禁裸 catch、ALTER 独立语句
- [x] 未与 10 大 ai-* SKILL 冲突（本设计为项目领域实现，非方法论 SKILL 内容）
- [x] 所有 file:line 锚点已实测核对
