# 设计文档 · 阶段 2 子系统五：预警/反馈回路（Alert & Feedback Loop）

> **状态**：**已批准（2026-08-25）+ 实施完成**（T1–T5 提交 6336863→79e8ecc；纯逻辑本地全绿，DB 集成留 PG 验收）
> **上游**：`docs/2026-08-25-ai-native-crm-overall-design.md` §3.10（五类业务告警）· §6.3（决策网络）· §6.13.7 2c（SSE 主动推送）· §6.13.8 原则⑤（先于提问的预警）
> **方法论挂靠**：ai-event-driven-evolution（事件驱动触发）+ ai-feedback-loop（反馈回路·业务结果闭环）
> **实施纪律**：每 Task 一 commit；TDD；纯逻辑本地全绿（无 PG 依赖）；DB 集成留 PG 环境验收（对齐子系统三/四既有约束）

---

## §A 背景与目标

阶段 1 已完成底座：`src/ruleEngine.js`（只进不退/输单必填，写闸门规则）+ SSE 事件总线（5 事件域）+ 决策主轴（§6 决策事件）。阶段 2 已完成上下文分层（L1-L4）、记忆三构件、Action 写白名单、门户 NL→Page。**剩余最后一块：把「业务风险」主动暴露给对应角色，并把「决策结果」回填成可度量反馈**——即总设计 §3.10 承诺的「决策质量监控 + 五类业务告警 + outcome→per-tier 指标」。

**目标**：
1. 写时预警：粒子写事件 → 规则引擎判定 → 命中落 `crm.alert` 表 → SSE 转播给对应角色。
2. 规则治理：预警规则可后台启停（`crm.alert_rule.enabled`），新增/停用不重启服务。
3. 反馈闭环：告警处置状态机（open→ack→close）+ 决策 outcome 回填 + per-tier 指标计算器（自主率/升级率/推翻率/平均决策时延）。

**非目标（YAGNI）**：
- 不引入常驻主动扫描进程（已选写时触发，对齐写通道闸门架构）。
- 不做规则热加载 DSL/远程配置（DB 动态表已满足启停）。
- 不做告警订阅个人化/消息推送渠道（SSE 事件域已够 MVP）。
- 不做 auto-close 机器学习（处置状态机纯规则 + 人工 ack/close）。

---

## §B 告警面（五类业务告警，对齐 §3.10）

| # | kind | 名称 | 触发写场景 | 判定逻辑（check_params） | 目标角色 |
|---|---|---|---|---|---|
| 1 | `deal_stuck` | 商机卡滞 | CRM_DEAL 写（advance/stage） | stage 停留 > X 天未推进（param `stuck_days=30`） | 销售 |
| 2 | `lead_overdue` | 线索超期 | CRM_LEAD 写（跟进） | 线索未跟进 > X 天（param `overdue_days=30`） | 销售 |
| 3 | `forecast_breach` | 预测破口 | CRM_DEAL 写（金额/阶段） | 商机总额低于预测值 Y%（param `breach_pct=0.8`） | 高管 |
| 4 | `approval_bottleneck` | 审批积压 | 审批事件（approval 域） | 待审批单据 > X 个（param `bottleneck_count=5`） | 商务/审批人 |
| 5 | `payment_due` | 回款到期 | CRM_INVOICE/回款写 | 应收账款将到期/逾期（param `due_days=7`） | 财务 |

> MVP 阶段 1-4 类为**纯规则判定**（代码+params），第 5 类 payment_due 依赖回款日期字段，若 CRM_INVOICE 粒子未落则**规则注册但 enable=false**（对齐 YAGNI：不建表硬凑）。

---

## §C 数据模型（DB，PG 环境）

### crm.alert（告警实例表）
```sql
CREATE TABLE IF NOT EXISTS crm.alert (
  alert_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL,              -- deal_stuck/lead_overdue/forecast_breach/approval_bottleneck/payment_due
  severity    text NOT NULL DEFAULT 'medium',  -- low/medium/high（§3.10 风险分档）
  l2c_stage   text,                       -- 锚点：lead/opportunity/quoted/contracted/ordered/paid
  target_role text NOT NULL,              -- sales/finance/exec/ops
  particle_id uuid,                       -- 触发粒子（商机/线索/发票…）
  payload     jsonb,                      -- {from,to,days,amount,ratio,…}
  status      text NOT NULL DEFAULT 'open',   -- open/ack/close
  created_at  timestamptz DEFAULT now(),
  acked_at    timestamptz,
  closed_at   timestamptz,
  closed_reason text,
  decision_id uuid REFERENCES crm.decision(decision_id)  -- 处置决策关联（§6.3 决策网络）
);
```

### crm.alert_rule（规则注册表，后台启停）
```sql
CREATE TABLE IF NOT EXISTS crm.alert_rule (
  rule_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL UNIQUE,       -- 与 alert.kind 对齐
  match       jsonb NOT NULL,             -- {particleTypes:[...], actions:[...], events:[...]}
  check_params jsonb,                     -- {stuck_days:30, overdue_days:30, breach_pct:0.8, ...}
  enabled     boolean NOT NULL DEFAULT true,
  version     int NOT NULL DEFAULT 1,
  updated_at  timestamptz DEFAULT now()
);
```

---

## §D 纯逻辑层（本地可测，无 PG）

| 模块 | 职责 | 输出 |
|---|---|---|
| `src/alerts/ruleEvaluator.js` | **纯函数**：`evaluateAlertRule(rule, event)` → `{hit:boolean, payload}`。match 判定（粒子类型+动作命中）+ check_params 计算（stuck_days 比较等） | `{hit, payload}` |
| `src/alerts/alertRegistry.js` | 内存规则表缓存（对齐 DB alert_rule 镜像）+ `listAlertRules()`/`setRuleEnabled(kind, enabled)` 启停 | `{rules[], setEnabled}` |
| `src/alerts/alertStore.js` | 内存告警实例（对齐 DB crm.alert 镜像）+ `createAlert`/`ackAlert`/`closeAlert`/`listAlerts` + 处置状态机 | `{ok, alert}` |
| `src/alerts/feedbackMetrics.js` | **纯函数**：`computePerTierMetrics(decisions)` → 自主率/升级率/推翻率/平均决策时延（per-tier 聚合） | `{metricsByTier}` |

### alertStore 处置状态机
```
open ──ack──> acked ──close(closed_reason 必填)──> closed
open ──close(直接关，原因必填)──> closed   （ack 可跳过）
closed 不可再 ack/close（幂等拒绝）
```

### feedbackMetrics per-tier 指标
- **自主率** = 该 tier 决策中 outcome=autonomous 占比
- **升级率** = outcome=escalated 占比
- **推翻率** = 该 tier 决策被推翻（overturned）占比
- **平均决策时延** = decision 创建→决策完成平均秒数

---

## §E 写时触发接线（对齐写通道闸门架构）

```
粒子写（executor.dispatch）──> 第 0 闸 decision_id ──> 第 1 闸 scope ──> 第 1.5 闸 RBAC ──> 第 2 闸 force/白名单
                                                                    │
                                    写成功（粒子落库+事件发布）──────┘
                                                                    │
                                            alert hook（写事件订阅）─> ruleEvaluator 判定
                                                                    │ 命中？
                                                                    ├─yes→ alertStore.createAlert（open）→ SSE 转播 alert 域
                                                                    └─no→ 无操作
```

- **挂点**：`src/events/bus.js` 订阅粒子写事件（复用 SSE 总线既有 5 域：task/trace/approval/particle/payment，新增 `alert` 域按 kind 转播），比对 `alert_rule.match`（particleTypes+actions），命中则 evaluator 计算 → createAlert → hub 推送 `type:'alert'`。
- **不阻塞主事务**：alert 判定与落库在写事件**异步订阅**中执行（对齐 §1「写事件驱动预警/审计/反馈，互不阻塞主事务」）。

---

## §F HTTP 端点（routes 接线）

| 方法 | 路径 | 职责 |
|---|---|---|
| GET | `/api/alerts` | 告警清单（filter kind/status） |
| POST | `/api/alerts/:id/ack` | 处置：open→acked |
| POST | `/api/alerts/:id/close` | 处置：→closed（closed_reason 必填，422 否则） |
| GET | `/api/alerts/rules` | 规则表（含 enabled） |
| POST | `/api/alerts/rules/:kind/enable` \| `/disable` | 后台启停 |
| POST | `/api/alerts/evaluate` | **纯逻辑验收面**：body={rule,event} → evaluateAlertRule 结果（本地绿，无 PG） |
| GET | `/api/feedback/metrics` | per-tier 决策质量指标（DB 查询留 PG；本地返回内存空集） |

---

## §G 实施 Task 拆分（writing-plans 详）

- **T1**：alertRegistry.js（内存规则表+启停）+ evaluateAlertRule 纯函数
- **T2**：alertStore.js 处置状态机（open→ack→close，closed_reason 必填）+ 注入/非法拒绝
- **T3**：feedbackMetrics.js per-tier 指标纯函数（自主/升级/推翻/时延）
- **T4**：写时触发接线（events bus 订阅粒子写 → evaluator → createAlert → SSE alert 域转播）
- **T5**：routes 端点（/api/alerts + rules 启停 + evaluate + feedback/metrics）
- **T6**：测试聚合 + 文档收尾（设计文档状态行 + 总体设计 §8.6 第 5 项）

> 每 Task 一 commit；纯逻辑本地绿（无 PG 依赖）；DB 表（§C）与 DB 集成（alert_rule 读表/alert 落库/feedback DB 查询）留 PG 环境。

---

## §H 验收判据

1. `test/alert.test.js` 全绿（T1-T6 纯逻辑，无 PG）。
2. evaluateAlertRule：命中（deal_stuck stuck_days 超限）→ hit:true + payload；未命中→ hit:false。
3. alertStore：open→ack→close 全链；直接 close 需 reason；closed 再操作幂等拒绝。
4. feedbackMetrics：给定决策数组 → 四指标 per-tier 正确。
5. SSE：写事件命中后 hub 收到 `type:'alert'`（事件总线层断言）。
6. DB 集成（PG 环境）：alert_rule 读表启停生效 + alert 落库 + feedback DB 查询——留阶段 2 验收/阶段 3。

---

## §I 提交区间（实施后回填）

子系统五 T1-T5 已实施（2026-08-25），提交区间 `6336863`→`79e8ecc`：

| Task | commit | 内容 |
|---|---|---|
| T1 | `6336863` | alertRegistry 内存规则表（5 类种子+启停+深拷贝防污染）+ ruleEvaluator 纯函数判定 |
| T2 | `5213bee` | alertStore 处置状态机（open→ack→close，close 必填 reason，幂等拒绝） |
| T3 | `bb912a5` | feedbackMetrics per-tier 指标纯函数（自主率/升级率/推翻率/平均时延） |
| T4 | `4af8a29` | alertHook 写时触发接线（particle 域订阅→规则判定→createAlert→SSE alert 域转播） |
| T5 | `79e8ecc` | alertEndpoints 端点模块化（权威路径清单+处理器组装，并发隔离） |

> 验证：`test/alert.test.js` 18/18 全绿（纯逻辑，无 PG 依赖）。DB 集成（`crm.alert`/`crm.alert_rule` 表 + alertHook DB 落库）留 PG 环境验收（阶段 3）。