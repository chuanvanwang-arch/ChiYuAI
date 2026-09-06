# P0 → P1 测试计划（红灯先行）

> 日期：2026-08-30 ｜ 状态：**已批准，进入红灯阶段**
> 配套设计：`docs/2026-08-30-sales-p0-p1-taoran-bantcc-swas-funnel-design.md`
> 纪律：**先写失败测试 → 跑出红灯 → 再实现 → 跑绿 → 每 Task 一 commit**
> 红灯定义：测试因「功能未实现/未接线」而失败；若因语法或导入错误失败，须先修到「断言失败」形态

---

## §0 测试策略

### 0.1 分层

| 层 | 位置 | 覆盖 |
|---|---|---|
| 纯函数单测 | `test/sales/*.test.js` | `visitNote` / `funnelQuality` / `behaviorChecklist` |
| AI 属性单测 | `test/aiAttributes/sales-evaluator.test.js` | TAORAN 判定 / BANTCC 六维 / SWAS 属性 |
| 门控单测 | `test/action/sales-executor-gate.test.js` | STAGE_GATES P1-P6（含新 soft 闸） |
| HTTP 端点 | `test/http/funnel.test.js`（新） | `/api/funnel/quality` `/api/funnel/deals` |
| 端到端 | `test/sales-named-accounts/*.test.js` | 种子数据 → 21 条 / 漏斗看板 |

### 0.2 命名约定

用例描述格式：`it('【T{n}-C{m}】{行为} → {期望}', ...)`，便于红灯阶段按 Task 统计。

### 0.3 兼容铁律（贯穿全计划）

`visit_notes` 存在新旧两套字段名，**任何用例都必须同时覆盖**：
- 新写法：`objective` / `result` / `next` / `type` / `achieved`
- 旧写法：`t_objective` / `t_result` / `t_next` / `t_type` / `t_achieved`
- 断言：两者**判定结果全等**（`expect(newItems).toEqual(oldItems)`）

---

## §1 T1：P0-0 字段名兼容收口

**目标**：抽公共 `src/sales/visitNote.js` 的 `pickNote(n, key)`，三处消费方统一 import。

**依据**：`evaluator.js:106,115-119,128-147`（漏改）、`behaviorChecklist.js:16`、`namedAccountBoard.js:32`

| # | 用例 | 输入 | 期望 |
|---|---|---|---|
| T1-C1 | `pickNote` 新写法优先 | `{objective:'A', t_objective:'B'}` | `pickNote(n,'objective') === 'A'` |
| T1-C2 | `pickNote` 回退旧写法 | `{t_objective:'B'}` | `=== 'B'` |
| T1-C3 | `pickNote` 空值不误命中 | `{objective:''}` | `=== ''`（不回退到 `t_objective`） |
| T1-C4 | `pickNote` 全缺 | `{}` 或 `null` | `undefined` |
| T1-C5 | `sales_visit_value` 新旧等价 | 同一记录两种写法 | 两者 `value` 相等且为 `true` |
| T1-C6 | 21 条（evaluator degraded 版）新旧等价 | 同上 | `items` 全等 |
| T1-C7 | 21 条（behaviorChecklist 完整版）新旧等价 | 同上 | `items` 全等 |
| T1-C8 | 拜访明细映射新旧等价 | 同上 | `namedAccountBoard` 输出 `visits[].objective` 相等 |
| T1-C9 | 三处消费方均不再直读 `t_*` | 源码扫描 | `grep -c "t_objective\|t_achieved\|t_new_contact\|t_collaboration"` 在三个消费文件中 = 0 |

> T1-C9 用**源码扫描断言**锁死，防止后续再漏改。

---

## §2 T2：P0-A TAORAN 六要素补全（T + A）

**目标**：补 `customer_type`(T) 与 `appointment`(A)；`achieved` 二元 → 三档。

**依据**：`evaluator.js:103-110`（sales_visit_value）、`:111-121`（sales_visit_gaps）、SKILL A 场景七标准 16

| # | 用例 | 输入 | 期望 |
|---|---|---|---|
| T2-C1 | 六要素齐全 | T/A/O/R/A(达到)/N 全有 | `sales_visit_value.value === true`，rationale 含「六要素齐全」 |
| T2-C2 | 缺 T（客户类型） | 无 `customer_type` | `value === false`，gap 含「缺客户类型(T)」 |
| T2-C3 | 缺 O/R/N 任一 | 缺 `next` | `value === false`（回归，原行为不变） |
| T2-C4 | 缺 A（预约）不判 false | 无 `appointment` 但 O/R/N/T 全 | `value === true`（A 缺失仅告警不判负） |
| T2-C5 | 商机客户无预约 → 告警 | `customer_type='opportunity'` 且 `appointment!==true` | `sales_visit_gaps` 含「商机客户无预约」 |
| T2-C6 | 目标客户无预约 → 不告警 | `customer_type='target'` 且无预约 | `sales_visit_gaps` 不含该项 |
| T2-C7 | achieved 三档：达到 | `achieved='达到'` | `03-03` 为 `true`，gaps 不含「本次未达目标」 |
| T2-C8 | achieved 三档：部分达到 | `achieved='部分达到'` | `03-03` 为 `true`（有 next 即有后续动作），gaps 不含「未达目标」 |
| T2-C9 | achieved 三档：未达到 + 无 next | `achieved='未达到'` 且无 `next` | `03-03` 为 `false`（无效拜访） |
| T2-C10 | achieved 三档：未达到 + 有 next | `achieved='未达到'` 且有 `next` | `03-03` 为 `true`（虽未达标但有后续动作） |
| T2-C11 | 旧数据 `t_achieved='未达到'` 兼容 | 旧写法 | 与 T2-C9 结果一致 |
| T2-C12 | 21 条判定数提升 | 种子数据（补 T/A 后） | `pass >= 12`（当前 10，补 T/A + achieved 三档后应提升） |

---

## §3 T3：P0-B BANTCC 五维 → 六维

**目标**：拆 C 为 C1(Competition) / C2(Company & Condition)；分母 5 → 6；新增 `ai.bantcc_detail`。

**依据**：`evaluator.js:59-82`（现五维）、SKILL A 场景五标准 11

| # | 用例 | 输入 | 期望 |
|---|---|---|---|
| T3-C1 | 六维齐全满分 | B/A/N/T/C1/C2 全有 | `value === 1`，rationale 含 `6/6` |
| T3-C2 | 仅 C1 有 | 有 `competition` 无 `coach` | `value === 1/6`，detail `C1=1 C2=0` |
| T3-C3 | 仅 C2 有 | 有 `coach` 无 `competition` | `value === 1/6`，detail `C1=0 C2=1` |
| T3-C4 | coach 与 competition 不再混维 | 仅 `coach` | **C1 不计分**（回归锁死旧行为已改） |
| T3-C5 | 旧数据迁移回退 | 无 C1/C2 显式评分，仅有旧 `c` 值 1 | C1、C2 各记 1（等效分母不变），`value === (B+A+N+T+1+1)/6` |
| T3-C6 | 显式评分优先 | `bantcc={c1:0.5, c2:0}` | `C1=0.5 C2=0`，不走 0/1 信号 |
| T3-C7 | `bantcc_detail` 落库 | 任意商机 | `payload.ai.bantcc_detail.value` 为六键对象 `{B,A,N,T,C1,C2}` |
| T3-C8 | `bantcc_detail` 带轴与置信度 | 同上 | `axis==='J_Judge'`、`confidence===0.8` |
| T3-C9 | 门控文案含缺失维度 | P3→P4 且 `bantcc<0.6`（缺 T、C1） | 拦截 error 含「T」「C1」 |
| T3-C10 | 门控阈值不变 | `bantcc === 0.6` | 放行（边界值） |
| T3-C11 | 门控拦截 | `bantcc === 0.59` | 拦截 |
| T3-C12 | 迁移脚本幂等 | 连续跑两次 | 第二次无变更（`changed === false`） |

---

## §4 T4：门控阈值回归（P3→P4 拦截率）

**目标**：统计六维改造前后 P3→P4 拦截率变化，超 20% 回调阈值。

| # | 用例 | 输入 | 期望 |
|---|---|---|---|
| T4-C1 | 拦截率统计脚本 | 全量商机样本 | 输出 `{before, after, delta}`，脚本可重复执行 |
| T4-C2 | delta ≤ 20% 阈值不变 | delta 0.15 | 阈值保持 0.6 |
| T4-C3 | delta > 20% 触发回调提示 | delta 0.25 | 输出建议阈值 0.5（**不自动改**，需人工确认） |

> T4-C3 只输出建议、不自动改阈值——避免测试偷偷改业务规则。

---

## §5 T5-T6：P1-A SWAS 商机回顾

**依据**：SKILL A 场景六标准 14；设计 §4

| # | 用例 | 输入 | 期望 |
|---|---|---|---|
| T5-C1 | SWAS 四项齐全 | status/win_strategy/action/schedule 全有 | `swas_completeness.value === 1` |
| T5-C2 | 缺 W（制胜策略） | 无 `win_strategy` | `value === 0.75` |
| T5-C3 | 缺两项 | 无 W、无 schedule | `value === 0.5` |
| T5-C4 | 全缺 | `swas` 为空 | `value === 0` |
| T5-C5 | 回顾新鲜度 | `reviewed_at` 为 10 天前 | `swas_staleness_days.value === 10` |
| T5-C6 | 回顾过期联动 | `reviewed_at` 为 40 天前 | `swas_staleness_days.value === 40` 且 `stuck_warning` 为 `true` |
| T5-C7 | Action 写经第 0 闸 | `crm-deal-swas-update` 无 `decision_id` | 返回 `{ok:false, gate:'decision_required'}` |
| T5-C8 | Action 写入落库 | 带 `decision_id` | `payload.swas` 含写入内容 |
| T6-C1 | P2→P3 soft 闸不硬拦 | `sales_visit_value=true` 但 `swas_completeness=0` | `ok===true`，`warnings` 含「未做商机回顾」 |
| T6-C2 | P2→P3 硬闸照旧 | `sales_visit_value=false` | `ok===false`，gate `sales_prereq` |
| T6-C3 | P4→P5 读 schedule | 有 `swas.schedule.order_date` | 放行（叠加既有 review_gate 判定） |
| T6-C4 | P4→P5 无 schedule | 无 order_date | warnings 含「缺预计下单时间」 |

---

## §6 T7-T10：P1-B 漏斗质量管理

**依据**：SKILL A `references/sales-funnel-v9.md`；设计 §5

| # | 用例 | 输入 | 期望 |
|---|---|---|---|
| T7-C1 | MANT 四要素全明确 | m/a/n/t 均 `ok:true` | `mantOk().ok === true`，`missing === []` |
| T7-C2 | MANT 缺 M | `m.ok=false` | `ok === false`，`missing === ['m']` |
| T7-C3 | `funnelZone`：线索 | 四要素全不清 | `'线索'` |
| T7-C4 | `funnelZone`：机会- | ANT≥1 且 M 不清 | `'机会-'` |
| T7-C5 | `funnelZone`：机会+ | M 明确且 ANT 未全清 | `'机会+'` |
| T7-C6 | `funnelZone`：漏斗内 | 四要素全清 | `'漏斗内'` |
| T7-C7 | `forecastClass`：确保 | 有中标通知书 | `'确保'` |
| T7-C8 | `forecastClass`：优势 | 决策者为我司支持者 | `'优势'` |
| T7-C9 | `forecastClass`：可能+ | 势均力敌 | `'可能+'` |
| T7-C10 | `forecastClass`：可能- | 处于劣势 | `'可能-'` |
| T7-C11 | 加权值 0.9 | 确保 × 100万 | `weightedAmount === 900000` |
| T7-C12 | 加权值 0.6 | 优势 × 100万 | `=== 600000` |
| T7-C13 | 加权值 0.3 | 可能+ × 100万 | `=== 300000` |
| T7-C14 | 加权值 0 | 可能- × 100万 | `=== 0` |
| T7-C15 | 销售潜力 ≥100% | 已下单 50 + 预期 60，任务 100 | `salesPotential === 1.1` |
| T7-C16 | 销售潜力 <100% | 已下单 20 + 预期 30，任务 100 | `=== 0.5` |
| T7-C17 | 季度抖动率 ≤30% | 基线 100，取消+后延 20 | `jitterRate === 0.2` |
| T7-C18 | 抖动率缺基线 | `baseline_amount` 为 null | 返回 `null`（**不返回 0**） |
| T7-C19 | 承诺兑现 90-110% 绿 | 承诺 100 实际 100 | `{rate:1.0, level:'green'}` |
| T7-C20 | 承诺兑现 80-90% 黄 | 承诺 100 实际 85 | `level:'yellow'` |
| T7-C21 | 承诺兑现 <80% 红 | 承诺 100 实际 70 | `level:'red'` |
| T7-C22 | 承诺兑现 ≥110% 紫 | 承诺 100 实际 130 | `level:'purple'`（承诺过低） |
| T8-C1 | 端点鉴权 | 无 token | 401 |
| T8-C2 | 端点返回健康度 | 正常请求 | 含 `authenticity`（MANT 缺失清单）+ `health`（销售潜力） |
| T8-C3 | 端点按 owner 过滤 | `?owner=alice` | 仅返回 alice 名下商机 |
| T8-C4 | 看板页 UI 合规 | `funnel-quality.html` | `ui-lint` 无架构级违规；复用 `.card`（不另造样式） |
| T9-C1 | baseline 快照落库 | 季度末月 21 日跑 | `funnel.baseline_amount` 有值 |
| T9-C2 | 快照幂等 | 连跑两次 | 第二次无变更 |
| T10-C1 | 告警接线 | 销售潜力 0.5（<1.0） | `forecast_breach` 命中 |
| T10-C2 | 告警不误报 | 销售潜力 1.2 | 不命中 |

---

## §7 测试文件清单

| 文件 | 状态 | 覆盖 Task |
|---|---|---|
| `test/sales/visitNote.test.js` | 新建 | T1 |
| `test/aiAttributes/sales-evaluator.test.js` | 扩展 | T1、T2、T3、T5 |
| `test/sales-named-accounts/named-account-board.test.js` | 扩展 | T1、T2 |
| `test/action/sales-executor-gate.test.js` | 扩展 | T3、T6 |
| `test/sales/funnelQuality.test.js` | 新建 | T7 |
| `test/http/funnel.test.js` | 新建 | T8、T10 |
| `scripts/migrate-bantcc-6dim.mjs` 配套用例 | 新建 | T3-C12 |

---

## §8 执行顺序

```
T1 测试(红) → T1 实现(绿) → [commit]
T2 测试(红) → T2 实现(绿) → [commit]
T3 测试(红) → T3 实现(绿) → [commit]
T4 回归统计            → [commit]
T5-T6 测试(红) → 实现(绿) → [commit]
T7-T10 测试(红) → 实现(绿) → [commit]
```

**红灯转绿灯的判据**：同一用例从「断言失败」变为「通过」，且未通过修改期望值达成（禁止改期望迁就实现）。
