# 实施计划：第 0 闸加固——执行器层统一 mint decision

- 设计文档：docs/2026-09-03-decision-gate-unified-mint.md（已批准）
- 日期：2026-09-03
- 模式：Inline Execution（T1–T4 逐 Task，每 Task 一 commit，AI 不代 commit）
- 铁律：零信任（不写生产）、禁 DELETE、file:line 证据、测试隔离（按键清理非 TRUNCATE）

## T1 executor 统一 mint 决策

**目标**：在 `src/action/executor.js` 第 0 闸放行 `autoDecision` 后、第 1 闸前，插入统一 mint 逻辑。

**改动点**：
1. import 区加 `import { requireDecision } from '../decision/autonomyEngine.js';`（executor 已 import `query`）
2. 模块级加 helper：
   - `getScenario(scenario_id, tenantId)`：`SELECT * FROM decision_scenario WHERE scenario_id=$1 AND (tenant_id=$2 OR tenant_id='system') ORDER BY tenant_id=$2 DESC LIMIT 1` → 行或 null
   - `inferEntities(actionName, params)`：deal_id→`[{type:'CRM_DEAL',id}]`、contract_id→CRM_CONTRACT、invoice_id→CRM_INVOICE、order_id→CRM_ORDER、payment_plan_id→CRM_PAYMENT_PLAN、account_id→CRM_ACCOUNT；否则 `[]`
3. 在 `src/action/executor.js:31`（第 0 闸 `}` 之后）插入：
```js
    // T1：autoDecision 统一 mint——仅声明 decisionScenario 且已注册才代 handler mint（防硬抛 + 防双 mint）
    if (def.autoDecision && !decisionId && def.decisionScenario) {
      const sc = await getScenario(def.decisionScenario, ctx.tenantId);
      if (sc) {
        const d = await requireDecision(def.decisionScenario, { action: actionName, ...params, actor: ctx.actor }, inferEntities(actionName, params), { actor_id: ctx.actor });
        ctx.decision_id = d.decision.decision_id;
        emit('decision', `${actionName}-auto`, { decision_id: d.decision.decision_id, scenario: def.decisionScenario });
      } else {
        emit('trace', 'auto-decision-no-scenario', { action: actionName, scenario: def.decisionScenario });
      }
    }
```

**测试**：`test/action/executor-mint.test.js`（新建）
- mock `getScenario` 返回已注册 → executor dispatch 带 `autoDecision` 且 `def.decisionScenario` → 断言 `requireDecision` 被调、返回 ctx 含 decision_id
- mock 返回 null → 断言不抛、不调 requireDecision、trace 告警 emit
- 未声明 `decisionScenario` → 断言不调 requireDecision

**提交**：`src/action/executor.js` + `test/action/executor-mint.test.js`

## T2 autoDecision action 配 decisionScenario

**目标**：给可映射且已注册场景的 action 加 `decisionScenario` 字段（`src/action/seed-actions.js`）。

**改动点**（registerAction 调用内加 `decisionScenario`）：
- `crm-quote-submit`（:871 区）`QUOTE_PRICING`
- `crm-quote-activate`（:888 区）`QUOTE_PRICING`（注：needsApproval:true，审批通过 approvalPassed 路径仍会经此 mint——报价决策锚定合理）
- `crm-contract-create`（:903 区）`POST_CONTRACT`
- `crm-contract-submit`（:959 区）`POST_CONTRACT`
- `crm-payment-plan-create`（:1009 区）`POST_CONTRACT`
- `crm-payment-record-create`（:1023 区）`POST_CONTRACT`
- `crm_calibration_patch_generate`（:1493 区）`CALIBRATION_CHANGE`
- `crm_calibration_patch_approve`（:1521 区）`CALIBRATION_CHANGE`
- `crm_calibration_patch_reject`（:1536 区）`CALIBRATION_CHANGE`
- `crm_calibration_patch_rollback`（:1550 区）`CALIBRATION_CHANGE`

**不动**：已合规 7 个（不声明 decisionScenario，避免双 mint）；`crm-quote-create`（上轮已 handler 内 mint，保持）；`crm_decision_outcome_*`；`invoice-*`/`order-*`/`review-gate-approve`/`import-batch`（无注册场景，暂缓）。

**测试**：`test/action/seed-actions-mint.test.js`（新建）或扩 `action.test.js`
- 断言上述 action 的 `def.decisionScenario` 等于映射值
- 集成：crm-contract-create 不带 decision_id 经 executor → 落库 decision 表有记录（或返回含 decision_id）

**提交**：`src/action/seed-actions.js` + 测试

## T3 第 0 闸统一 mint 回归

**目标**：受影响子集全绿，已合规 7 action 无双 mint。

**运行**：
```
PGDATABASE=crm_native_test vitest run test/action/ test/http/swas.test.js test/http/account-360.test.js
```
- 断言：swas.test（未动，2/2）、action.test（21/21）、contract/payment 集成（若有）绿
- 双 mint 验证：crm-deal-advance 经 executor 后 decision 表仅 1 条（非 2）

**提交**：无新文件（仅测试运行结果），若有回归修复则附。

## T4 落盘审计报告

**目标**：`docs/2026-09-03-decision-gate-audit.md`

**内容**：
- 已配 scenario 清单（action → scenario → 已注册）
- 暂缓清单（invoice-/order-/review-gate/import-batch → 缺注册场景，需先注册）
- 待办 2（底层 repo 强制）评估结论与破坏性分析（留待后续）
- 待办 3（双 Agent 阈值）设计内说明
- 硬闸风险与巡检建议（trace `auto-decision-no-scenario`）

**提交**：`docs/2026-09-03-decision-gate-audit.md`

## 交付清单（供用户按 Task 提交）

- `src/action/executor.js`（T1）
- `test/action/executor-mint.test.js`（T1）
- `src/action/seed-actions.js`（T2）
- `test/action/seed-actions-mint.test.js`（T2）
- `docs/2026-09-03-decision-gate-audit.md`（T4）
- 设计+计划文档（已写）

署名 `Co-Authored-By: 王川 <watchm@163.com>`
