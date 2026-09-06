# AI 原生 CRM · 09 反馈闭环设计（ai-feedback-loop）

- 日期：2026-08-25
- 方法论依据：`ai-feedback-loop`（业务北极星指标 / 人机分工四判据 / evaluator 质量闸门 / Token-业务因果对账 / LOOP 回路设计七步）
- 业务基线：`2026-08-24-ai-native-sales-crm-design.md` §5ter（业务全景 19 小节）+ §5ter-quater（Q.19 差异点 / Q.20 能力×业务设计输入）
- 前置架构：`2026-08-25-ai-native-crm-overall-design.md` §1（四平面）/ §2（ai-feedback-loop 挂点 L2 事件平面、阶段 2/3）

---

## 0. 核心立场：对账/统计 = 反馈闭环，而非报表

> **Agent 的数量不会自动带来产出，能被测量、能纠错的循环才会。token 消耗增加必须对应到业务结果，而非只留下更长的运行日志。回路 = 目标 → 执行 → 度量 → 评估 → 修正 → 回流，五个环节缺一不可。**

对 CRM 销售域的关键判别（对应 §5ter-quater 差异点 **D8 回路业务化**、**D12 原生化**）：

- **应收对账不是「对账单」，而是「对账回路」。**
  官方（CordysCRM）= 查询/报表；我们 = 反馈闭环：计划(应回) → 记录(实回) → 对账(差额/逾期) → **对账结果自动触发预警与催收动作**，形成「计划→执行→对账→动作」闭环（§5ter.7 域结论）。
- **商机预测偏差不是「统计对比」，而是「预测回灌」。**
  预计/实际结束时间对比产出预测准确率，偏差**反哺预测模型与流程优化**，形成预测-对账-进化循环（§5ter.3 域结论）。
- **发票核销不是「人查询后手工核销」，而是「写时关联的自动对账」。**
  发票↔合同↔回款↔抬头的关联在写管线自动成型，未核销自动检测并驱动动作（§5ter.8 域结论）。
- **KPI 基准线三级预警不是「静态报表」，而是「角色回路的可视接口」。**
  指标 × 正常/警戒/严重三级着色，是每条回路预警信号的呈现，而非人读报表（§6.2 / §6.3ter 角色七要素）。

---

## 1. 方法论依据（通用法则 · 跨域可复用）

> 本节提炼 `ai-feedback-loop` 的通用方法论核心，**保持跨域通用**，不含任何项目专有名词（IPD/PDM/P2P/Agent2b 等）。CRM 实例化在 §2/§3。

### 1.1 回路心智模型
- 回路 = **目标 → 执行 → 度量 → 评估 → 修正 → 回流**。无目标=无头苍蝇；无度量=黑箱；无评估=放任；无修正=死循环；无回流=一次性。
- 任何业务流程都可拆成嵌套反馈回路（子回路嵌入主回路），每条边过去由人推动，现在可由 Agent 持续运行。

### 1.2 业务北极星指标
- 每条回路绑定 ≥1 个**指标模板**，含七要素：`direction`(升降) / `formula`(公式) / `target`(目标值+窗口) / `alert`(warn/critical 双档) / `owner_agent`(责任 Agent) / `evaluator_skill`(质量闸门) / `adjust_actions`(偏离时能做什么)。
- 北极星形态 = 成本↓ / 端到端周期↓ / 满足度↑；约束 = 质量 / 合规 / 供应或交付安全。
- 指标模板本身是粒子，写库即构建，可被检索/注入通道暴露。

### 1.3 人机分工四判据
| 判据 | 分工 | 说明 |
|---|---|---|
| 确定性高、频率高、规则明确 | **Agent** | 数据搬运、规则校验、对账计算 |
| 风险高、金额大、结果不可逆 | **人控 + Agent 建议** | 超限动作、重大差异裁决 |
| 需要关系与谈判 | **人** | 客户经营、例外处置 |
| 需要企业边界外信息 | **Agent** | 外部行情、跨源核对 |

人从「流程内执行」移到「流程边界」：战略决策 + 例外处置 + 关系经营；Agent 接管回路内部确定性动作。

### 1.4 evaluator 质量闸门
- evaluator 必须是流水线上**显式节点**（非事后抽查），有动作权利。统一结构：加权判据 `items`（每项 `weight` + `pass_rule`）+ 三档阈值 `auto_pass / human_review / reject` + `actions`（pass 放行 / review 推送人 / reject 差异单）。
- **失败驱动（熔断）≠ 质量驱动（评估回滚）**：熔断是连续失败→blocked；质量闸门是「跑完但评估不达标 → 从 completed 回滚 ready 带评估意见重跑」——后者才是「能纠错的循环」。

### 1.5 Token-业务因果对账
- 每个 Agent 动作的 token 成本，绑定它触发的**业务结果**（节省额/拦截额/周期缩短/逾期回收金额），使「烧 token vs 产出」可观测、可归因。

### 1.6 反馈回路设计金律（摘录通用）
1. **闭环缺口修复常是「给已有函数接调用方」**——指标快照/采集函数常已存在（有定义无调用方），先找已存在函数再补调用点。
2. **看板必须前端化**——`board(loop)` 每回路指标卡须被前端消费，否则「token 对应业务结果」不可观测。
3. **失败驱动 vs 质量驱动**分开（见 1.4）。
4. **评估标准可校准**——记录每次判决 {score, verdict, reason, human_override}；连续同类 redo > 5 次自动校准 pass_rule 并通知 owner；人改判 = 标准偏差信号。
5. **评估结论必须回写业务实体**——形成「采集→评估→回写」闭链，而非只出报告。
6. **新能力须自带反馈发射点**——emit 对应 `loop` 事件、fail-open 不阻断主流程，否则「实现了但回路无信号」。

---

## 2. 业务设计输入（Q.20 + §5ter.7/.3/.8 提取）

来自 §5ter-quater Q.20「ai-feedback-loop」行 + 三个核心业务落点小节，本能力须覆盖以下四类反馈回路输入：

### 2.1 应收对账回路（计划 → 记录 → 对账 → 催收）—— §5ter.7
- **实体**：`PAYMENT_PLAN`(应回) + `PAYMENT_RECORD`(实回) 双粒子，经本体边关联合同↔订单。
- **回路输入**：计划 vs 记录对账（差额/逾期）→ 指标 → 预警/催收动作。
- **理念差异**：官方=查询/报表；我们=对账**业务化**（对账结果自动触发动作，形成应收循环）。**这是 ai-feedback-loop 的第二个核心落点。**

### 2.2 商机预期 vs 实际（预测回灌）—— §5ter.3
- **实体**：`CRM_DEAL` 的 `expected_close_date`（预计）与 `actual_close_date`（实际）。
- **回路输入**：预计/实际结束时间对比 = 预期 vs 实际对账；预测准确率度量 = 反馈闭环输入；**预测偏差回灌** LLM/流程优化，形成预测-对账-进化循环。**这是 ai-feedback-loop 的第一个业务落点。**

### 2.3 发票核销对账 —— §5ter.8
- **实体**：`INVOICE` 粒子经写时本体关联合同↔回款↔抬头。
- **回路输入**：核销 = 关联自动匹配（写时自动关联）；未核销检测 → 预警 → 核销动作。**体现 L2C 最终对账环节（业务↔财务协同接缝）。**

### 2.4 KPI 基准线（角色预警三级）—— §6.2 / §6.3ter
- **输入**：指标 × 正常/警戒/严重三级（如线索首次跟进 ≤24h / 24-48h / >48h 🚨）。五角色（销售/经理/高管/商务/财务）各自 KPI 基准线注入上下文分层 L4，预警三级着色，是回路的可视接口而非静态报表。

| 回路 | 主实体（粒子） | 业务目的 | 北极星指标（草案） |
|---|---|---|---|
| 应收对账 | PAYMENT_PLAN/RECORD | 应收不逾期、不缺口 | 回款逾期率↓、对账差异额↓ |
| 商机预测 | CRM_DEAL | 预测可信、转化可预期 | 预测准确率↑、赢单周期↓ |
| 发票核销 | INVOICE | 票款一致、链路不断 | 未核销率↓、核销时效↓ |
| 角色 KPI | 各业务粒子 | 异常早发现 | 各角色基准线达标率↑ |

### 2.5 §5quater 领域输入补充（实时毛利 + 业财闭环，2026-08-26）

> 来源：`doc/` 两份文档（§5quater Q.21 / 5quater.1 P3/P6）。本能力的行业/方法论强化输入：
- **实时毛利回路（E2，P3）**：通用 CRM 利润=事后报表；印刷 B2B 要求「接单时毛利预判 + 忙季不赚钱预警」。**把反馈闭环从「对账」前移到「接单决策」**——回路实体扩展为 `QUOTE`/`ORDER` 写时成本 BOM（纸价实时 + 损耗模型）vs 报价金额，差额<阈值即预警，形成「报价→成本→毛利→预警→调整」回路。
- **业财一体化闭环（P6）**：合同→领料→收款状态经事件总线联动，管理层实时盈利视图；回路跨越 `CONTRACT`/`ORDER`/`PAYMENT_PLAN`/`PAYMENT_RECORD`/`INVOICE` 全链路，不止应收对账。
- **续约/回款回路（阶段六）**：续约报价（维持/涨/降）决策纳入反馈闭环；回款停滞原因（交付/资金/流程）分流驱动对应动作。

---

## 3. 落地设计

### 3.1 应收对账回路闭环（plan → record → reconcile → collect）
```
PAYMENT_PLAN(应回: plan_amount/plan_date/status)
   → PAYMENT_RECORD(实回: actual_amount/actual_date/voucher)
   → 对账(差额 = plan-actual; 逾期 = now > plan_date 且无 record)
   → 指标(metric_payment_overdue_rate / metric_payment_diff)
   → 自动触发:
       逾期 → emit 预警事件 → 驱动催收 Action(crm-payment-collect)
       重大差异 → 升级财务角色工作台(human_review)
   → 回流: 更新 plan.status / 触发下一期预测
```
- **不写报表**：对账产出不落静态页面，而是事件 + 动作。对账结果自动触发催收（与 §5ter.7 域结论一致）。

### 3.2 商机预计/实际偏差回灌
```
CRM_DEAL 建(expected_close_date + probability)
   → 推进(stage 流转)
   → actual_close_date 写入(实)
   → 偏差度量: close_accuracy = |actual - expected| / expected
   → 回灌: 偏差进预测模型调整(win_probability_adjusted / revenue_forecast)
   → 下一商机预测更准(回流)
```
- 数据草图：指标模板 `mt_deal_forecast_accuracy`（`direction:down`, `formula: avg(|actual-expected|/expected)`, `adjust_actions:[retune_forecast]`）。

### 3.3 发票核销对账回路
```
INVOICE 开具 → 写时关联(合同↔回款↔抬头本体边, 自动)
   → 未核销检测(发票金额 vs 已回款金额缺口)
   → 预警(未核销/超期未开票)
   → 核销 Action 触发 + 财务角色着色
```

### 3.4 KPI 基准线三级预警
- 每个角色 KPI 基准线 = 指标模板 + 三档阈值（`ok`/`warn`/`critical`）。预警事件从事件平面消费，门户三态着色（warn=黄 critical=红）。
- 示例：线索首次跟进 ≤24h(ok) / 24-48h(warn) / >48h(critical 🚨)。

### 3.5 evaluator 质量闸门（具体定义）
```yaml
name: skill_payment_reconcile_eval
loop: receivable_reconcile
evaluates: 应收对账环节产出
inputs: [payment_plan, payment_record, invoice]
items:
  - { name: 金额一致,   weight: 40, pass_rule: "abs(plan.amount - record.amount) <= 0.01 * plan.amount" }
  - { name: 时间逾期,   weight: 30, pass_rule: "record.date <= plan.plan_date + grace_days" }
  - { name: 凭证齐全,   weight: 30, pass_rule: "record.voucher_ref != null" }
thresholds: { auto_pass: 90, human_review: 70, reject: 70 }
actions:
  pass:   自动对账 + verdict=pass
  review: 推送财务工作台 + review_reason
  reject: 差异单 + 通知 + redo_of=trace_id
calibration: 连续同类 redo > 5 → 自动校准 pass_rule 并通知 owner
```
- 同样为 `skill_forecast_accuracy_eval` / `skill_invoice_verify_eval` 定义加权判据 + 三档阈值 + 动作。
- 评估事件桥接进化管线：`TASK_EVAL_REJECT`(redo 归因) / `TASK_EVAL_REVIEW`(校准信号) / `TASK_EVAL_PASS`(良性) / `EVAL_PASS_RULE_CALIBRATED`(校准)。

### 3.6 Token-业务因果对账
- 每个 Agent 对账/催收/回灌动作的 `actor.tokens` 绑定其触发的业务结果（回收金额、节约人工、周期缩短），写入事件总线，供看板「烧 token vs 产出」卡呈现。

### 3.7 数据 / 接口草图
**事件结构（对账回路埋点）**：
```json
{
  "event_id": "evt_...", "event_type": "crm.payment.reconciled",
  "timestamp": "2026-08-25T09:41:00+08:00",
  "trace_id": "trc_...", "loop": "receivable_reconcile",
  "payload": { "deal_id": "D-20260825", "plan_id": "PP-01", "diff_amount": 0, "overdue": false },
  "actor": { "kind": "agent", "id": "agent_deal_coach", "model": "kimi-k2", "tokens": 4520 },
  "evaluation": { "score": 0.96, "verdict": "pass", "evaluator": "skill_payment_reconcile_eval", "redo_of": null }
}
```
**看板数据契约（前端消费）**：
```
GET /api/board?loop=receivable_reconcile
→ { loop, status:'ok'|'warn'|'critical', current, target, alertLevel,
     tokensConsumed, trend:[{ts,value}] }
```

---

## 4. 与其他能力 / 四平面的接口

| 对接平面/能力 | 接口方式 | 内容 |
|---|---|---|
| **L2 事件平面** | 消费 `ai-event-driven-evolution` 预警事件 | 回款逾期 / 合同到期 / 商机卡顿 等事件源 → 触发对账/催收回路 |
| **L2 事件平面** | emit 对账/评估事件 | 对账结果、TASK_EVAL_* 评估事件 → 驱动下一环与进化管线 |
| **L1 粒子平面** | 写粒子状态 | 更新 `payment_plan.status` / `CRM_DEAL` 偏差属性 / `INVOICE` 核销状态 |
| **L3 智能体平面** | 驱动 Agent 动作 | deal-coach（预测回灌）/ crm-copilot（催收派发）/ 财务角色工作台升级 |
| **L4 门户平面** | 反馈看板呈现 | 回路指标卡网格、预警三态着色、Token-业务对账卡；KPI 基准线注入角色上下文（L4 治理决策层） |
| **ai-capability-audit** | 对账审计联动 | 对账/催收动作、金额变化进审计事件流（谁在何时触发什么） |
| **ai-event-driven-evolution** | 预警事件双向 | 本能力是预警事件的「消费方 + 触发方」，与预警规则源协同 |

**不变量**：对账/评估结论必须**回写业务实体**（采集→评估→回写闭链），不只在看板出报告。

---

## 5. 验收判据（来自 §5ter 覆盖 + D8，可验证）

| # | 判据 | 对照来源 |
|---|---|---|
| V1 | 应收对账回路端到端跑通：**对账结果自动触发催收 Action**（非仅出报表） | §5ter.7 + **D8 回路业务化** |
| V2 | 商机预计/实际偏差度量存在并**回灌预测模型**（close_accuracy 指标 + retune_forecast 动作） | §5ter.3 + D8 |
| V3 | 发票核销对账：**未核销自动检测并预警**（写时关联生效） | §5ter.8 + D8 |
| V4 | 五角色 KPI 基准线三级预警落地（指标 × 正常/警戒/严重，前端三态着色） | §6.2 / §6.3ter |
| V5 | evaluator 质量闸门齐备：加权判据 + 三档阈值 + 动作，且评估事件桥接进化管线（TASK_EVAL_*） | 方法论 §1.4 + §3.5 |
| V6 | Token-业务因果对账实现：每条回路「烧 token vs 业务产出」可观测 | 方法论 §1.5 + §3.6 |
| V7 | 反馈看板前端化，预警三态着色 + 趋势 sparkline + Token 对账卡 | 金律 2 |
| V8 | 评估结论回写业务实体（对账/偏差/核销状态落粒子），非仅报告 | 金律 5 |

---

## 6. 不做的事（YAGNI + 不借鉴 CordysCRM 报表式统计）

- ❌ **不做报表式统计 / 查询式对账**（CordysCRM 官方做法）。我们只做回路业务化——对账结果必须驱动动作，不产静态「对账单」。
- ❌ **不建独立统计模块 / 报表系统**。看板是回路的可视接口（指标卡 + 预警着色 + Token 对账卡），不是人读报表。
- ❌ **不把预测偏差当一次性统计**。必须回灌闭环（预测-对账-进化），不做"对比完即弃"。
- ❌ **不引入 SKILL 之外的额外度量框架**。指标模板一律粒子化、走写库即构建，不另起度量体系。
- ❌ **不把 KPI 基准线用作人力资源考核工具**。CRM 内 KPI 三级预警服务于回路异常早发现，不跨域做人事考评。
- ❌ **不把人机分工倒置**：高风险金额动作（超限催收/重大差异裁决）不交 Agent 全自动，保持「人控 + Agent 建议」。
- 💡 **建议（非 SKILL 既有方法，标注供评审）**：如需跨域财务共享对账，可复用同一回路模板（域无关，指标基数稳定）——本期不实现，留作阶段 3 增量。

---

## 设计自检（对照 SKILL）

- [x] 回路心智模型六环节（目标→执行→度量→评估→修正→回流）贯穿 §0-§3
- [x] 业务北极星指标七要素（direction/formula/target/alert/owner_agent/evaluator_skill/adjust_actions）在指标模板草案体现
- [x] 人机分工四判据落地（对账计算=Agent；超限催收=人控+Agent 建议）
- [x] evaluator 质量闸门 = 显式节点（加权 items + 三档阈值 + 动作），失败驱动与质量驱动分开
- [x] Token-业务因果对账（actor.tokens 绑定业务结果）已实现于事件草图
- [x] 四个业务落点全部覆盖（应收对账 / 商机回灌 / 发票核销 / KPI 三级）
- [x] D8 回路业务化、D12 原生化判别在 §0/§2/§5 显式对照
- [x] 四平面接口（L1 写状态 / L2 消费+emit 事件 / L3 驱动 Agent / L4 看板+角色基准线 / audit 联动）齐备
- [x] YAGNI 边界清晰（不做报表式统计、不建独立报表系统、不跨域考核）
- [x] 未编造 SKILL 没有的方法，扩展均以「建议」标注
