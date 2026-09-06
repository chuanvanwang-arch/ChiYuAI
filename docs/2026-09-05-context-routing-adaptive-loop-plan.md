# context-routing 自适应回路 — 实施计划（writing-plans）

- 日期：2026-09-05
- 依据设计：`docs/2026-09-05-context-routing-adaptive-loop-design.md`（用户 2026-09-05 批准）
- 范围：**P0 本期实施**；P1/P2 列出任务分解，**待 P0 跑满 2 周攒基线后**再启（设计 §13 建议）
- 铁律：禁 DELETE、第 0 闸、阈值配置化（禁硬编码）、禁裸 catch、ALTER 走独立迁移文件、每 Task 一 commit

---

## §A 分期与执行状态

| 期 | 内容 | 行为变更 | 本期 |
|---|---|---|---|
| **P0** 观测底座 | §D1 routing 落库 + §D2 Q 分组修复 + §L3 brief | **零** | ✅ 本期实施 |
| **P1** 实验与反推 | 实验表 + 轮换 + 判据 + 3 旋钮 | 实验期轨道被覆盖 | ⏸ 待基线 |
| **P2** 复盘接入 | `routingReview()` 挂每日 02:00 | 每日自动跑 | ⏸ 待 P1 |

---

## §B P0 任务分解

### Task 1 — 迁移：快照补 routing 列（独立 SQL 文件）

**新增** `db/migration-routing-observability.sql`：

```sql
-- 铁律：不得写进 schema.sql 的 CREATE TABLE 段（旧库不补列 → 整文件单事务回滚）
ALTER TABLE crm.decision_context_snapshot ADD COLUMN IF NOT EXISTS routing JSONB;
CREATE INDEX IF NOT EXISTS ix_crm_dcs_routing_scene
  ON crm.decision_context_snapshot((routing->>'scene'));
```

**注册**：`db/migrate.js` 的 `INCREMENTAL_SQL`（:12-32）追加
`'migration-routing-observability.sql'`（置于清单末尾，依赖 snapshot 表已存在）。

**验收**：两库（crm_native / crm_native_test）跑 `npm run migrate` 后列存在。

---

### Task 2 — routing 落库（补缺口 A）

`src/context/assembleContextV2.js`，两处快照 INSERT 均加 `routing` 列：

| 位置 | 值来源 |
|---|---|
| `freezePreContext`（:200 INSERT） | `pre.routing`（persist:false 路径已回带 `base.routing`） |
| 主路径（:317 INSERT） | `base.routing`（:302 已有） |

`base.routing` 扩展为（P1 实验字段先留 `null`，结构一次性到位）：

```js
routing: routing ? {
  scene, tracks, mode, score,
  exp_id: null, exp_arm: null, exp_track: null,
} : null
```

**不改** `crm.decision`（避免宽表），经 `assembly_id → snapshot.routing` 关联。

---

### Task 3 — Q 采样分组维度修复（补缺口 B）

`src/decision/closureLoop.js:371-374`，采样 SQL 改为 JOIN 快照取轨道：

```sql
SELECT d.scenario_id, d.decision_id, (d.rubric->>'weighted_total')::numeric AS q,
       s.routing AS routing
FROM crm.decision d
LEFT JOIN crm.decision_context_snapshot s
       ON s.decision_id = d.decision_id
WHERE d.rubric IS NOT NULL AND d.rubric ? 'weighted_total'
```

分组键（`deriveQGroup()` 纯函数，便于单测）：

| 条件 | skill 键 |
|---|---|
| 有 `routing.exp_arm`（P1 起） | `track:${exp_track}:${exp_arm}` |
| 有 `routing.tracks` 无实验 | `track:narrative:${tracks.includes('narrative') ? 'on' : 'off'}` |
| 无 routing（存量决策 / 未装配） | `scenario_id`（**保持旧行为**，不丢样本、旧行不删） |

旧行（skill = scenario_id）**保留不删**，与新键天然可区分。

---

### Task 4 — L3 注入 routing_brief（可解释性）

`src/context/assembler.js`
- `retrieveL3(actor)` → `retrieveL3(actor, intent)`；调用处 `:164` 传 `intent`
- 返回增 `routing_brief`：

```js
{
  scene, mode, score, tracks,
  narrative_injected: tracks?.includes('narrative') ?? true,
  experiment: null,                      // P1 填 { track, arm, window_end }
  q_trend: { q0, qn, n, improved } | null // 失败/无样本 → null（fail-open）
}
```

`q_trend`：按当前分组键查 `crm.decision_skill_quality` 最近 N 条（N 走 `config_store['routing-explore'].trend_n`，**出厂兜底 20**）；查询失败 → `null` + `emit('trace')`，**不阻断装配**。

`src/context/injector.js`：L3 段后追加一行 brief（仅当有 `routing_brief`），控制 prompt 膨胀：

```
场景轨道(QUOTE_PRICING/图谱主 score=1.00): 叙事时间线未注入(routing-excluded)
```

---

### Task 5 — 测试（新增 + 回归）

**新增** `test/context/routingObservability.test.js`：

| 例 | 断言 |
|---|---|
| 1 | `deriveQGroup` 三分支（实验臂 / 有 tracks / 无 routing 回退 scenario_id） |
| 2 | 快照 INSERT 含 routing 列且值 = base.routing |
| 3 | freeze 路径（persist:false → freezePreContext）routing 不丢 |
| 4 | `retrieveL3` 返回 routing_brief（含 narrative_injected） |
| 5 | q_trend 失败 → null 且不抛（fail-open） |
| 6 | injector 有 brief 时输出一行；无 brief 时不输出（向后兼容） |

**回归**：`test/context/`、`test/context-supply-7x7.test.js`、`test/decision/`、`test/e2e-decision-accountability.test.js`。

---

## §C P1 / P2 任务分解（待基线，不实施）

| Task | 内容 | 依赖 |
|---|---|---|
| P1-1 | `crm.routing_experiment` 表（append-only，arm+baseline） | P0 基线 |
| P1-2 | `src/context/routingExperiment.js`（`applyExperimentArm` 纯函数 + `resolveActiveArm` fail-open） | P1-1 |
| P1-3 | 两处装配接入实验臂（V2 + assembler:181），写 `exp_*` 进 routing | P1-2 |
| P1-4 | 聚合 + §7 三取二判据（确定性，无 LLM） | P1-3 |
| P1-5 | 3 个 knob 策略（`routing_tracks`/`routing_weight`/`routing_threshold`）+ 注册 | P1-4 |
| P2-1 | `retro.js` 独立 pass `routingReview()` | P1-5 |
| P2-2 | 挂 `timers.js runRetroOnce`（每日 02:00 + catchUp） | P2-1 |
| P2-3 | 监控台浮卡（可观测实验状态） | P2-1 |

---

## §D 风险与回退

| 风险 | 回退 |
|---|---|
| 快照新增列导致 INSERT 失败（旧库未迁移） | INSERT 在 try 内 → 已持久化失败降级为 `persisted:false`，不阻断决策 |
| q_trend 拖慢装配 | 单条轻量聚合查询 + fail-open null |
| injector 多出一行增加 token | 单行 ≤ 80 字；P0 上线后实测增量 |

## §E 自查

- [x] 无占位符 / TBD
- [x] 未触碰 `config_store['context-routing']`（P0 全期零改写）
- [x] ALTER 独立文件、进 `INCREMENTAL_SQL` 清单
- [x] 阈值（trend_n）配置化 + 出厂兜底
- [x] 禁 DELETE：旧 Q 采样行保留
