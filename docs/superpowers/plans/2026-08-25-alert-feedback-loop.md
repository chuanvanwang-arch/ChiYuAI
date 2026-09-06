# 实施计划 · 阶段 2 子系统五 预警/反馈回路

> 来源设计：`docs/2026-08-25-alert-feedback-loop-design.md`（§A-§I 已批准，commit 1a66d5e）
> 纪律：每 Task 一 commit；TDD；纯逻辑本地绿（无 PG 依赖）；DB 集成（§C 表 + DB 读表/落库/查询）留 PG 环境验收。
> 执行：Inline（与子系统四一致；DB 依赖子任务在 PG 环境验收）

---

## T1 · alertRegistry.js 内存规则表 + ruleEvaluator.js 纯函数判定

**文件**：`src/alerts/alertRegistry.js`（新建）+ `src/alerts/ruleEvaluator.js`（新建）

**职责**：
- `alertRegistry.js`：
  - 内存规则表（对齐 DB `crm.alert_rule` 镜像结构：kind/match/check_params/enabled/version），种子 5 类业务告警（对齐设计 §B：deal_stuck/lead_overdue/forecast_breach/approval_bottleneck/payment_due，payment_due enabled=false 因 CRM_INVOICE 未落地）。
  - `listAlertRules()` → 规则数组（含 enabled）。
  - `setRuleEnabled(kind, enabled)` → 启停（kind 不存在 → {ok:false, error:'rule_not_found'}）。
  - `resetAlertRegistry()` → 测试/重建用清空（对齐子系统三 resetRegistry 范式）。
- `ruleEvaluator.js`：
  - `evaluateAlertRule(rule, event)` → **纯函数** `{hit, payload}`。
  - match 判定：event.particleType ∈ rule.match.particleTypes 且 event.action ∈ rule.match.actions。
  - check_params 计算（MVP 三档）：`stuck_days`（stage 停留天数 ≥ 阈值 → hit）、`overdue_days`（未跟进天数 ≥ 阈值 → hit）、`breach_pct`（金额/预测比 < 阈值 → hit）；无 check_params 或未命中 → hit:false。
  - 未匹配 match（粒子/动作不属于该规则）→ hit:false。

**测试**（`test/alert.test.js` T1 块）：
- listAlertRules 含 5 类且 payment_due enabled=false。
- setRuleEnabled('deal_stuck', false) 生效；未知 kind 拒绝。
- evaluateAlertRule：deal_stuck 规则 + stuck_days 超限事件 → hit:true + payload；未超限 → hit:false；粒子类型不匹配 → hit:false。
- resetAlertRegistry 清空后种子回落。

**commit**：`feat(alert-T1): alertRegistry 内存规则表(5类种子+启停) + ruleEvaluator 纯函数判定`

---

## T2 · alertStore.js 处置状态机（open→ack→close）

**文件**：`src/alerts/alertStore.js`（新建）

**职责**：
- `createAlert({kind, severity, l2c_stage, target_role, particle_id, payload, decision_id})` → `{ok, alert}`（status='open'，alert_id=uuid，created_at=ISO）。kind/severity/target_role 必填非法拒绝。
- `listAlerts({kind, status})` → 过滤清单。
- `ackAlert(alert_id)` → open→acked（acked 幂等拒绝；closed 拒绝）。
- `closeAlert(alert_id, {reason})` → open/acked→closed（**closed_reason 必填**，缺 → {ok:false, error:'closed_reason_required'}；closed 幂等拒绝）。
- 内存 Map（对齐 pageStore 范式；DB 落库留 PG）。
- `resetAlertStore()` → 清空（测试用）。

**测试**（T2 块）：
- createAlert → open + 字段齐备；缺 target_role 拒绝。
- ack → acked；acked 再 ack 幂等拒绝；closed 拒绝。
- close 带 reason → closed；缺 reason 拒绝；closed 再 close 幂等拒绝。
- listAlerts 按 kind/status 过滤。
- resetAlertStore 清空。

**commit**：`feat(alert-T2): alertStore 处置状态机(open→ack→close, close必填reason, 幂等拒绝)`

---

## T3 · feedbackMetrics.js per-tier 指标纯函数

**文件**：`src/alerts/feedbackMetrics.js`（新建）

**职责**：
- `computePerTierMetrics(decisions)` → **纯函数** `{metricsByTier}`。
- 输入：decision 数组（对齐决策主轴 §6：每条含 tier/outcome/created_at/completed_at/overturned）。
- 输出 per-tier：
  - `autonomy_rate` = outcome='autonomous' 占比
  - `escalation_rate` = outcome='escalated' 占比
  - `overturn_rate` = overturned=true 占比
  - `avg_decision_latency_s` = (completed_at − created_at) 平均秒数（无完成 → 不含）
- 空数组 → `{metricsByTier:{}}`；tier 缺失归 'unknown'。

**测试**（T3 块）：
- 给定 3 决策（autonomous/escalated/autonomous，1 条 overturned）→ autonomy_rate 2/3、escalation_rate 1/3、overturn_rate 1/3、latency 平均值正确。
- 空数组 → 空对象。
- 无 tier 字段 → 'unknown' 桶。

**commit**：`feat(alert-T3): feedbackMetrics per-tier 指标纯函数(自主率/升级率/推翻率/平均时延)`

---

## T4 · 写时触发接线（events bus 订阅粒子写 → evaluator → alertStore → SSE alert 域）

**文件**：`src/alerts/alertHook.js`（新建，+ 依赖 `src/events/bus.js` 现有 `on/emit`）

**职责**：
- `registerAlertHook()` → 订阅粒子写事件（bus `on('particle', ...)`，复用 SSE 既有 5 域 task/trace/approval/particle/payment 中 particle 域）。
  - 事件含 `type`（如 'particle_created'/'particle_updated'）与 payload（particleType/action/…）。
  - 对每条 enabled 规则：匹配 match.particleTypes + match.actions → evaluateAlertRule → **hit:true 则** createAlert（severity 对齐规则/§3.10 风险分档）→ emit('alert', 'alert_created', {alert, kind}) SSE 转播。
  - 异步订阅（bus 同步分发但订阅者不阻塞写路径——对齐设计 §E「不阻塞主事务」）。
- `unregisterAlertHook()` → 退订（测试隔离）。

**测试**（T4 块，纯逻辑无 PG）：
- 注册 hook → emit 粒子写事件（deal_stuck 超限）→ alertStore 出现 open 告警 + SSE 'alert' 域收到（自建内存 hub 断言 type:'alert'）。
- 未启用规则（payment_due enabled=false）→ 不产生告警。
- unregister 后 emit → 不产生告警（退订生效）。

**commit**：`feat(alert-T4): 写时触发接线(particle域订阅→evaluator→createAlert→SSE alert域转播)`

---

## T5 · routes 端点接线

**文件**：`src/http/routes.js`（扩展）

**职责**（对齐设计 §F）：
- `GET /api/alerts` → listAlerts（filter kind/status query）。
- `POST /api/alerts/:id/ack` → ackAlert；404 页/幂等拒绝 → 400 语义化。
- `POST /api/alerts/:id/close` → closeAlert（body.reason；缺 → 422）。
- `GET /api/alerts/rules` → listAlertRules。
- `POST /api/alerts/rules/:kind/enable|disable` → setRuleEnabled。
- `POST /api/alerts/evaluate` → **纯逻辑验收面**：body={rule, event} → evaluateAlertRule 结果。
- `GET /api/feedback/metrics` → computePerTierMetrics（本地返回内存空集；DB 查询留 PG）。

**测试**（T5 块，用超轻 http 断言——复用 routes 既有测试范式或直接函数级）：以现有 routes 测试风格为准；核心断言端点存在 + 纯逻辑面 evaluate 返回 hit 判定。若项目无 routes HTTP 测试范式，本块只做函数级（listAlerts/filter 已在 T2 覆盖）→ T5 以「端点已注册不炸」为断言。

**commit**：`feat(alert-T5): routes 端点(告警清单/处置/规则启停/evaluate纯逻辑面/feedback指标)`

---

## T6 · 测试聚合 + 文档收尾

**文件**：`test/alert.test.js`（T1-T5 累积）+ `docs/2026-08-25-alert-feedback-loop-design.md`（状态行 + §I commit 区间回填）+ `docs/2026-08-25-ai-native-crm-overall-design.md`（§8.6 第 5 项标记完成）

**职责**：
- 跑 `node node_modules/vitest/vitest.mjs run test/alert.test.js` 全绿（纯逻辑，无 PG）。
- 设计文档状态行「待评审」→「已批准 + 实施完成（T1-T6 commit 区间）」；§I 回填实际 commit。
- 总体设计 §8.6 第 5 项新增「**已完成**（阶段 2 子系统五，T1–T6）」摘要：写时触发/规则表启停/处置状态机/per-tier 指标/SSE alert 域，纯逻辑 N/N 本地全绿，DB 集成留 PG 验收。
- 顺手把 TaskList #55/#56 标记完成（子系统四、五均落地）。

**commit**：`docs(alert-T6): 子系统五文档收尾`

---

## 验证命令（用户/CI）

```bash
node node_modules/vitest/vitest.mjs run test/alert.test.js   # 纯逻辑全绿（无 PG 依赖）
```

> 本子系统 alert/rule 为内存 Map（对齐 pageStore），无 DB 表本地即可全绿；`crm.alert` / `crm.alert_rule` 两表（设计 §C）+ DB 读表/落库/查询留 PG 环境（阶段 3 验收）。