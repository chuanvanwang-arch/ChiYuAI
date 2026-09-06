# P0 → P1 落地设计：TAORAN / BANTCC / SWAS / 漏斗质量管理

> 日期：2026-08-30 ｜ 状态：**待用户批准**（批准前不写实现代码）
> 输入：两份 SKILL（`to-b-sales-management` 13 场景 39 标准 / `sales-knowledge-free` 五层开放知识库）
> 上一篇：`docs/2026-08-30-sales-3layer-behavior-design.md`（L1/L2/L3 三层行为模型）
> 铁律：SKILL = 唯一事实源；领域专有内容不进 10 大 ai-* SKILL；写操作必经决策第 0 闸；禁 DELETE

---

## §0 结论与范围

**一句话**：本轮把 从「管动作」推进到「管结果可信度」。P0 补数据前提（TAORAN 六要素 + BANTCC 六维分存），P1 在其上建商机回顾与漏斗质量。

**范围边界**

| 纳入 | 不纳入（后续批次） |
|---|---|
| P0-0 字段名兼容收口（三处遗漏） | 日周月运营（日报 7 项 / 周会 / 月季 KPI） |
| P0-A TAORAN 六要素 T + A 补全 | 客户数量标准（人均 ≈ 75） |
| P0-B BANTCC 五维 → 六维分存 | 客户现场设备信息三类 |
| P1-A SWAS 商机回顾（S/W/A/S） | 关系水平三套模型（L0-L5 / 0-4 级 / 角色四分类） |
| P1-B 漏斗质量：MANT + 加权 + 抖动 + 承诺 | 七大底层逻辑 LG-01~07 建模 |

---

## §1 现状证据（file:line）

### 1.1 TAORAN —— 只实现 4/6，且字段名存在新旧两套

| 要素 | SKILL 定义 | 当前落点 | 状态 |
|---|---|---|---|
| **T**ype 客户类型 | 自动同步 客户类型及商机阶段 | `visit_notes[].t_type` 被 `behaviorChecklist.js:38`（02-01 判定）消费 | ⚠️ 有字段、无写入路径 |
| **A**ppointment 是否预约 | 商机客户拜访原则上应有预约 | `evaluator.js:119` `last.t_appointment`（仅缺口提示消费） | ⚠️ 有消费、无写入 |
| **O**bjective 目的 | 与阶段关联、可量化 | `evaluator.js:106` `t_objective` | ✅ |
| **R**esult 结果 | 引用客户原话，非主观判断 | `evaluator.js:106` `t_result` | ✅ |
| **A**chieved 是否达标 | ≥80% 达到 / <20% 未达到 / 其余部分达到 | `behaviorChecklist.js:51` `t_achieved === '未达到'` | ✅（仅二元，无三档） |
| **N**ext Step 后续安排 | 具体行动 / 下次拜访时间 | `evaluator.js:106` `t_next` | ✅ |

**关键缺口**：`visit_notes` 无生产写入路径（仅 seed 脚本写），所以 T/A 两要素既无 UI 也无 Action 落库。

### 1.2 BANTCC —— 实为五维，非 SKILL 的六维

`evaluator.js:59-82` 计算齐全度，维度表 `:71-77` 只有 **B/A/N/T/C 五个键**，`:79` 除以 5，`:57` 注释亦写「五维齐全度」。

问题出在 C：`evaluator.js:76` 把 **coach（内部支持者）** 与 **competition（竞争）** 混进同一个 C：

```js
C: scoreOf('c', p.coach, p.competition, p.alternatives, p.stakeholders),
```

而 SKILL 定义两个 C 是**不同语义**：
- **C1 Competition**：竞争情况
- **C2 Company & Condition**：可获得的公司支持及条件

混维的后果：无法区分「不了解对手」和「没有内线」，而这两者在漏斗质量 V9 里对应完全不同的处置（前者要摸竞情，后者要发展 coach）。

### 1.3 SWAS —— 完全缺失

全仓 grep `win_strategy` 仅两处：`behaviorChecklist.js:63`（21 条 06-02 判定）与 `evaluator.js:143`（degraded 恒 false）。**无字段定义、无写入、无门控、无看板**。

### 1.4 漏斗质量管理 —— 完全缺失

CRM_DEAL 已有 `expected_amount` / `expected_close_date` / `probability` / `stage`（`routes.js:601,634` 消费），但**无 MANT 四要素、无预测分类、无加权值、无抖动率、无承诺准确率**。
可复用：`alertRegistry.js:24` 已注册 `forecast_breach` 告警规则（kind/actions 已配，但无数据源驱动）。

### 1.5 【P0-0 前置】字段名兼容还漏了第三处（本轮发现）

上一轮把 `visit_notes` 字段名从 `t_*` 改为无前缀，只补了两处兼容：

| 文件 | 行 | 状态 |
|---|---|---|
| `namedAccountBoard.js` | 32 | ✅ 已兼容（`n.objective ?? n.t_objective`） |
| `behaviorChecklist.js` | 16 `pick()` | ✅ 已兼容 |
| **`evaluator.js`** | **106、115-119、128-147** | ❌ **漏改，仍直读 `t_*`** |

影响面（比上一轮更大）：`sales_visit_value` 恒 false → **P2→P3 阶段门控会被误拦**（`executor.js:176-178` 读该属性）；`sales_behavior_checklist` 的 01-02/03-03/04-02/04-03/06-03/07-02 六项恒 false。

---

## §2 P0-A：TAORAN 六要素补全

### 2.1 字段契约（一次定死，全仓共用）

`visit_notes[]` 单项结构（**新写法为准，`t_` 前缀仅作旧数据兼容**）：

```js
{
  at,            // ISO 时间（已有）
  type,          // 'visit' | 'call'（已有，缺省 visit）
  // ── TAORAN 六要素 ──
  customer_type, // T：'opportunity' | 'target' | 'potential'（写入时从账户 tier 自动同步，不手填）
  appointment,   // A：boolean，是否预约
  objective,     // O：拜访目的（可量化关键结果）
  result,        // R：结果事实（引用客户原话）
  achieved,      // A：'达到' | '部分达到' | '未达到'（三档，替原二元）
  next,          // N：下一步安排
  // ── 既有扩展 ──
  prepare, review, new_contact, collaboration
}
```

**T 要素自动同步原则**（对齐 `crm-system-spec.md` 的「自动同步」设计原则）：`customer_type` 由写入侧从账户 `payload.tier` 带出，不由销售手填，避免与账户档位漂移。

### 2.2 落点

| 层 | 改动 | 文件 |
|---|---|---|
| 事实源 | `skills/method-behavior-standard/methodology.json` 增 `taoran` 六要素定义（含 achieved 三档阈值 80%/20%） | SKILL |
| 兼容层 | 抽公共 `pickNote(n, key)` 到 `src/sales/visitNote.js`（新），三处消费方统一 import | 新文件 |
| 消费点 1 | `evaluator.js` 六处 `t_*` 改 `pickNote()` | `evaluator.js:106,115-119,128-147` |
| 消费点 2 | `behaviorChecklist.js` 复用 `pickNote()` 替本地 `pick()` | `behaviorChecklist.js:16` |
| 消费点 3 | `namedAccountBoard.js` 复用 `pickNote()` | `namedAccountBoard.js:32` |
| 校验 | `sales_visit_value` 判定从 O/R/N 三要素扩为 **O/R/N + T 存在**，A 缺失仅告警 | `evaluator.js:103-110` |
| 种子 | 补 `customer_type` / `appointment` / `achieved` 三档示例 | `scripts/seed-named-accounts-demo.mjs` |

### 2.3 achieved 三档的影响

原判定 `behaviorChecklist.js:51` 为 `t_achieved === '未达到'`。改三档后：
- `03-03`（不做无效拜访）：`achieved === '未达到' && !next` → 仍判 false（未达标且无后续动作 = 无效拜访）
- `evaluator.js:118`（sales_visit_gaps）：新增 `achieved === '部分达到'` → 不计缺口，仅记录

---

## §3 P0-B：BANTCC 五维 → 六维分存

### 3.1 维度拆分

```js
// evaluator.js 新维度表
const dims = {
  B: scoreOf('b', p.expected_amount, p.budget),                    // 预算
  A: scoreOf('a', p.authority, p.decision_maker),                  // 决策流程
  N: scoreOf('n', p.needs?.product, p.needs?.qty, p.pain_points),  // 需求
  T: scoreOf('t', p.expected_close_date, p.timeline),              // 时间表
  C1: scoreOf('c1', p.competition, p.alternatives),                // 竞争情况（原 C 拆出）
  C2: scoreOf('c2', p.coach, p.internal_support, p.stakeholders),  // 公司支持与条件
};
// 齐全度 = 六维均值（分母 5 → 6）
```

### 3.2 迁移与口径影响（必须显式说明）

| 项 | 变更 | 风险 | 处置 |
|---|---|---|---|
| 分母 | `/5` → `/6` | 旧数据齐全度**系统性下降**（5 维满分 → 6 维分母变大） | 迁移脚本对**无 C1/C2 显式评分**的旧商机，C1、C2 回退按「C 旧值」各记同分，等效分母不变；仅当显式填 C1/C2 才走六维 |
| 门控阈值 | `executor.js:187` `bantcc < 0.6` 拦截 | 阈值不变但分母变 → 拦截率上升 | 迁移后跑一次全量回归，统计 P3→P4 拦截率变化，**超 20% 需回调阈值至 0.5** |
| 输出 | rationale 从 `filled/5` 变 `filled/6` | 测试断言 | 同步更新 `test/aiAttributes/sales-evaluator.test.js` |

### 3.3 落点

| 文件 | 改动 |
|---|---|
| `skills/method-bantcc/methodology.json`（新 SKILL） | 六维定义 + 每维达标证据要求 |
| `evaluator.js:59-82` | 维度表改六维 + 迁移回退逻辑 |
| `evaluator.js` AI_ATTR_DEFS | 增 `bantcc_detail`（axis J_Judge），落 `payload.ai.bantcc_detail = {B,A,N,T,C1,C2}` 供看板定位缺口维度 |
| `executor.js:183-190` | P3→P4 拦截文案增「缺哪一维」（读 `ai.bantcc_detail`） |
| 迁移脚本 | `scripts/migrate-bantcc-6dim.mjs`（幂等，只补算不删） |

**为什么允许落 `ai.bantcc_detail`**：21 条 03-01 与漏斗 MANT 都需**定位缺哪一维**，仅有聚合值无法给出可行动建议。这符合 AI 属性铁律（落 `payload.ai.*`，带轴/置信度/理由）。

---

## §4 P1-A：SWAS 商机回顾

### 4.1 数据模型

`CRM_DEAL.payload.swas`：

```js
{
  status: 'P1'..'P6',        // S：阶段（已有 payload.stage，此处为回顾快照，避免与推进态混淆）
  win_strategy: '总拥有成本优势 + 财务总监内线推动',  // W：关键制胜策略
  action: [{ what, who, when, done }],               // A：行动计划（5W1H）
  schedule: {                                        // S：项目时间节点
    bid_date: '2026-Q4',        // 预计开标
    order_date: '2026-12',      // 预计下单
    milestones: [{ name, date, done }],
  },
  reviewed_at, reviewed_by,     // 回顾留痕（场景六：每个项目明确并达成共识）
}
```

**新增 AI 属性**（`evaluator.js` AI_ATTR_DEFS.CRM_DEAL）：

| 属性 | axis | 判定（确定性兜底） |
|---|---|---|
| `swas_completeness` | J_Judge | S/W/A/S 四项齐全度（0~1），缺任一项记 0.25 递减 |
| `swas_staleness_days` | J_Judge | `now - reviewed_at` 天数，>30 触发 `stuck_warning` 联动 |

### 4.2 门控接线

`executor.js` STAGE_GATES 新增/增强：

- **P2→P3**：现有 hard 闸读 `sales_visit_value`；**追加 soft**——`swas_completeness < 0.5` 时 warnings 提示「未做商机回顾，建议先补 SWAS」（不硬拦，避免卡死推进）
- **P4→P5**：现有 soft 闸读 `review_gate_decision`；**改为读取 `swas.schedule.order_date` 存在性**作为附加证据

### 4.3 写入路径（决策第 0 闸）

新增 Action `crm-deal-swas-update`（kind=write，写经 `decision_id`）：

```
POST /api/action/crm-deal-swas-update
{ deal_id, swas: {...}, decision_id }
```

走既有 5 闸链路（第 0 闸决策 → 1 闸范围 → 1.5 闸 RBAC → 2.5 闸字段权限 → 3 闸审批）。
**不新增表**：SWAS 落 `payload.swas`（JSONB），与粒子模型一致，避免 CRUD 爆炸（对齐 `ai-native-action-design` 基数规则 R1-R6）。

---

## §5 P1-B：漏斗质量管理（MANT / 加权 / 抖动 / 承诺）

### 5.1 数据模型

`CRM_DEAL.payload.funnel`：

```js
{
  mant: {
    m: { ok: bool, evidence: '资金已过会，批文号 XXX' },   // 资金明确（须决策者以上确认）
    a: { ok, evidence: '决策链：采购总监→CFO→CEO' },        // 决策圈明确
    n: { ok, evidence: 'A3 彩盒产线 2 条' },                // 需求明确（类型+大概数量）
    t: { ok, evidence: '预计 2026-Q4 开标' },               // 时间明确（能定到季度）
  },
  forecast_class: '确保'|'优势'|'可能+'|'可能-'|null,      // 进漏斗后的分类
  committed: { month: '2026-10', at: ISO, by: 'alice' },    // 承诺（每月 20 日截止）
  baseline_amount: 120000,  // 季度初取值金额（算抖动率的分母快照）
}
```

**纯函数**（新 `src/sales/funnelQuality.js`，零 DB）：

| 函数 | 输入 | 输出 | 依据 |
|---|---|---|---|
| `mantOk(funnel)` | mant | `{ ok, missing: ['m','t'] }` | 四要素全明确才可进漏斗 |
| `funnelZone(deal)` | deal | `'线索'\|'机会-'\|'机会+'\|'漏斗内'` | 线索=四要素全不清；机会-=ANT≥1 且 M 不清；机会+=M 明确且 ANT 未全清；漏斗内=四要素全清 |
| `forecastClass(deal)` | deal | `'确保'\|'优势'\|'可能+'\|'可能-'` | 确保=中标通知书；优势=满足 A 或 B-E；可能±=势均力敌/劣势 |
| `weightedAmount(deal)` | deal | 金额 × 加权值 | 确保 0.9 / 优势 0.6 / 可能+ 0.3 / 可能- 0 |
| `salesPotential(deals, annualTarget)` | deals | `(已下单 + Σ加权) / 年任务` | 健康性要求 ≥100% |
| `jitterRate(baseline, actual)` | 两期金额 | 抖动率 | 季度 ≤30%、月 ≤30%（周 ≤40% 仅监控） |
| `commitAccuracy(promised, actual)` | 承诺 vs 实际 | 兑现率 + 评价色 | 下月 90-110% 绿 / 80-90% 黄 / <80% 红 |

### 5.2 关键设计决策

**① 抖动率必须有 baseline 快照**
抖动率 = (取消 + 降出漏斗 + 后延 - 中标未下单) / 取值时漏斗内金额。分母是**季度初取值**，若不落 `baseline_amount` 快照，事后无法复算。
→ 新增定时任务 `scripts/snapshot-funnel-baseline.mjs`（季度末月 21 日取数，与 SKILL「取值时间」一致），落 `funnel.baseline_amount`。

**② 加权值不进 AI 属性轴**
加权是**确定性业务规则**（SKILL 明确定死 0.9/0.6/0.3/0），不是 AI 推断 → 落 `payload.funnel` 业务事实字段，不落 `payload.ai.*`（AI 属性铁律：不冒充人工事实）。

**③ 承诺准确率作为「反喂校准」数据源**
承诺兑现率是本平台既有的**决策质量校准层**（`src/calibration/`）的天然输入：销售反复承诺不准 = 预测类决策置信度应下调。
→ 一期只落数与看板，**不自动调参**；二期接 `calibration/metrics.js` 作为新指标（需单独设计）。

**④ 与既有关联**
- `alertRegistry.js:24` `forecast_breach` 规则：一期用 `salesPotential < 1.0` 驱动（当前无数据源）
- `namedAccountBoard.js` 的 `gapHint()`：增「承诺不准」缺口（兑现率 <80%）

### 5.3 看板（受控渲染，不写自由 HTML）

新增 `src/pages/S36.schema.js`（漏斗质量看板）+ `src/http/funnelRouter.js`：

| 端点 | 说明 |
|---|---|
| `GET /api/funnel/quality?owner=&period=` | 漏斗健康度：真实性（MANT 缺失清单）+ 健康性（销售潜力）+ 抖动率 + 承诺兑现 |
| `GET /api/funnel/deals?zone=` | 按漏斗区域列商机（线索/机会-/机会+/漏斗内/确保/优势/可能±） |

页面 `src/web/funnel-quality.html` —— **复用 `common.css` 的 `.card`/`.page-head`，不另造样式**（本日教训，见记忆）。

---

## §6 决策与 Action 汇总

| Action | kind | 落点 | 第 0 闸 |
|---|---|---|---|
| `crm-visit-log`（拜访记录写入，补 T/A） | write | `CRM_ACCOUNT.payload.visit_notes[]` | ✅ 需 decision_id |
| `crm-deal-swas-update` | write | `CRM_DEAL.payload.swas` | ✅ |
| `crm-deal-funnel-update`（MANT + 分类 + 承诺） | write | `CRM_DEAL.payload.funnel` | ✅ |

**第 0 闸场景扩展**（`src/decision/` 场景枚举）：
- `VISIT_LOG`
- `SWAS_REVIEW`
- `FUNNEL_COMMIT`（承诺属于对未来的承诺性决策，必须留痕）

---

## §7 Task 拆分

| # | Task | 交付物 | 依赖 |
|---|---|---|---|
| T1 | P0-0 字段名兼容收口 | `src/sales/visitNote.js`（新）+ 三处消费方改造 + 兼容测试 | — |
| T2 | P0-A TAORAN T/A 补全 | SKILL methodology 增 taoran；`sales_visit_value` 判定扩展；种子补字段 | T1 |
| T3 | P0-B BANTCC 六维 | `evaluator.js` 维度表 + `bantcc_detail` + 迁移脚本 + 门控文案 | T1 |
| T4 | 门控阈值回归 | 统计 P3→P4 拦截率，必要时回调 0.6→0.5 | T3 |
| T5 | P1-A SWAS 数据模型 + Action | `payload.swas` + `crm-deal-swas-update` + 两个 AI 属性 | T3 |
| T6 | P1-A SWAS 门控接线 | STAGE_GATES P2→P3 soft、P4→P5 增强 | T5 |
| T7 | P1-B 漏斗纯函数 | `src/sales/funnelQuality.js` + 单测 | T3 |
| T8 | P1-B 漏斗端点 + 看板 | `funnelRouter.js` + `S36.schema.js` + `funnel-quality.html` | T7 |
| T9 | baseline 快照脚本 | `scripts/snapshot-funnel-baseline.mjs` | T8 |
| T10 | 告警接线 | `forecast_breach` 接 `salesPotential` | T8 |

每 Task 一 commit（AI 不代提交，用户本地执行）。

---

## §8 测试与验收

| 层 | 用例 |
|---|---|
| 兼容 | `pickNote()` 新旧字段名等价（三处消费方各一例，断言 `items` 全等） |
| TAORAN | 六要素齐全 → `sales_visit_value=true`；缺 T → false 且 gap 含「缺客户类型(T)」 |
| BANTCC | 六维齐全度分母为 6；C1/C2 独立计分；旧数据（无 C1/C2）回退等效五维 |
| 门控 | P2→P3 硬闸照旧；P3→P4 拦截文案含缺失维度；阈值回归统计 |
| SWAS | 四项齐全 → `swas_completeness=1`；>30 天未回顾 → `swas_staleness_days` 触发 |
| 漏斗 | `funnelZone` 八区域判定正例各一；加权值 0.9/0.6/0.3/0 各一；抖动率/兑现率边界值 |
| 端到端 | seed 数据 → 看板 MANT 缺失清单非空、销售潜力可算 |

**量化验收**：
- P0 完成后，21 条判定在种子数据上 ≥ 12/21（当前 10/21，补 T/A/achieved 三档后应提升）
- P1 完成后，`GET /api/funnel/quality` 返回 `salesPotential` 且 P95 < 300ms

---

## §9 风险与取舍

| 风险 | 影响 | 处置 |
|---|---|---|
| BANTCC 改六维导致 P3→P4 拦截率跳升 | 商机推进受阻 | T4 专项回归，阈值可调 |
| 抖动率依赖 baseline 快照，漏跑即失真 | 指标不可信 | 脚本幂等 + 缺快照时看板显式标「无基线」而非显示 0 |
| SWAS 增加销售填写负担 | 采纳率下降 | 一期仅 P2→P3 时 soft 提示，不硬拦；W/A/S 由 AI 从拜访记录预填草稿，人工确认 |
| 承诺准确率用于考核引发博弈 | 数据造假 | 一期只看不考核，UI 明示「监控指标，不考核」 |
