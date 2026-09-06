# 判定阈值配置化设计（id32）

> 日期：2026-08-30 ｜ 状态：**已选定方案，进入实施**
> 原则来源：用户明确指令「拜访数量之类的，使用原则：按照后台配置来，不能写硬编码在 SKILL 或者代码里面（客户可以根据需求进行调整）」
> 配套：`docs/2026-08-30-sales-p0-p1-test-plan.md`（测试计划）
> 铁律：SKILL 描述方法论与默认值建议，不承载可调业务数值；代码只从配置读，不写死

---

## §0 原则与范围

### 0.1 核心原则

| 层 | 职责 | 是否承载具体数值 |
|---|---|---|
| **SKILL**（method-*） | 方法论定义、判定逻辑、维度语义、默认建议值 | ❌ 不承载可调数值（仅可标注"建议默认 X，以配置为准"） |
| **config_store** | 客户可调的业务阈值 | ✅ 唯一事实源 |
| **代码**（纯函数） | 读配置 → 判定 | ❌ 只保留"配置缺失时的兜底默认" |

### 0.2 范围

| 纳入 | 不纳入 |
|---|---|
| 13 项业务阈值（见 §1） | `standard_count: 21`（方法论结构常量，客户不可改） |
| 代码改造：统一 `readThreshold()` | AI 属性 confidence（0.7~0.9，属模型置信度非业务阈值） |
| SKILL 数值去硬化 | 漏斗加权值 0.9/0.6/0.3/0（P1 范围，另行处理） |

---

## §1 硬编码清单（13 项 → 配置键）

| # | 配置键 | 现值 | 消费点（file:line） | 域 |
|---|---|---|---|---|
| 1 | `bantcc.pass` | 0.6 | `behaviorChecklist.js:55`、`executor.js:188,195`、`namedAccountBoard.js:46` | 商机 |
| 2 | `bantcc.unknown` | 0.5 | `executor.js:187`、`namedAccountBoard.js:56,57` | 商机 |
| 3 | `behavior.min_customer_types` | 2 | `behaviorChecklist.js:52`（02-01） | 行为 |
| 4 | `behavior.min_contacts` | 2 | `behaviorChecklist.js:61`（04-02） | 行为 |
| 5 | `behavior.recent_visit_days` | 7 | `behaviorChecklist.js:47`、`evaluator.js:173`（01-01） | 行为 |
| 6 | `rhythm.potential_days` | 90 | `behaviorChecklist.js:63`、`evaluator.js:179`（05-02） | 客户 |
| 7 | `rhythm.target_days` | 30 | `behaviorChecklist.js:64`、`evaluator.js:180`（05-03） | 客户 |
| 8 | `stage.stuck_days` | 30 | `evaluator.js:54`、`namedAccountBoard.js:48` | 商机 |
| 9 | `rhythm.adherence_window_days` | 30 | `evaluator.js:124` | 客户 |
| 10 | `gate.p1_p2_min_need_facts` | 2 | `executor.js:170` | 门控 |
| 11 | `ui.behavior_pass_rate_ok` | 80 | `named-accounts.html`、`behavior-standard-config.html` | 前端 |
| 12 | `taoran.achieved_ratio` | 80 | `method-behavior-standard/methodology.json` | SKILL |
| 13 | `rhythm.times`（档位节奏次数） | 目标月1/潜力季1 | `method-funnel-classification/methodology.json` | SKILL |

> #6/#7/#13 与 id30 的 `tiers[].visit_freq` 存在重叠风险：
> id30 配的是「每档应拜访几次 + 窗口类型」，#6/#7 是 21 条判定用的**天数硬值**。
> 处置：**#6/#7 不再独立配置，改为从 id30 的 `window_days` 派生**（`potential_days = window_days.quarter`、`target_days = window_days.month`），
> 消除双源漂移；仅当 id30 缺失时回退 90/30。

---

## §2 配置模型

### 2.1 存储

`config_store['sales-thresholds']`，JSON 结构（按域分组）：

```json
{
  "bantcc": { "pass": 0.6, "unknown": 0.5 },
  "behavior": { "min_customer_types": 2, "min_contacts": 2, "recent_visit_days": 7 },
  "rhythm":  { "adherence_window_days": 30 },
  "stage":   { "stuck_days": 30 },
  "gate":    { "p1_p2_min_need_facts": 2 },
  "ui":      { "behavior_pass_rate_ok": 80 },
  "taoran":  { "achieved_ratio": 80 }
}
```

### 2.2 配置中心入口

新增 `src/portal/configCenter.js` 项：

```js
{ id: 32, name: '判定阈值', group: '销售方法论与决策治理',
  page: '/sales-thresholds-config.html', endpoint: '/api/config/sales-thresholds' }
```

**同步铁律**：新增 CONFIG_ITEMS 须同步 `src/web/config.html` GROUPS + `test/web/configCenter.test.js`（ids 并集 + 卡片断言）。

### 2.3 读取层（新模块）

`src/sales/salesThresholds.js`：

```js
export const DEFAULT_THRESHOLDS = { ... };          // 兜底默认（与现值一致，保证向后兼容）
export function readThreshold(cfg, path, fallback); // 点路径读取，缺失回退
export function mergedThresholds(cfg);              // 铺底 + 覆写
export function deriveRhythmDays(targetsCfg, thresholds); // 从 id30 window_days 派生
```

**向后兼容**：所有消费方在未传配置时使用 `DEFAULT_THRESHOLDS`，行为与改造前完全一致（保证既有测试不因缺配置而失败）。

---

## §3 代码改造

### 3.1 函数签名扩展

| 函数 | 改动 |
|---|---|
| `evaluateBehaviorChecklist(payload, deals, contacts, thresholds)` | 新增第 4 参，默认 `DEFAULT_THRESHOLDS` |
| `deterministicEval(type, payload, def)` | 新增 `opts.thresholds`（def 上透传，避免改签名影响既有调用） |
| `salesStageGate({curStage,toStage,dealPayload,thresholds})` | 新增 `thresholds` |
| `accountRow(account, deals, contracts, targetsCfg, contacts, thresholds)` | 新增第 6 参 |
| `boardSummary(..., behaviorStd, thresholds)` | 新增第 8 参 |

**原则**：新增参数一律**追加在末尾 + 默认值兜底**，避免破坏既有调用点。

### 3.2 端点注入

`GET /api/board/named-accounts` 路由：读取 `config_store['sales-thresholds']` 并注入 `boardSummary` / `accountRow`。

### 3.3 BANTCC 三处归一

`behaviorChecklist.js:55`、`executor.js:188`、`namedAccountBoard.js:46` 统一走 `readThreshold(cfg,'bantcc.pass')`，
**消除"三处各写一遍"**（当前最大隐患：改一处漏两处会导致 21 条判达标、门控判不达标）。

---

## §4 SKILL 改造

### 4.1 `method-behavior-standard/methodology.json`

- `taoran` 的 A 要素：`"desc":"是否达标（≥80%/部分/未达）"` → 改为
  `"desc":"是否达标（达成比例分档，阈值见配置 sales-thresholds.taoran.achieved_ratio，默认 80%）"`
- `standard_count: 21` **保留**（结构常量）
- 新增 `thresholds_ref` 字段，声明本 SKILL 消费哪些配置键

### 4.2 `method-funnel-classification/methodology.json`

- `rhythm_note: "每月 ≥1 次"` → `"每月 ≥1 次（次数以配置中心 id30 每档拜访频率为准，此为默认建议）"`
- `rhythm: "monthly"/"quarterly"` **保留**（枚举语义，非数值）

### 4.3 通用规则

SKILL 内允许出现数值的**唯一情形**：标注为「默认建议值」并显式注明对应配置键。

---

## §5 测试计划（TDD）

| # | 用例 |
|---|---|
| T11-C1 | `readThreshold` 读配置值优先于默认 |
| T11-C2 | `readThreshold` 配置缺失回退默认 |
| T11-C3 | `mergedThresholds` 铺底 + 覆写 |
| T11-C4 | `deriveRhythmDays` 从 id30 window_days 派生（quarter=90、month=30） |
| T11-C5 | id30 缺失时 `deriveRhythmDays` 回退 90/30 |
| T11-C6 | 21 条 03-01 随 `bantcc.pass` 配置变化（0.6 → 0.8 时 0.7 分商机由达标变不达标） |
| T11-C7 | P3→P4 门控随 `bantcc.pass` 配置变化，且与 21 条判定**同源**（改一处两边同时生效） |
| T11-C8 | 04-02 随 `min_contacts` 配置变化 |
| T11-C9 | 01-01 随 `recent_visit_days` 配置变化 |
| T11-C10 | 05-02/05-03 随派生天数变化 |
| T11-C11 | 未传配置时行为与改造前一致（向后兼容回归） |
| T11-C12 | configCenter CONFIG_ITEMS 含 id 32，且 config.html GROUPS 同步 |
| T11-C13 | 端点 `GET/PUT /api/config/sales-thresholds` 读写 + 决策第 0 闸 + admin 闸 |

---

## §6 Task 拆分

| # | Task | 交付 |
|---|---|---|
| T11 | 阈值模块 + 测试 | `src/sales/salesThresholds.js` + `test/sales/salesThresholds.test.js` |
| T12 | 消费方改造 + 测试 | 三处 BANTCC 归一 + 各纯函数签名扩展 |
| T13 | 配置中心 id32 + 端点 | `salesThresholdsRouter.js` + configCenter + config.html + 配置页 |
| T14 | SKILL 去硬化 | 两个 methodology.json 数值改引用 |
| T15 | 端点注入 + 回归 | 看板端点注入 + 全量回归 |

每 Task 一 commit（AI 不代提交）。

---

## §7 风险

| 风险 | 处置 |
|---|---|
| 新增参数破坏既有调用 | 一律追加末尾 + 默认兜底，未传时行为不变 |
| id30 与 id32 节奏天数双源漂移 | #6/#7 改为从 id30 `window_days` 派生，不独立配置 |
| 配置被误改成极端值（如 pass=0） | 端点校验范围（0~1、天数 >0），越界 400 |
