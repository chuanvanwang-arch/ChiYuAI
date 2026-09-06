# S20 七维设计配置页改造：对齐蓝图「场景×七维矩阵」

- 日期：2026-08-28
- 状态：设计已评审通过（用户选「A」= 对齐蓝图），待进入 writing-plans
- 关联：`docs/2026-08-26-frontend-config-pages-master-blueprint.md` §2.4（L147-156）+ S20 段（L339-368）

---

## §0 背景与问题

七维（`identity/structure/semantics/time_config/decision_history/operational_state/governance`）是**决策上下文的「齐全轴」**（源 Oleg Shilovitsky / OpenBOM 产品情境七维度），与 L1–L4「深度轴」正交。其运行时语义是**布尔存在性校验，不是打分**（`src/sevenDimensions/engine.js:10`）：

```js
// engine.js:22-29（节选）
const val = ctx?.[dim];
if (val == null || val === '' || (Array.isArray(val) && val.length === 0)) {
  missing.push({ dim, on_missing: ... });
}
```

即：**只判断上下文里有没有这个维度**，缺失则按 `on_missing` 决定 `warn`（打标、禁 AI 脑补）或 `block`（拒写、`missing_context`）。

### 三个已核实的问题

| # | 问题 | 证据 |
|---|---|---|
| 1 | **七维闸门从未生效**。全部 10 个场景 `required_dims = []`，`sevenDimensionsCheck` 恒返回 `{missing:[], level:'ok', allowed:true}` | 实测 DB 查询；`engine.js:31-36` |
| 2 | **S20 页面形状与蓝图契约不符**。蓝图要求「场景×七维矩阵」（每格 `{required, on_missing}`），实际存的是单个全局对象、7 个 0–5 分数 | `src/portal/sevenDimRender.js`、`src/web/seven-dim.html` vs 蓝图 L352-366 |
| 3 | **那 7 个 0–5 数无任何运行时消费方**。唯一使用者是 `sevenDimConfigCheck`（`engine.js:43`），只校验「7 维齐全且各在 0–5」，属配置完整性自评，不参与任何写闸门 | 全仓 grep：`seven-dim` 仅出现于 `routes.js:95`、`S20.schema.js` 注释 |

**结论**：改造后七维闸门将是**首次真正启用**，因此默认值与严格度策略直接决定风险敞口。

### 当前场景清单（实测）

| stage | scenario_id | default_tier | autonomous_allowed |
|---|---|---|---|
| 一、线索 | `LEAD_FOLLOW_UP` | LEAD | true |
| 二、机会评估 | `OPP_QUALIFY` | NORMAL | false |
| 三、客户策略 | `CLIENT_STRATEGY` | NORMAL | false |
| 四、方案价值 | `SOLUTION_VALUE` | NORMAL | false |
| 五、商务报价 | `QUOTE_PRICING` | HIGH | false |
| 六、签单前风险 | `SIGN_RISK` | HIGH | false |
| 七、终局决策 | `POST_CONTRACT` | NORMAL | true |
| 八、丢单复盘 | `LOSS_REVIEW` | LEAD | true |
| meta | `ATTR_SCHEMA_CHANGE` | HIGH | false |
| contract | `SC_DEMO_DISCOUNT` | NORMAL | false |
| payment | `SC_DEMO_TERMS` | HIGH | false |

> **7×7 的由来**：7 个业务阶段（一~七）**每个恰好挂 1 个场景**，故矩阵视觉上是 **7 行（阶段）× 7 列（维度）**。另有 **八、丢单复盘 `LOSS_REVIEW`** 作为终局决策的「丢单/孵化/放弃」子情形补充场景（与主 7×7 并列但不计入主矩阵），以及 meta/contract/payment 3 个非业务阶段场景。

---

## §1 目标与范围

**目标**：让 S20 成为蓝图规定的「决策场景级上下文完整性校验」配置面，写入 `decision_scenario.required_dims`，使 `sevenDimensionsCheck` 首次真正生效，并可由管理员逐格调节严格度。

**范围内**
- S20 页面（`src/web/seven-dim.html` + `src/portal/sevenDimRender.js`）
- S20 端点（`GET/PUT /api/config/seven-dim`）
- `decisionScenario.js` 增加 `required_dims` 编辑能力（校验 + COL_CAST）
- 预置种子脚本（幂等）
- 测试（含 parity 守卫）

**范围外**
- 不修改 `engine.js` 的校验语义（已正确）
- 不修改 S06/S07 消费侧
- 不调整 `eval_dimensions`（那是自主性打分维度 `{cond,label,weight}`，与七维是两套东西，勿混淆）

---

## §2 数据模型

| 落点 | 形状 | 说明 |
|---|---|---|
| `decision_scenario.required_dims` | `[{dim, on_missing}]` | 引擎契约：**出现在数组内即 required**；`on_missing` ∈ `warn`｜`block`，缺省 `warn`（`engine.js:23,27`） |
| `config_store['seven-dim']` | `{default_strictness: 'warn'}` | 全局默认严格度（蓝图 `default_strictness`，L360-362） |
| 维度键唯一源 | `src/sevenDimensions/constants.js` `SEVEN_DIMS` / `DIM_KEYS` | **禁止另写维表**；由 parity 测试锁死 |

`required_dims` 列已存在（`db/migrate-config.sql:82`，`JSONB NOT NULL DEFAULT '[]'`），无需新增迁移。

---

## §3 端点契约（独立端点 + 复用内核）

### 决策依据

保留蓝图规定的 `GET/PUT /api/config/seven-dim`（配置中心约定），但**复用 `decisionScenario.js` 的校验、决策与写库内核**，避免 `decision_scenario` 出现两条写路径导致校验口径漂移。

### `GET /api/config/seven-dim`

```json
{
  "dims": [{ "key": "identity", "label": "身份", "desc": "..." }, "...共 7 项"],
  "scenarios": [
    { "scenario_id": "QUOTE_PRICING", "stage": "四、商务报价",
      "default_tier": "HIGH", "required_dims": [{ "dim": "identity", "on_missing": "warn" }] }
  ],
  "default_strictness": "warn"
}
```

### `PUT /api/config/seven-dim`

两种互斥 body：

1. **单场景矩阵更新**：`{ scenario_id, required_dims }`
2. **全局默认**：`{ default_strictness }`

校验规则：
- `required_dims` 必须是数组，每项 `{dim, on_missing}`
- `dim` ∈ `DIM_KEYS`，否则 **400**
- `on_missing` ∈ `warn`｜`block`，否则 **400**
- 同一 `dim` 重复出现 → **400**
- 未知 `scenario_id` → **404**（复用 `updateScenario` 返回空行的既有行为）

写路径（复用内核）：
1. `validateScenarioPatch({ required_dims })`——`required_dims` 加入 `EDITABLE_FIELDS`
2. `produceDecision`——复用 `decisionScenario.js:127-136` 的 `config_change` 事件（**第0闸**：每条写携带 decision_id）
3. `updateScenario`——复用 `decisionScenario.js:108-126`，`COL_CAST` 补 `required_dims: 'jsonb'`

权限：**`sysadmin`**（用户明确维持，不按蓝图 L99 放宽为 manager 编辑 / presales 只读）。

---

## §4 页面设计

- **顶部**：全局默认严格度 select（`warn` / `block`）→ `default_strictness`
- **主体**：矩阵表
  - 行 = 场景，按 `stage` 排序；列 = 7 维
  - 每格三态：未要求 `—` / `warn` / `block`，用 select 切换
  - 场景行标注 `stage` + `default_tier` + 自主标记，便于对照
- **空态**：仍渲染表格（延续 2026-08-28 修复的「空态必须可操作」约定），不得只显示占位符
- **保存**：逐行保存（PUT 单场景），全局默认单独保存

> **渲染约束（易踩坑）**：`/sevenDimensions/*` **未被静态托管**，浏览器端 `sevenDimRender.js` **禁止 import `constants.js`**（会 404 并导致整页脚本不执行）。维度定义一律由 `GET /api/config/seven-dim` 的 `dims` 字段下发，页面据此渲染列。
> `validateRequiredDimsPatch` 在本地保留 `SEVEN_KEYS` 做校验，与服务端 `DIM_KEYS` 的一致性由 **parity 测试**守卫（§7）——二者若漂移，CI 即失败。

---

## §5 预置矩阵（显式，全部 `warn` 起步）

### 为什么不用 tier 推导

初步方案按 `default_tier` 推导（LEAD→2 维 / NORMAL→4 / HIGH→6）。**该推导存在语义反例**：`LOSS_REVIEW`（七、丢单复盘）是 LEAD tier，会被推导出仅「身份+结构」2 维，但**复盘场景最需要的恰恰是 `decision_history`（决策历史）**。

> **预置表与 7×7 的关系**：tier 预置表是「推导规则（输入）」，7×7 是「落到每场景×每维的结果（输出）」。因只有 7 行且存在上述语义反例，**改为直接书写显式的 7 阶段 × 7 维矩阵**，`default_tier` 仅作参考展示。

### 显式预置（`on_missing` 全为 `warn`）

| 阶段 / 场景 | 身份 | 结构 | 语义 | 时间 | 决策史 | 运行态 | 治理 | 维数 |
|---|---|---|---|---|---|---|---|---|
| 一、线索 `LEAD_FOLLOW_UP` | warn | —（弱） | warn | warn | —（弱） | warn | warn | 5 |
| 二、机会评估 `OPP_QUALIFY` | warn | warn | warn | warn | warn | warn | warn | 7 |
| 三、客户策略 `CLIENT_STRATEGY`（新） | warn | warn | warn | warn | warn | warn | warn | 7 |
| 四、方案价值 `SOLUTION_VALUE` | warn | warn | warn | warn | warn | warn | warn | 7 |
| 五、商务报价 `QUOTE_PRICING` | warn | —（弱） | warn | warn | warn | warn | warn | 6 |
| 六、签单前风险 `SIGN_RISK` | warn | warn | warn | warn | warn | warn | warn | 7 |
| 七、终局决策 `POST_CONTRACT` | warn | warn | warn | warn | warn | warn | warn | 7 |
| 八、丢单复盘 `LOSS_REVIEW`（补充） | warn | warn | warn | warn | warn | warn | warn | 7 |

**逐行理由（依据领域 7 类决策框架）**
- **线索**（5 维）：必须识别客户实体（身份）、解读留资语义（语义——"高意向"字面≠真实意向）、核对采购时间窗与信号时效（时间）、探测业务变动（运行态）、套用线索准入规则（治理）；结构/决策史为弱依赖（线索阶段关系未建立、历史少），不强制。
- **机会评估**（全 7 维，MEDDICC）：任一缺失即可能把伪机会/陪标升级为真机会。
- **客户策略**（全 7 维，新场景）：识别每关键人实体（身份）、决策链图谱（结构）、读懂表态真实语义（语义）、人员时效（时间）、历史立场（决策史）、当下内部博弈（运行态）、角色权限治理（治理）。
- **方案价值**（全 7 维）：含运行态——客户当下业务现实约束。
- **商务报价**（6 维）：结构标注"次要"作弱依赖；其余 6 维必填（含历史成交/折扣区间=决策史、客户商务话术语义=语义、信用主体=身份）。
- **签单前风险**（全 7 维）：风险校验场景，主体真实性（身份）、权力结构（结构）、条款语义（语义）、项目版本（时间）、历史烂尾（决策史）、经营状态（运行态）、法务交付红线（治理）。
- **终局决策**（全 7 维）：交付变更/回款/续约/丢单孵化放弃，须识别继任实体（身份）、新架构（结构）、反馈语义（语义）、续约窗口（时间）、历史丢单（决策史）、当下动态（运行态）、续约政策（治理）。
- **丢单复盘**（全 7 维，补充场景）：终局决策的「丢单/孵化/放弃」子情形，与主 7×7 并列。

**非业务 3 场景**（`ATTR_SCHEMA_CHANGE` / `SC_DEMO_DISCOUNT` / `SC_DEMO_TERMS`）：默认 `身份 + 结构 + 治理`（保守基线，3 维）。

**种子幂等**：仅对 `required_dims = '[]'::jsonb` 的行写入，非空行跳过（管理员已配置的不得被覆盖）。

---

## §6 迁移与清理

| 项 | 处理 |
|---|---|
| `config_store['seven-dim']` 旧 0–5 值 | 覆盖为 `{default_strictness:'warn'}`；旧键丢弃（无消费方、非蓝图契约） |
| `sevenDimConfigCheck`（`engine.js:43`） | **删除**——为旧 0–5 形状所造，改造后无调用方 |
| `routes.js:95` | `/api/config/seven-dim` 从 `createConfigRouter` 换为新的矩阵路由（**改 routes 需重启 server**） |
| `test/http/configRouter.test.js` | 移除针对 `sevenDimConfigCheck` 的 3 条断言（缺维→422 / 越界→422 / 全 0-5→200） |
| `src/pages/S20.schema.js` | 同步为矩阵形态（`columns` 已含 7 维 + strictness，需补 `required_dims` 语义与 `dataBinding` 落点） |

---

## §7 测试计划

| 文件 | 覆盖 |
|---|---|
| `test/portal/sevenDimRender.test.js`（改） | 矩阵渲染、三态校验、**`SEVEN_KEYS` 与 `DIM_KEYS` parity**（保留，防维表漂移）、空态仍渲染表格 |
| `test/http/sevenDimRouter.test.js`（新） | GET 返回形状；非法 dim→400；非法 on_missing→400；重复 dim→400；未知 scenario→404；第0闸携带 decision；非 sysadmin→403 |
| `test/sevenDimensions/engine.test.js`（增） | 预置后 `warn` 不阻断（`allowed:true, level:'warn'`）；升 `block` 后 `allowed:false` |
| `test/portal/decisionScenario.test.js`（改） | `required_dims` 进入 `EDITABLE_FIELDS`；`validateScenarioPatch` 接受/拒绝；`COL_CAST` 含 `required_dims:'jsonb'` |
| 回归 | 全量 |

---

## §8 风险与验收

**风险**
1. **行为变化**：启用后缺失维会被打 `missing_context` 标记，S06/S07 会"标红"。**这是预期效果，不是故障**。
2. **不阻断**：预置全为 `warn`，既有业务写**零中断**；`block` 需管理员显式升级。
3. **routes 改动需重启 server**（`routes.js` 启动时加载）。

**验收口径**
- `GET /api/config/seven-dim` 返回 7 维定义 + 10 个场景矩阵 + `default_strictness`
- 页面以 sysadmin 登录可见并编辑矩阵；非 sysadmin → 403
- 预置执行后，`sevenDimensionsCheck('QUOTE_PRICING', {})` 返回 `level:'warn'`（7 维全缺但不阻断）
- 将 `identity` 升为 `block` 后，`sevenDimensionsCheck('QUOTE_PRICING', {})` 返回 `allowed:false`
- 每次 PUT 均产生 `config_change` 决策事件（第0闸）

---

## §9 实施步骤（供 writing-plans）

1. `decisionScenario.js`：`required_dims` 加入 `EDITABLE_FIELDS` + `validateScenarioPatch` 分支 + `COL_CAST`
2. 新建 `src/http/sevenDimRouter.js`：`GET/PUT /api/config/seven-dim`，复用 `decisionScenario.js` 内核
3. `routes.js:95` 换挂载；删除 `sevenDimConfigCheck` 及 `engine.js` 中对应函数
4. `src/portal/sevenDimRender.js` 重写为矩阵渲染 + `validateRequiredDimsPatch`
5. `src/web/seven-dim.html` 改为矩阵页
6. `src/pages/S20.schema.js` 同步
7. 种子脚本（幂等，仅填 `required_dims='[]'` 的行）
8. 测试：改 2 个、新建 2 个；跑全量回归

---

## §10 未决项

无。权限口径已由用户明确为 `sysadmin`；预置矩阵已显式定义。
