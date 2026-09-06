# 第 0 闸加固：执行器层统一 mint decision

- 日期：2026-09-03
- 作者：WorkBuddy（AI 原生实施搭档）
- 关联：2026-09-03-agent-event-trigger-design.md（C1 事件触发派发）、2026-09-03-agent-event-trigger.md（C1 实施计划）
- 状态：已批准（用户 P5 批准，2026-09-03 13:1x）

## 1. 背景与根因

B能源"全程没用 agent"排查后，差距分析（见对话）暴露：业务写 action 层**大多已接第 0 闸**，但存在系统性"声明未兑现"假绿——`seed-actions.js` 中 **33 个 `autoDecision:true` 写 action**，仅 7 个（deal-advance/reopen、lead-pick/recycle、proposal-write、import-batch、deal-rollback）handler 内真正 `requireDecision` mint decision；其余（含 `crm-quote-create`，本轮已补）声明 `autoDecision` 但 handler 未 mint → 写操作无 decision 锚定。

硬闸机制（`src/action/executor.js:28`）：`if (def.kind==='write' && !decisionId && !ctx.bootstrap && !def.autoDecision) return gate:'decision_required'`。即 `autoDecision:true` 的 action 由 executor 放行、handler 自负 mint 责任；handler 不 mint 即假绿。

`requireDecision`（`src/decision/autonomyEngine.js:124`）有**硬闸**：scenario 未注册直接 `throw new Error('未知决策场景')`。真实 `decision_scenario` 注册清单**缺** `CONTRACT_APPROVE / INVOICE_APPROVE / ORDER_APPROVE / PAYMENT_PLAN / PROPOSAL_APPROVE / REVIEW_GATE` 等场景。

## 2. 范围边界（明确不做）

- **待办 3（双 Agent 派发阈值）**：设计内行为（高置信度+有先例→自主放行，非每次派发），**不改**。
- **待办 2（底层 `particleRepo` 强制 `decision_id`）**：未选（C 方案），**本轮不做**；记后续独立任务。
- **无已注册 scenario 的 action**：`invoice-*` / `order-*` / `review-gate-approve` / `import-batch` 语义错乱映射会硬抛 500，本轮**不强行配**，列已知待补（需先注册对应决策场景，独立决策）。

## 3. 统一 mint 机制（executor.js，第 0 闸放行后）

```js
// T1：autoDecision 统一 mint——仅当 action 显式声明 decisionScenario 且该 scenario 已注册才代 handler mint
if (def.autoDecision && !decisionId && def.decisionScenario) {
  const sc = await getScenario(def.decisionScenario, ctx.tenantId);
  if (sc) {
    const d = await requireDecision(
      def.decisionScenario,
      { action: actionName, ...params, actor: ctx.actor },
      inferEntities(actionName, params),
      { actor_id: ctx.actor }
    );
    ctx.decision_id = d.decision.decision_id; // 注入，供 handler emit decision 事件
  } else {
    emit('trace', 'auto-decision-no-scenario', { action: actionName, scenario: def.decisionScenario });
    // 不抛错、不拦截：保持原行为（假绿风险 trace 可见，可巡检）
  }
}
```

- **不双 mint**：已合规 7 个 action handler 内已 mint，它们**不声明 `decisionScenario`**，executor 跳过。
- **`inferEntities(actionName, params)`**：deal_id→CRM_DEAL、contract_id→CRM_CONTRACT、invoice_id→CRM_INVOICE、order_id→CRM_ORDER、payment_plan_id→CRM_PAYMENT_PLAN、account_id→CRM_ACCOUNT；解析不出传 `[]`（零证据→保守升级，诚实降级，非静默）。
- **`getScenario(scenario_id, tenantId)`**：查 `decision_scenario`（tenant 专属缺失回退 system，对齐 requireDecision 回退语义）；返回行或 null。

## 4. scenario 映射表（基于真实注册清单）

| action | scenario | 已注册 | 本轮 |
|---|---|---|---|
| deal-advance/reopen/lead-*/proposal-write/import-batch/rollback | (已有 handler mint) | ✅ | 不动 |
| crm-quote-create | QUOTE_PRICING | ✅ | 保持上轮 handler 内 mint（已合规） |
| crm-quote-submit / quote-activate | QUOTE_PRICING | ✅ | **配 decisionScenario** |
| crm-contract-create / contract-submit | POST_CONTRACT | ✅ | **配 decisionScenario** |
| crm-payment-plan-create / payment-record-create | POST_CONTRACT | ✅ | **配 decisionScenario** |
| crm_calibration_* | CALIBRATION_CHANGE | ✅ | **配 decisionScenario** |
| crm_decision_outcome_write/set | (上游提供) | — | 不配 |
| invoice-* / order-* / review-gate-approve | (无场景) | ❌ | 暂缓待补 |

## 5. 任务拆分（living contract §A）

### T1 executor 统一 mint 决策
```contract-yaml
- task: "executor 统一 mint 决策"
  agent: crm-copilot
  skills: [ai-native-action-design]
  memory: [crm-copilot]
  knowledge_scope: { layers: [L1], max_hops: 1 }
  success: "单测：声明 decisionScenario 且已注册→executor 自动 mint 并注入 ctx.decision_id；未声明→不 mint 无报错；未注册 scenario→trace 告警不抛"
```

### T2 autoDecision action 配 decisionScenario
```contract-yaml
- task: "autoDecision action 配 decisionScenario"
  agent: crm-copilot
  skills: [ai-native-action-design]
  memory: [crm-copilot]
  knowledge_scope: { layers: [L1], max_hops: 1 }
  success: "crm-contract-create / payment-plan-create 不带 decision_id 经 executor 后落库含 decision_id（或 decision 表有记录）"
```

### T3 第 0 闸统一 mint 回归
```contract-yaml
- task: "第0闸统一 mint 回归"
  agent: crm-copilot
  skills: [ai-native-action-design]
  memory: [crm-copilot]
  knowledge_scope: { layers: [L1], max_hops: 1 }
  success: "受影响子集测试全绿；已合规 7 action 无双 mint（decision 表不重复）"
```

### T4 落盘审计报告
```contract-yaml
- task: "落盘第0闸加固审计报告"
  agent: crm-copilot
  skills: [ai-native-action-design]
  memory: [crm-copilot]
  knowledge_scope: { layers: [L1], max_hops: 1 }
  success: "docs/2026-09-03-decision-gate-audit.md 含『已配 scenario / 暂缓（无注册场景）』清单与硬闸风险说明"
```

## 6. 风险与验证

- 开销：`requireDecision` 每次读 6 配置键 + 证据加载——已是合规 action 常态路径，非新增瓶颈。
- 诚实降级：`inferEntities` 空→零证据→保守升级（tier 升、自主放行概率降），非静默假绿。
- 验证：单测 mock `getScenario` 返回已注册/未注册两路；集成测 contract-create 经闸；全量受影响子集绿。

## 7. 闭环回写（§B）

| task | agent | gap_type | observed | expected | severity |
|---|---|---|---|---|---|
| (空，P0 预检无历史反馈) | — | — | — | — | — |

> 本设计经 P0 预检：无 `<doc>.feedback.json` 历史，闭环回写表为空。实施后由 workbench 监控契约，下一轮 P0 吸收反馈并提 SKILL 改进（approval-gated）。
