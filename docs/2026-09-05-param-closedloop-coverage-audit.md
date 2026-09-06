# 算法/参数配置 — 闭环监控与夜批覆盖审计报告

> 审计时间：2026-09-05 · 审计对象：后台全部「算法/参数」类配置
> 审计问题：① 是否纳入闭环监控 ② 是否纳入每日夜间智能体运行 ③ 报告是否覆盖所有参数并给出调整建议 ④ 是否每夜生成 ADMIN 待办且可在 `/my-todo.html` 批准
> 证据标准：源码 file:line 锚点 + 生产库 `crm_native` 实测数据（非文档自述）

---

## §0 结论摘要（先说硬事实）

| 维度 | 结论 | 实测证据 |
|---|---|---|
| **回答用户四问** | **四问全部为「否 / 严重不足」** | 见 §1–§4 |
| 算法/参数配置总数 | **22 项核心**（另有 8 项运行参数） | §1 全表 |
| 纳入「闭环监控」 | **8/22**（36%）——且全部只是「被业务告警消费」，**无一项评估参数本身是否合理** | §1 C 列 |
| 纳入「每夜智能体运行」 | **1/22**（5%）——仅 `context-routing`，且只做 narrative 单个轨道的 A/B | `src/decision/routingReview.js` |
| 能自动出调整建议 | **1/22** | `routingReview.js` 出 PENDING 处方 |
| 能出 ADMIN 待办 | **1/22，实际产出 0 条** | **`crm.calibration_patch` = 0 行**（§3.1 实测） |
| 待办可在 `/my-todo.html` 批准 | **否** | 该页五视角全为业务审批，无参数处方（§2.2） |

> **一句话**：夜批每晚在跑（已跑 4 次），但它**只复盘「决策质量」这一个面**，与后台 22 项算法参数几乎不相干；
> 即便产出了处方，也因**入口断裂**而无法在「我的审批」里批准——`calibration_patch` 至今 0 行。

---

## §1 配置全景覆盖矩阵（22 项算法/参数）

判定列说明：
- **C 闭环监控** = 是否有定时/写时回路持续观测（✅ 有且评估参数本身 / ⚠️ 仅被消费方读取出业务告警 / ❌ 无）
- **N 夜批覆盖** = 每日 02:00 智能体是否扫描并评估它
- **S 调整建议** = 是否能自动产出「该参数应调为 X」的处方
- **T 出待办** = 是否落 `calibration_patch` 供 ADMIN 批准

| # | 配置键（配置中心 id） | 参数性质 | C | N | S | T |
|---|---|---|---|---|---|---|
| 1 | `sales-thresholds`（id32） | BANTCC 达标线/接触窗口/阶段停留/合格率着色线 | ⚠️ | ❌ | ❌ | ❌ |
| 2 | `context-routing`（id36） | 场景路由 tracks + 维度权重 + graph/story 阈值 | ⚠️ | ✅ | ✅ | ✅ |
| 3 | `precedent-conf`（id38） | 先例四分量权重 + minSimilarity | ⚠️ | ⚠️ | ❌ | ❌ |
| 4 | `rubric-thresholds` | 九尺子及格线 | ❌ | ❌ | ❌ | ❌ |
| 5 | `rubric-weights` | 九尺子权重 | ❌ | ❌ | ❌ | ❌ |
| 6 | `rubric-llm` | 尺子 LLM 开关 | ❌ | ❌ | ❌ | ❌ |
| 7 | `autonomy-conf` | 自主放行置信度阈值（≥0.8） | ❌ | ❌ | ❌ | ❌ |
| 8 | `approval-config`（id34） | R1-R4 规则/金额档位/角色链 | ❌ | ❌ | ❌ | ❌ |
| 9 | `behavior-standard`（id31） | 拜访/新客量化目标 | ❌ | ❌ | ❌ | ❌ |
| 10 | `named-account-targets`（id30） | tier × 频率 × 窗口 | ⚠️ | ❌ | ❌ | ❌ |
| 11 | `alert-rules`（id21） | 6 类预警规则阈值 | ⚠️ | ❌ | ❌ | ❌ |
| 12 | `pool-config`（id20） | pick 规则 / recycle 天数 | ❌ | ❌ | ❌ | ❌ |
| 13 | `finance-receivables`（id29） | 逾期天数/差额阈值/账龄分档 | ❌ | ❌ | ❌ | ❌ |
| 14 | `event-retro`（id35） | 触发下限分级/冷却窗小时数 | ❌ | ❌ | ❌ | ❌ |
| 15 | `agent-event-trigger`（id39） | 派发矩阵/三级防风暴冷却 | ❌ | ❌ | ❌ | ❌ |
| 16 | `seven-dim`（id15） | 七维评估 0–5 | ❌ | ❌ | ❌ | ❌ |
| 17 | `business-tier`（id18） | 分级矩阵 → 自主边界 | ❌ | ❌ | ❌ | ❌ |
| 18 | `llm`（id11） | provider / model / temperature | ❌ | ❌ | ❌ | ❌ |
| 19 | `hindsight-deviation` | 后见偏差校验阈值 | ⚠️ | ❌ | ❌ | ❌ |
| 20 | `decision-context-guard` | 上下文守卫阈值 | ⚠️ | ❌ | ❌ | ❌ |
| 21 | `billing-plans` | 套餐闸门（席位/Token/权益） | ⚠️ | ❌ | ❌ | ❌ |
| 22 | `routing-explore`（新，未注册） | A/B 实验窗口/黑名单/样本量 | ❌ | N/A | ❌ | ❌ |

**汇总**：C ✅ 0 / ⚠️ 8 / ❌ 14　·　N ✅ 1 / ⚠️ 1 / ❌ 20　·　S ✅ 1 / ❌ 21　·　T ✅ 1（实际 0 条）/ ❌ 21

> ⚠️ 关键辨析：8 项「⚠️ 闭环监控」全部是**消费方读取该参数去出业务告警**
> （如 `sales-thresholds` 被 30 分钟巡检消费 → 出「商机逾期」告警）。
> **没有任何一项回路去回答「这个阈值定得合不合理」**——即「参数的自适应」是空白。

---

## §2 五大断裂点（代码级锚点）

### 断裂点 1（P0）— 夜批从不产生待办

`src/decision/retro.js:331` 只把 `knob === 'config_store'` 的草稿推成待办：

```js
for (const p of draftPatches.filter((x) => x.knob === 'config_store')) {
```

而 `draft_patches` 的 `knob` 由 LLM 自由输出（`retro.js:225`，仅过滤 `p.knob && p.to_value != null`），
**没有任何机制约束 LLM 必须输出 `config_store`**。
实测：夜批已跑 4 次，`crm.calibration_patch` **0 行**（§3.1）。
→ 「每夜生成待办」这条链路**从未真正跑通过**。

### 断裂点 2（P0）— 待办无处可批，`/my-todo.html` 里根本没有

- `/api/admin/todos`（`src/http/calibrationRouter.js:282`）返回 `calibration_patch` PENDING → **零前端消费**
  （`grep -rn "admin/todos" src/web/ src/portal/` → 空）
- 唯一批准入口藏在监控大页：`src/web/sales-decision-monitor.html:2419`
  （`post('/api/calibration/patches/${id}/approve')`，L3 校准区）
- `/my-todo.html` 走 `/api/my-todo`（`src/http/workbenchRouter.js:184`），五视角为
  `approval / processing / initiated / cc / follow`（`workbenchRouter.js:23-29`），
  数据源全是 `CRM_APPROVAL_TASK` / `CRM_APPROVAL_INSTANCE` / kanban / 业务粒子——**无参数处方**。

→ 用户要求「在 /my-todo.html 我的审批里批准」**当前完全不成立**。

### 断裂点 3（P0）— 定量处方引擎未接线

`src/decision/prescription.js` 提供 `prescribe()` / `findKnobSpec()`（含 `max_step`/`min_step`/`sensitivity_k` 护栏），
但 **全仓零 import**（`grep -rn "prescription" src/ --include=*.js | grep import` → 空）。
其驱动配置 `config_store['retro-knob-map']`：

- 无任何代码 `readConfig('retro-knob-map')`
- 生产库无该键（§3.1，16 键清单中不存在）

→ 护栏（单步上限/最小步长/灵敏度）**形同虚设**，LLM 想调多少调多少。
（注：`docs/2026-09-05-param-hub-implementation-audit.md` §2 A7 标记「✅」的依据是 `prescription.test.js` 单测绿——**单测绿 ≠ 已接线**，典型假绿。）

### 断裂点 4（P1）— 报告只覆盖「决策质量」，不覆盖参数面

`retro.js` 的观测面：

- 数据源：`crm.decision` 决策记录，按 `scenario_id` 聚类
- 指标槽位（§12.1，`retro.js:131-149`）仅 5 个：
  `precedent_recall` / `major_deviation_rate` / `unusable_rate` / `dim_missing_rate` / `upgrade_rate`
- 根因七分类（`retro.js:31-38`）：FIELD_MISMATCH / INFO_INCOMPLETE / INPUT_LATE / DIM_MISSING /
  EDGE_MISSING / NEED_DIM_ORDER / DATA_QUALITY_PRECEDENT

→ 全部围绕「决策做得好不好」，**与 §1 表中 21 项参数配置无交集**。
报告三段落 `rectification = { daily_ops, problems, prescriptions }`（`retro.js:322`）中的 `prescriptions`
只是 `draftPatches` 的字段映射（`toPrescription`，`retro.js:236`），**不构成对所有参数的体检**。

### 断裂点 5（P1）— 配置键名错配（fail-open 掩盖）

| 位置 | 读的键 | 库里实际的键 | 后果 |
|---|---|---|---|
| `src/decision/retro.js:24` `retroTimeoutMs()` | `decision-retro` | **`retro-config`** | 超时配置恒走 180000ms 出厂兜底，配了不生效 |

同类风险：`routing-explore`（本轮新增的 A/B 实验参数）**未注册进 `src/portal/configCenter.js` CONFIG_ITEMS**，
管理员在配置中心**看不见也改不了**。

---

## §3 实测数据（生产库 crm_native）

### 3.1 config_store 实际键（16 个）

```
approval-config | billing-plans | billing-settings | context-routing
decision-context-guard | e2e.propagation.test | hindsight-deviation | llm
precedent-conf | provenance-patrol | retro-config | rubric-llm
rubric-thresholds | rubric-weights | sales-thresholds | tenant-profile
```

- 除 `sales-thresholds` / `tenant-profile` / `e2e.*` 外，**其余 13 键仅 `system` 租户有一份**（其它租户靠回退）
- 无 `retro-knob-map`（断裂点 3 佐证）
- 无 `decision-retro`（断裂点 5 佐证）

### 3.2 calibration_patch / 夜批报告

| 表 | 实测 |
|---|---|
| `crm.calibration_patch` | **0 行**（`SELECT knob,status,count(*) GROUP BY 1,2` → 空） |
| `crm.decision_retro_report` | **4 行**，最近一次 `2026-09-04T18:00:00Z` |

→ 夜批在跑，但**从未产出过一条 ADMIN 待办**。

---

## §4 缺口分级与建议动作

| 优先级 | 缺口 | 建议动作 | 依据 |
|---|---|---|---|
| **P0-1** | 待办从未产生 | 建「参数巡检器」：对 §1 的 22 项参数逐项体检（不依赖 LLM 的确定性判据），产出 PENDING 处方 | §2 断裂点 1 |
| **P0-2** | 待办无处可批 | `/my-todo.html` 增「参数调优」视角，消费 `calibration_patch`；批准复用 `store.approvePatch`（第 0 闸） | §2 断裂点 2 |
| **P0-3** | 处方引擎未接线 | 接线 `prescribe()` 作为**所有**处方的定量护栏；播种 `retro-knob-map` 到 config_store | §2 断裂点 3 |
| **P1-1** | 报告不覆盖参数面 | 报告新增「参数体检」段落：22 项 ×（当前值 / 健康度 / 建议 / 依据样本） | §2 断裂点 4 |
| **P1-2** | 键名错配 | `retro.js:24` 改读 `retro-config`（或统一重命名 + 迁移） | §2 断裂点 5 |
| **P2-1** | `routing-explore` 未注册 | 补进 `configCenter.js` CONFIG_ITEMS | §2 断裂点 5 |
| **P2-2** | 参数变更无留痕对比 | 处方批准后回填 `applied_at` + 前后值 diff 入报告 | 可观测性 |

---

## §5 待裁决：本期落地范围

| 方案 | 覆盖范围 | 工作量 | 风险 | 说明 |
|---|---|---|---|---|
| **A 全面版** | 22 项参数全量体检 + 统一巡检器 + my-todo 新视角 | 大 | 中 | 一次补齐，需为每类参数定义健康判据 |
| **B 聚焦版** | 决策链 6 项核心（rubric-thresholds / rubric-weights / precedent-conf / autonomy-conf / context-routing / sales-thresholds） | 中 | 低 | 先跑通「巡检→处方→待办→批准」全链路，其余逐批扩 |
| **C 最小版** | 只修 3 个断裂点（接线处方引擎 / 待办入 my-todo / 修键名），**不扩参数面** | 小 | 低 | 链路通了但覆盖仍窄，报告依旧不覆盖参数 |

**建议 B**：先用 6 项核心参数把「每夜体检 → 明确调整建议 → ADMIN 待办 → my-todo 批准」主链路跑通并实证产出，
再按同一范式批量扩到全部 22 项（扩参数 = 加判据配置，不改框架）。

---

## 附：审计方法

- 配置面单一事实源：`src/portal/configCenter.js` `CONFIG_ITEMS`（33 项）
- 消费面统计：`grep -rhoE "readConfig\(\s*'[^']+'"` → 22 个键
- 夜批事实：`src/scheduler/timers.js`（9 个定时器）、`src/decision/retro.js`、`src/decision/routingReview.js`
- 实测：直连 `crm_native` 查 `config_store` / `calibration_patch` / `decision_retro_report`
- 未采用文档自述作为证据（发现 §2 断裂点 3 恰为「文档标 ✅ 但未接线」）
