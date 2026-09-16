# S6 实施计划 · 常驻授权（T19 · B/C 轴）— TDD 实现计划

> 来源设计：`docs/2026-09-15-final-design-coexistence-and-proactive.md`
> 范围锚定：§11 授权面（线 B）· T19 常驻授权凭证与 T1 自动执行 · §11.3 分级与首批边界 · §11.4 熔断/降级/撤回
> 配套：T21（A 轴补全）已于 2026-09-16 全闭环（A1–A4+E1/E2 已落地已验证），本计划**只做 B/C 轴**（T19）。
>  conventions：TDD（先红后绿）→ 每 Task 一 commit；相对 import；零 DELETE；第 0 闸；config 100% 后台化；租户隔离。

## 0. 现状核验（本次实读，非臆测）

| 项 | 实测结论 | 影响 |
| --- | --- | --- |
| `crm.standing_grant` / `crm.grant_execution` 表 | **不存在**（`db/schema.sql` / `db/migrate*.sql` 均无 DDL） | 须建表（单一事实源：schema.sql + 注册迁移） |
| `crm.decision.grant_ref` / `autonomy_level` 列 | **不存在**（decision DDL 仅 decider_type/decider_id/decider_role） | 须 ALTER 补列，且 `createDecision` INSERT 显式列清单须同步 |
| `autonomyEngine.escalated`（:282） | 仅 A 轴：`forceException||tier==='HIGH'||!sceneAllowsAuto||(tier!=='HIGH'&&conf<effectiveThreshold)` | 须叠加 B/C 轴判定（动作白名单 + 凭证 active） |
| `deferDecisionMint` | 仅 Action 注册标志（seed-actions.js:741 等 5 处 handler 内自 mint 旁路） | standing-auth 执行路径直接 `createDecision` 带 `decider_type='STANDING_AUTH'`+`grant_ref`，不碰 gateway |
| `migrate.js` 迁移注册 | **显式数组**（:13+） | 新迁移 `migration-standing-grant.sql` 须加入数组 |
| `configStore.readConfig/writeConfig` | 支持 per-tenant + system 模板 autoSeed | `standing-grants-policy` 走 system 模板 + autoSeed |
| `writeOutcome`（src/decision/outcome.js） | 存在，`OUTCOME_TYPES` 含 `'other'` | hitl_verdict 回写（J2 闭环）复用之 |

## 1. 三轴放行模型（§11.0，落地判据）

```
自动执行 ⟺  对象 tier ∈ {LEAD, NORMAL}          ← A 轴（已有，autonomyEngine）
          ∧  置信度 conf ≥ effectiveThreshold     ← 已有
          ∧  动作 ∈ standing_grant.scope_actions  ← B 轴（新增）
          ∧  字段 ⊆ standing_grant.field_whitelist ← B 轴（新增）
          ∧  凭证 status='active' 且未超限/未到期  ← C 轴（新增）
```

**T1 首批唯一开放档**：内部字段写（AI 属性、评分、标签、研究结论回填）。**T3 对外动作（发信、阶段推进至 S7/S8）永久不可常驻授权**——永不创建 T3 凭证，且 `isActionAuthorized` 对 T3 动作名显式拒绝。

## 2. 文件结构

```
db/schema.sql                              (+ standing_grant / grant_execution DDL，建表单一事实源)
db/migration-standing-grant.sql            (新：两表 CREATE + decision 补列 + policy system 模板)
db/migrate.js                              (注册 migration-standing-grant.sql 入数组)
src/decision/decisionRepo.js               (+ createDecision 解构 grant_ref/autonomy_level 并 INSERT)
src/authorization/grantStore.js            (新建：凭证 CRUD + resolveActiveGrant + recordExecution + 熔断/撤回)
src/authorization/standingAuthorization.js (新建：policy 加载 + isActionAuthorized + executeUnderGrant)
src/authorization/grantSweeper.js          (新建：过期/连续否决扫描，供定时器)
src/scheduler/timers.js                     (+ 定时器⑮ grant-sweep，VITEST 护栏)
src/decision/autonomyEngine.js             (+ B/C 轴：opts.standingAction 命中凭证方可自主)
src/http/routes.js                         (+ /api/standing-grants GET/POST、/:id/revoke、/grant-executions/:id/verdict)
test/authorization/grantStore.test.js      (新建)
test/authorization/standingAuthorization.test.js (新建)
test/authorization/grantSweeper.test.js    (新建)
test/authorization/ddl.test.js             (新建：断言两表+decision.grant_ref 存在)
test/decision/autonomyStandingGate.test.js (新建：B/C 轴升级判定)
test/http/standingGrants.test.js           (新建)
```

## 3. 任务（TDD，逐 Task 一 commit）

### T19-1：DDL + 迁移注册 + decision 补列

- [ ] **Step 1（红）**：`test/authorization/ddl.test.js` 连真库 `crm_native_test`，断言 `crm.standing_grant`、`crm.grant_execution` 存在且含 `scope_actions/field_whitelist/risk_tier/status/decision_id` 等列；断言 `crm.decision.grant_ref`、`autonomy_level` 列存在。先跑→红（表/列不存在）。
- [ ] **Step 2（绿）**：
  - `db/schema.sql` 追加 §8.5 / §8.6 两段 DDL（与 §11 完全一致：`standing_grant` 16 列 + `idx_grant_active`；`grant_execution` 12 列 + 两索引）。
  - `db/migration-standing-grant.sql`：`CREATE TABLE IF NOT EXISTS` 两表（同 schema.sql）+ `ALTER TABLE crm.decision ADD COLUMN IF NOT EXISTS grant_ref TEXT / autonomy_level TEXT` + 幂等 INSERT `config_store` system 模板 `standing-grants-policy`（默认值见 §9.4）。
  - `db/migrate.js` 数组追加 `'migration-standing-grant.sql'`。
  - `src/decision/decisionRepo.js`：`createDecision` 解构 `grant_ref=null, autonomy_level=null`，INSERT 列清单追加 `grant_ref, autonomy_level`（`$34/$35`），`insertParams` 末尾追加。
- [ ] **Step 3**：重跑 `ddl.test.js` → 绿。提交：`test/authorization/ddl.test.js db/schema.sql db/migration-standing-grant.sql db/migrate.js src/decision/decisionRepo.js`。

### T19-2：grantStore.js（凭证 CRUD + resolveActiveGrant + 熔断/撤回）

- [ ] **Step 1（红）**：`test/authorization/grantStore.test.js`（`resolveActiveGrant` 纯函数 + 真库 CRUD）。先跑→红。
- [ ] **Step 2（绿）**：`src/authorization/grantStore.js` 导出：
  - `createGrant({tenantId, title, scopeActions, scopeObjects, fieldWhitelist, riskTier='T1', maxUses, usedCount=0, period, limitPayload={}, approvedBy, decisionId, expiresAt})` → INSERT 返回行。
  - `getGrant(tenantId, grantId)` / `listGrants(tenantId)`。
  - `revokeGrant(tenantId, grantId, reason)` → `UPDATE ... SET revoked_at=now(), revoked_reason=$reason`（**零 DELETE**）。
  - `resolveActiveGrant({tenantId, action, fields, query})` → **纯函数可单测**：`SELECT * FROM crm.standing_grant WHERE tenant_id=$1 AND status='active' AND (expires_at IS NULL OR expires_at > now()) AND scope_actions @> ARRAY[$2] AND (field_whitelist IS NULL OR field_whitelist @> $3::text[]) ORDER BY created_at LIMIT 1`；返回首行或 null。**字段白名单为超集判定**（`fields` 每元素须被 `field_whitelist` 覆盖）。
  - `recordExecution({tenantId, grantId, signalId, actionName, targetId, beforeState, afterState, decisionId, hitlVerdict='pending'})` → INSERT `grant_execution` + `UPDATE standing_grant SET used_count=used_count+1`；**用量熔断**：`used_count >= max_uses`（且 max_uses 非 null）→ `status='paused'`。
  - `pauseGrant(tenantId, grantId, reason)` → `status='paused'`（状态变更，零 DELETE）。
- [ ] **Step 3**：重跑 → 绿。提交：`src/authorization/grantStore.js test/authorization/grantStore.test.js`。

### T19-3：standingAuthorization.js（policy + isActionAuthorized）

- [ ] **Step 1（红）**：`test/authorization/standingAuthorization.test.js`。
- [ ] **Step 2（绿）**：`src/authorization/standingAuthorization.js`：
  - `loadGrantsPolicy(tenantId)` → `readConfig('standing-grants-policy',{tenantId})?.value` 与默认值深合（`default_tier:'T1'`、`allow_tier_upgrade_by_ai:false`、`auto_pause_on_consecutive_rejects:3`、`max_daily_executions:null`、`notify_on_execution:true`）。
  - `isActionAuthorized({tenantId, action, fields, query})`：
    - `const grant = await resolveActiveGrant({tenantId, action, fields, query})`；
    - **T3 永久不可**：`T3_ACTIONS = ['crm-send-email','crm-deal-advance-to-s7','crm-deal-advance-to-s8',...]`（外发/阶段推进 S7/S8）命中即 `{authorized:false, reason:'T3 actions are never standing-authorizable'}`；
    - 无活跃凭证 → `{authorized:false, reason:'no-active-grant'}`；
    - 字段越界（fields 超出 field_whitelist）→ `{authorized:false, reason:'field-out-of-whitelist'}`；
    - 否则 `{authorized:true, grant}`。
  - `executeUnderGrant({tenantId, grant, scenarioId, actionName, targetId, fields, beforeState, execFn, query, queryWrite})`：
    - 调 `createDecision({scenario_id:scenarioId, decider_type:'STANDING_AUTH', grant_ref:grant.grant_id, autonomy_level:grant.risk_tier, business_tier:'NORMAL', disposition:'APPROVE', state:'AUTONOMOUS', trigger_context:{action:actionName, fields}, involved_entities:targetId?[{type:'PARTICLE',id:targetId}]:[], rationale:'常驻授权自动执行', tenantId})`；
    - `const afterState = await execFn()`；
    - `await recordExecution({tenantId, grantId:grant.grant_id, actionName, targetId, beforeState, afterState, decisionId:decision.decision_id})`；
    - 返回 `{decision, execution}`。
- [ ] **Step 3**：重跑 → 绿。提交：`src/authorization/standingAuthorization.js test/authorization/standingAuthorization.test.js`。

### T19-4：grantSweeper.js（过期 + 连续否决暂停）

- [ ] **Step 1（红）**：`test/authorization/grantSweeper.test.js`。
- [ ] **Step 2（绿）**：`src/authorization/grantSweeper.js` 导出 `createGrantSweeper({query, queryWrite, grantStore, policyLoader})` → `{sweepOnce}`：
  - 过期：`UPDATE crm.standing_grant SET status='expired' WHERE status='active' AND expires_at IS NOT NULL AND expires_at < now()`；
  - 连续否决：`policy.auto_pause_on_consecutive_rejects` 为 N；查 `grant_execution` 每 grant 最近 N 条 `hitl_verdict` 连续 `rejected` → `pauseGrant`。
  - `sweepOnce` 返回 `{expired:int, paused:int}`。
- [ ] **Step 3**：重跑 → 绿。提交：`src/authorization/grantSweeper.js test/authorization/grantSweeper.test.js`。

### T19-5：定时器⑮（grant-sweep）

- [ ] `src/scheduler/timers.js` 在 `ensureTimers` 注册 `setInterval(sweepOnce, 3600000)`（VITEST 护栏跳过真写）；`timers.set('grant-sweep',{...})`。
- [ ] 更新 `test/timers.test.js` `EXPECTED_TIMERS` 14→15（基线注释同步）。
- [ ] 提交：`src/scheduler/timers.js test/timers.test.js`。

### T19-6：autonomyEngine B/C 轴接线

- [ ] **Step 1（红）**：`test/decision/autonomyStandingGate.test.js`：`requireDecision` 在 `opts.standingAction` 提供且命中活跃 T1 凭证时仍自主；未命中 → 升级（fail-closed）。
- [ ] **Step 2（绿）**：`src/decision/autonomyEngine.js`：
  - 引入 `isActionAuthorized`（动态 import 防环）。
  - 在 `const escalated = ...` 之后追加：`if (!escalated && opts.standingAction) { const az = await isActionAuthorized({tenantId:tenant, action:opts.standingAction, fields:opts.standingFields||[], query}); if (!az.authorized) escalated = true; }`（**opt-in**：既有调用方不传 `standingAction` → 行为不变）。
- [ ] **Step 3**：重跑 → 绿。提交：`src/decision/autonomyEngine.js test/decision/autonomyStandingGate.test.js`。

### T19-7：HTTP 端点（凭证 CRUD，须 decision_id 凭据）

- [ ] **Step 1（红）**：`test/http/standingGrants.test.js`：缺 `decision_id` → 拒绝（400）；带 `decision_id` → 创建并落库；revoke → `revoked_at` 非空；list 租户隔离。
- [ ] **Step 2（绿）**：`src/http/routes.js` 既有 signals 块内追加（复用 `resolveMe`/`scopeOf(me)`）：
  - `GET /api/standing-grants` → `listGrants(scopeOf(me))`。
  - `POST /api/standing-grants` → 校验 `body.decision_id` 非空（否则 400，溯源铁律：凭证须经审批流批准）；`riskTier` 仅允许 `T0/T1`（拒绝 T2/T3）；`createGrant({tenantId:scopeOf(me), ...body, approvedBy:me.username, decisionId:body.decision_id})`。
  - `POST /api/standing-grants/:id/revoke` → `revokeGrant(scopeOf(me), id, body.reason)`。
- [ ] **Step 3**：重跑 → 绿。提交：`src/http/routes.js test/http/standingGrants.test.js`。

### T19-8：hitl_verdict 回写（J2 闭环）+ 连续否决自动暂停

- [ ] **Step 1（红）**：`test/http/standingGrants.test.js` 追加：POST `/api/grant-executions/:id/verdict` 带 `adopted` → `grant_execution.hitl_verdict='adopted'` 且 `decision_outcome` 落行（J2）；带 `rejected` → 计入连续否决，达阈值自动 `pauseGrant`。
- [ ] **Step 2（绿）**：`src/http/routes.js` 追加：
  - `POST /api/grant-executions/:id/verdict` → 更新 `hitl_verdict` + `rejected_at`（若 rejected）；`writeOutcome({tenantId, decisionId:execution.decision_id, outcome: verdict==='adopted'?'approved':'rejected', type:'other'})`（复用 src/decision/outcome.js，J2 闭环）；若 `rejected` 且连续否决达 `policy.auto_pause_on_consecutive_rejects` → `pauseGrant` + `emit('trace',...)`。
- [ ] **Step 3**：重跑 → 绿。提交：`src/http/routes.js test/http/standingGrants.test.js`。

## 4. 契约验收矩阵（T19 success 逐条）

| # | 契约判据 | 验证方式 |
| --- | --- | --- |
| 1 | 凭证须经审批流批准（`decision_id` 非空）方可 active | T19-7 红：缺 decision_id → 400 |
| 2 | 白名单外字段写入被拒且留痕 | T19-3 `isActionAuthorized` 字段越界 → 拒；T19-2/8 留 `grant_execution` |
| 3 | 超出 `max_uses`/`period` 自动 paused | T19-2 `recordExecution` 用量熔断单测 |
| 4 | tier 无任何自动提升路径（T2/T3 无凭证时被拒） | T19-3 T3 动作显式拒绝；创建端点拒 T2/T3 |
| 5 | 执行仍 mint 决策（`actor='standing-auth'`+`grant_ref`） | T19-3 `executeUnderGrant` 单测断言 decision 含 grant_ref/decider_type |
| 6 | 执行留前后快照 | T19-3 断言 `grant_execution.before_state/after_state` |
| 7 | hitl_verdict 回写 decision.outcome（J2） | T19-8 单测 |
| 8 | 连续 rejected 达阈值自动 paused + trace | T19-4/8 单测 |
| 9 | 撤回/到期/熔断全为状态变更，零 DELETE | grep 守护：本模块无 `DELETE FROM crm.standing_grant` |

## 5. 红线（违反即失败）

- **零 DELETE**：`revokeGrant`/`pauseGrant`/`expire` 全为 `UPDATE` 状态字段；`grep -n "DELETE FROM crm.standing_grant\|DELETE FROM crm.grant_execution"` 须零命中。
- **第 0 闸**：凭证创建强制 `decision_id`；执行 mint 决策带 `grant_ref`；`writeOutcome` 复用既有第 0 闸。
- **config 100% 后台化**：`standing-grants-policy` 字段（`default_tier`/`allow_tier_upgrade_by_ai`/`auto_pause_on_consecutive_rejects`/`max_daily_executions`/`notify_on_execution`）全走 `config_store`，代码内禁硬编码字面量（除 policy 默认值合并兜底）。
- **租户隔离**：所有查询带 `tenant_id`；端点用 `scopeOf(me)`。
- **建表单一事实源**：DDL 入 `schema.sql` + 注册迁移；散落他处即违约。
- **T3 永久不可常驻授权**：代码层两道闸（创建端点拒 T2/T3 + `isActionAuthorized` 显式拒 T3 动作名）。
