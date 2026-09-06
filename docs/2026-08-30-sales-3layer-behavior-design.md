# 行为管理三层模型与 L1 量化目标落地设计（v1，2026-08-30）

> 背景：用户指出「销售个人行为量化目标」是独立一层，与 21 条行为合格线（有/无判定）不可混。
> 此前建模把 L1 压成脚注、且 4 个量化目标只前台消费 1 个，属"应付"。本文定稿三层边界 + L1 实际值口径。

## 0. 三层模型（front / back 严格分区）

| 层 | 名称 | 粒度 | 【后台】定义 | 【前台】调用/感知 | 业务影响 |
|---|---|---|---|---|---|
| **L1** | 销售个人行为量化目标 | 个人 | `config_store['behavior-standard']`；`DEFAULTS`(behaviorStandard.js:34) 每天拜访2/每周拜访客户8/每周新客户5/每天电话10；`mergedBehaviorStd` 铺底；`PUT /api/config/behavior-standard` 仅收量化键，写经决策第0闸+admin | `behavior-standard-config.html` 一、可改；`named-accounts.html` L1 KPI；`sales-behavior-board.html` 个人看板 | 个人行为 KPI 标杆，驱动"实际 vs 目标"对比 |
| **L2** | 21 条行为合格线 | 拜访质量 | `STANDARDS` 静态事实源(skills/method-behavior-standard)；`evaluateBehaviorChecklist`→`{pass,total:21,gaps}`；不可编辑（priority_rule 有/无判定不设阈值） | `behavior-standard-config.html` 二、只读；`named-accounts.html` 「21条合格率」列 | 拜访质量合格线 |
| **L3** | 6 项客户分档/目标指标 | 客户档位 | `config_store['named-account-targets']`；①②③④可改，⑤⑥引擎硬编码(namedAccountTargets.js) | `named-account-targets.html`(①②③④改)；`account-360` target-card；`named-accounts` 档位/达标列 | 客户跟进节奏（潜力季1/目标月1） |

**易混口径铁律**：
- L1「每天拜访次数」= **销售个人**日行为总量 KPI（看人）。
- L3-②「每档拜访频率」= 某**客户档位**应多久被拜访几次（看客户）。
- 命名都含"拜访次数"，看板必须标注来源（个人行为 vs 客户档位）。

**21 条不含量化的铁证**：`method-behavior-standard/methodology.json:23` `priority_rule: "21 条是合格线（有/无判定），不设评分阈值"` —— SKILL 本就把量化目标留给 L1。

## 1. L1 实际值口径（消除"应付"的关键）

数据现状（已读代码核实）：
- 拜访记录 = `account.payload.visit_notes[]`，当前仅 `{at, t_objective, t_result, t_next}`，**无 type 字段**。
- 账户创建时间 = `particles.created_at`（queryParticles 为 `SELECT *`，可用）。
- `visit_notes` 当前**无生产写入路径**（仅 seed 演示数据），故 L1 实际值来自真实 visit_notes / created_at，无则诚实为 0。

### 1.1 扩展 visit_notes 契约（向后兼容）
每个拜访记录项允许可选字段：
```
{ at, t_objective, t_result, t_next, type?: 'visit' | 'call' }
```
- `type` 缺省 = `'visit'`（旧数据/未标注均按拜访计）。
- `type:'call'` = 电话量来源。**仅扩展读取口径，不强制改写入**（无写入路径）；seed 演示补少量 call 记录以验证链路。

### 1.2 四个实际值算法（纯函数，落 boardSummary）
| 目标 | 实际值算法 | 数据源 |
|---|---|---|
| 每天拜访次数 `daily_visit_count` | `todayVisits` = 今日 `type≠'call'` 的 visit_notes 计数 | visit_notes.at |
| 每天电话量 `daily_call_count` | `todayCalls` = 今日 `type==='call'` 计数 | visit_notes.at+type |
| 每周拜访客户数 `weekly_visit_customer` | `weekVisitCustomers` = 近 7 天有任一 visit_notes（type 不限）的**去重账户数** | visit_notes.at + account.id |
| 每周新客户数 `weekly_new_customer` | `weekNewCustomers` = `created_at` 在近 7 天的账户数（owner 过滤后） | particles.created_at |

窗口语义对齐 `window_days`：`today`=本地0点；`近7天`=含今日滚动7天；`近30天`=滚动30天。

## 2. ④ 接通引擎
- `namedAccountTargets.js` 新增 `METRIC_LABELS = {visit:'拜访记录', lead:'线索阶段', deal:'非线索商机', contract:'合同'}` + 纯函数 `metricDimensions(targets)` → 读 `mergedTargets(targets).metrics` 返回 `[{code,label}]`。
- `behavior-standard-config.html` ④ 行改为读 `metricDimensions(targets)` 渲染标签（替当前硬编码串 `:110`）。
- `account-360` 端点 `target-card` 数据注入 `metrics: metricDimensions(targetsCfg)`（真正被消费，非仅存储）。

## 3. ⑤⑥ 前台实时展示
- `behavior-standard-config.html` 三、拆为 **A. 后台可配置项（①②③④）** / **B. 引擎规则·前台展示（⑤⑥）**。
- B 拉 `GET /api/board/named-accounts` 取首 1~2 行真实数据，渲染：
  - ⑤ 达标判定实例：「客户X 近30天拜访 N ≥ 目标 M → 达标/缺口」
  - ⑥ 档位归属实例：「客户Y tier=目标 → 目标档；无 tier → 潜力（末档）」
- 数据驱动，非静态文字。

## 4. 前台双入口（A+B）
- **A. 客户跟踪看板补 L1 KPI**（`named-accounts.html` 列表 TAB 顶部）：今日拜访/目标、今日电话/目标、本周拜访客户/目标、本周新客户/目标，标注「个人行为」来源。
- **B. 新增销售个人行为看板**（`sales-behavior-board.html`）：今日/本周/本月 vs 4 目标，actual vs target + pass/warn；菜单「销售」组加入口；routes.js sendFile 路由；复用 `/api/board/named-accounts?owner=me`。

## 5. 实现清单（每 Task 一 commit，由用户本地提交）
1. `src/sales/namedAccountBoard.js` — boardSummary 扩展 L1 实际值（T19）
2. `src/sales/namedAccountTargets.js` — METRIC_LABELS + metricDimensions（T20）
3. `src/http/routes.js` — account-360 target-card 注入 metrics；sendFile `/sales-behavior-board.html`（T20/T23）
4. `src/web/behavior-standard-config.html` — ④读config + ⑤⑥拆A/B实时实例（T20/T21）
5. `src/web/named-accounts.html` — L1 四 KPI（T22）
6. `src/web/sales-behavior-board.html`（新）+ `src/portal/layoutMenu.js` 菜单（T23）
7. `test/sales-named-accounts/named-account-board.test.js` — L1 实际值用例
8. `test/sales/namedAccountTargets.test.js`（新）— metricDimensions
9. `test/web/layout.test.js` / `test/web/configCenter.test.js` — 菜单项
10. `scripts/seed-named-accounts-demo.mjs` — 补少量 `type:'call'` 记录验证链路（可选）

## 6. 验收
- 单测：boardSummary L1 四实际值 + metricDimensions + 菜单项全绿。
- live：`GET /api/board/named-accounts` summary 含 `todayVisits/todayCalls/weekVisitCustomers/weekNewCustomers` + 四目标；
  `sales-behavior-board.html` 渲染 4 目标实际vs目标；`behavior-standard-config.html` ④读config、⑤⑥显示实时实例。
- 铁律：visit_notes.type 缺省='visit'（旧数据不崩）；created_at 来自 particles；不虚构数据源。
