# 22 项参数「每夜体检 → 处方 → ADMIN 待办 → my-todo 批准」全面闭环 — 实施计划

> 状态：**已批准**（用户：同意，2026-09-05）· 上游：`docs/2026-09-05-param-closedloop-adaptive-design.md`
> 铁律：每期验证过再进下期；写经第 0 闸；禁 DELETE；`context-routing` 红线保持（只出 PENDING）。

---

## 分期总览

| 期 | 主题 | 关键产物 |
|---|---|---|
| **P0** | 参数巡检器 + 报告段落 + 处方护栏 + 修键名 | `paramInspector.js` / `retro.js` 挂独立 pass / `param_inspection` 列迁移 / `retro-knob-map` 种子 / `prescribe` 接线 / `retro.js:24` 键名修复 |
| **P1** | my-todo「参数调优」视角 + routing-explore 注册 | `workbenchRouter.js` 增 view + 签批 / `my-todo.html` 视角与按钮 / `configCenter.js` 补项 |
| **P2** | 监控台参数体检浮卡 + 测试/文档补齐 | 订阅 `param-inspection` 事件渲染段落 / 端到端验收 |

---

## P0

### P0-1 `db/migration-param-inspection.sql`（新）
```sql
-- 2026-09-05 参数闭环：夜批报告补「参数体检」段（JSONB，旧行兼容空）
ALTER TABLE crm.decision_retro_report ADD COLUMN IF NOT EXISTS param_inspection JSONB;
COMMENT ON COLUMN crm.decision_retro_report.param_inspection IS '22 项算法参数每夜体检结果（health/verdict/suggested/evidence）；空=未跑';
```
注册：`db/migrate.js` `INCREMENTAL_SQL` 追加 `'migration-param-inspection.sql'`。

### P0-2 `db/schema.sql` 补 `retro-knob-map` 种子（power 幂等）
- config 段追加 `retro-knob-map`：`{ knob_map: [ { root_cause_class:'NEED_DIM_ORDER', metric:'dim_missing_rate', healthy_baseline:0.15, direction:'down', sensitivity_k:0.5, sensitivity_slope:0.4, max_step:0.05, min_step:0.01 }, ...] }`
- 全量 7 根因类 × 对应指标；**代码不硬编码**（prescription.js 只消费）→ 兜底：`readExploreConfig` 同款 `readConfig('retro-knob-map')`，缺失回退 `DEFAULT_KNOB_MAP`（保留在 paramInspector，仅出厂）。

### P0-3 `src/calibration/paramInspector.js`（新，核心）
**契约**：
```js
export const PARAM_ITEMS = [ /* 22 项声明（见设计 §3）：{ key, group, param, judge(cur, sample), suggest(cur, sample), floor, ceiling, risk } */ ];
export const DEFAULT_KNOB_MAP = {...};   // retro-knob-map 出厂兜底
export const DEFAULT_INSPECT_CFG = { min_sample:20, cooldown_days:30, window_days:30 };
export async function readInspectCfg({tenantId='system'}={}) {...}   // config_store['param-inspect']，兜底 DEFAULT_INSPECT_CFG，null 陷阱防御
export async function inspectAll({ tenantId='system', windowDays, now, query:q = defaultQuery } = {}) {
  // ① 采样：近窗 decision / particles / calibration_patch 聚合（3 条只读 SQL）
  // ② 逐项：judge(current, sample) → { health, verdict }
  // ③ verdict==='adjust' → suggest(cur, sample) → prescribe({cur,measured,spec,floor,ceiling}) → 目标值
  // ④ 冷却：同键 calibration_patch APPLIED resolved_at 距今<cooldown_days → 跳过
  // ⑤ fail-open：单键异常 emit('trace') + health='unknown'，不阻断
  // ⑥ 返回 { ran_at, inspected:22, items[], patches[] }
}
```
- **判据/走廊**：全部进 `config_store['param-inspect']`（可调），代码仅出厂兜底。
- **null 陷阱**：`Number(null)===0`——读配置字段一律 `!= null` 先排空再判有限（闸门不静默失效）。
- **红线**：对 `context-routing` 的轨道键**跳过**（运行中 A/B 实验不重复出方，白名单），其余维度只 review。

### P0-4 接线
- `retro.js` 新增 `export async function runParamInspectionPass({tenantId='system', dryRun=false}={})`：调 `inspectAll` → `dryRun` 返回不落库；`!dryRun` 时 `savePatchesFromItems`（去重落 `calibration_patch`，同 §16.6）→ 落 `param_inspection` 到当前 report 行 `UPDATE ... SET param_inspection=$1`（追加式，不 DELETE）→ emit('calibration','param-inspection')。异常 emit + recordFailure **不抛**。
- `retro.js:24` `retroTimeoutMs` 改读 `retro-config`（修键名错配）。
- `timers.js` `runRetroOnce` 三段落串联：`LLM 复盘 → 路由收口 → 参数体检`，各自 catch 互不传染（对齐既有 P2 模式）。

### P0-5 测试（新增）
- `test/calibration/paramInspector.test.js`：22 项声明完整；judge/suggest 关键键样本；冷却跳过；fail-open（某键判据抛 → unknown 不阻断）；`retro-knob-map` 兜底；prescribe 护栏（越界夹回 + risk）。
- `test/decision/paramInspectionPass.test.js`：dryRun 不落库；!dryRun 落 report 列 + calibration_patch + SSE；失败 emit 不抛（**禁裸 catch** 断言）。
- `test/scheduler/timers-param.test.js`：三段各自 catch 互不传染（注入失败依赖）。
- 迁移自检：`migration-param-inspection.sql` 跑后列存在、旧行兼容。

**P0 验收**：`vitest run test/calibration/paramInspector.test.js test/decision/paramInspectionPass.test.js test/scheduler/timers-param.test.js` 全绿；`node scripts/... dryRun` 报告含 22 项；迁移幂等重跑。

---

## P1

### P1-1 `workbenchRouter.js` 增「参数调优」视角
- `VIEWS` / `VIEW_ALIASES` 增 `'tuning':'参数调优'`。
- `buildViewRows('tuning')`：查 `calibration_patch status='PENDING' AND (assignee=actor 或 actor 含 ADMIN/SYSADMIN/TAN_ADMIN)`；tan_admin 限本租户。行：`{id, knob, target, from_value, to_value, risk, title}`。
- 新增签批：`/api/my-todo/tune-approve` / `tune-reject`（复用 `store.approvePatch / rejectPatch`，第 0 闸透传）。**零新增写通道**。
- `VIEWS` 顺序：`approval, tuning, processing, initiated, cc, follow`（§5-3 决议：紧随待我审批）。

### P1-2 `my-todo.html`
- 视角 tab 增「参数调优」（对齐既有 tab 渲染）；行内「批准/驳回」按钮（crm-button）、状态/风险徽标。
- api 对齐：`/api/my-todo?view=tuning` + `tune-approve`/`tune-reject`。
- **UI 铁律**：head 三件套、crm-* 控件、ui-lint --strict 0 违规。

### P1-3 `configCenter.js` 补 `routing-explore`
- `CONFIG_ITEMS` 补 `{ id: 43, name:'路由实验（routing-explore）', group:'销售方法论与决策治理', level:'system', status:'ready', page:'/decision-route-config.html', endpoint:'/api/config/routing-explore', ... }`（level='system'；写仍走第 0 闸）。

### P1-4 测试
- `test/http/tuning-view.test.js`：tuning 视角行过滤（角色/租户）；tune-approve/reject 复用第 0 闸；权限（sales 不可见）。
- `test/web/configCenter-extra.test.js`：routing-explore 项存在 + level。

**P1 验收**：`test/http` + `test/web` 相关绿；`/my-todo.html` 手测「参数调优」可见 PENDING 并可批准；`config.html` 可见第 43 项。

---

## P2

### P2-1 监控台「参数体检」浮卡/段落
- `sales-decision-monitor.html` 订阅 `calibration` 域 `param-inspection`（对齐既有 `retro-suggestions` 浮卡范式），渲染 22 项 health 概要 + 处方入口。

### P2-2 端到端验收（真实数据）
- 触发一次真实夜批 `scripts/...`（或 `node src/decision/retro.js` runParamInspectionPass dryRun）→ 验证：报告含 22 项 / verdict 合理 / 待办落库（若有 adjust）/ my-todo 可见 / 批准后 config_store 变更 + decision_id 留痕。
- **无 adjust 时允许 0 待办**（判定为健康=不打扰），但报告必须逐项给出「健康/keep」。

### P2-3 文档/回归
- `docs/2026-09-05-param-closedloop-adaptive-design.md` 补「落地状态」；全量回归聚焦批次（context/calibration/decision/scheduler/http/web）。

**P2 验收**：端到端链路实证一条处方从「夜批 → 待办 → 批准 → config_store 生效」完整闭环；回归绿。

---

## 提交分组（每功能线一 commit）

| 组 | 文件 |
|---|---|
| P0a | `db/migration-param-inspection.sql` + `db/migrate.js` + `db/schema.sql`（种子） |
| P0b | `src/calibration/paramInspector.js` + `src/decision/retro.js` + `src/scheduler/timers.js` |
| P0c | `test/calibration/paramInspector.test.js` + `test/decision/paramInspectionPass.test.js` + `test/scheduler/timers-param.test.js` |
| P1a | `src/http/workbenchRouter.js` + `src/web/my-todo.html` |
| P1b | `src/portal/configCenter.js` + 测试 |
| P2a | `src/web/sales-decision-monitor.html` + 文档 |

---

## 红线自检

- 写操作：仅 `approvePatch` 内 `ConfigStoreStrategy.apply`（事务 + 第 0 闸 + HITL）→ 合规
- `context-routing`：不直接写，只 PENDING 处方（红线保持）
- 禁 DELETE：零 DELETE；`param_inspection` 追加式列
- 假绿防线：处方一律过 `prescribe` 护栏；样本不足不出方；以端到端真实数据验收
- 键名错配（决策复盘超时）与 `routing-explore` 注册同时修复
