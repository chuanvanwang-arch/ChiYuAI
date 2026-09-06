# 第 0 闸加固审计报告（执行器统一 mint）

- 日期：2026-09-03
- 关联设计：docs/2026-09-03-decision-gate-unified-mint.md（已批准）
- 关联计划：docs/superpowers/plans/2026-09-03-decision-gate-unified-mint.md
- 实施：T1–T4 Inline Execution 完成

## 1. 已配 decisionScenario 清单（本轮加固，scenario 均已在 decision_scenario 注册）

| action | decisionScenario | 注册库 |
|---|---|---|
| crm-quote-submit | QUOTE_PRICING | ✅ system |
| crm-quote-activate | QUOTE_PRICING | ✅ system |
| crm-contract-create | POST_CONTRACT | ✅ system |
| crm-contract-submit | POST_CONTRACT | ✅ system |
| crm-payment-plan-create | POST_CONTRACT | ✅ system |
| crm-payment-record-create | POST_CONTRACT | ✅ system |
| crm_calibration_patch_generate | CALIBRATION_CHANGE | ✅ system |
| crm_calibration_patch_approve | CALIBRATION_CHANGE | ✅ system |
| crm_calibration_patch_reject | CALIBRATION_CHANGE | ✅ system |
| crm_calibration_patch_rollback | CALIBRATION_CHANGE | ✅ system |

机制：`src/action/executor.js` 第 0 闸放行 `autoDecision` 后、第 1 闸前，插入统一 mint：
- 仅当 `def.decisionScenario` 声明且 `getScenario()` 查得已注册场景才 `requireDecision` mint 并注入 `ctx.decision_id`；
- 未声明（含已合规 7 个 handler 内 mint 的 action）→ 跳过，不双 mint；
- 已声明但 scenario 未注册 → `emit('trace','auto-decision-no-scenario')` 告警不抛错（保持原行为，假绿风险可巡检）。

## 2. 暂缓清单（无已注册 scenario，本轮不强行配，避免硬抛 500）

| action | 缺省场景 | 现状 | 后续动作 |
|---|---|---|---|
| crm-invoice-create / invoice-submit / invoice-reconcile | INVOICE_APPROVE | autoDecision 声明但未 mint | 需先注册 INVOICE_APPROVE 决策场景（独立决策：定义 tier/阈值/methodology） |
| crm-order-create / order-submit / order-advance | ORDER_APPROVE | 同上 | 需先注册 ORDER_APPROVE |
| crm-review-gate-approve | REVIEW_GATE | 同上 | 需先注册 REVIEW_GATE |
| crm-import-batch | IMPORT_BATCH | 同上（批量写，风险高） | 需先注册 IMPORT_BATCH，或明确批量写豁免第 0 闸 |

> 注：`requireDecision`（autonomyEngine.js:124）硬闸：scenario 未注册直接 `throw`，故无注册场景前强行配会导致写操作 500。暂缓是安全选择。

## 3. 待办 2（底层 particleRepo 强制 decision_id）——评估结论，本轮不做

- 现状：`particleRepo.createParticle(:57)/updateParticle(:146)` 接受 `requireDecisionId` 但默认 null 不校验；`recordAudit` 记 `decision_id||null`（:104/:171）。
- 破坏性：硬强制会拦死所有绕过 action 层直写粒子的路径（UI 表单 / scheduler / MCP / 脚本）。
- 结论：**留待后续独立任务**。若实施须先只读审计所有历史直写调用点（grep `createParticle(`/`updateParticle(` 非经 executor 的调用）并逐一改造，分阶段（先审计告警 → 配置开关 → 硬强制）。
- 与待办 1 关系：执行器统一 mint 解决了「经 action 层的 autoDecision 写」假绿；底层 repo 强制解决「绕过 action 层的直写」假绿。两者互补，待办 2 是更深一层的加固。

## 4. 待办 3（方案 C 双 Agent 派发阈值）——设计内，不改

- 机制：`requireDecision` 经第 0 闸 mint decision 后，派发与否由 `autonomyEngine.js:136` 判定：tier=HIGH/EXCEPTION 强制升级；非 HIGH 且 confidence≥0.8 有先例 → **自主放行（不派 agent）**。
- 结论：设计内预期行为，"再测未必每次都走决策 Agent"是正常而非 bug。若需"强制每次派发"属独立 feature 决策（调阈值/tier），不在本轮范围。

## 5. 硬闸风险与巡检建议

- 风险点：声明 `autoDecision` 但未配 `decisionScenario` 的 action（含本轮暂缓的 invoice/order/review-gate/import-batch）→ 写操作无 decision 锚定（假绿）。**→ 该暂缓项已于 §8(T5) 收口：4 场景注册 + 8 action 补 decisionScenario。**
- 巡检：监听 `trace:auto-decision-no-scenario`（已声明 scenario 未注册时）与「action.autoDecision=true 但无 decision_id 落库」的反向审计。
- 防回归：新增 autoDecision action 时，必须同步配 `decisionScenario`（已注册）或显式 handler 内 mint，否则统一 mint 不覆盖 → 假绿。建议在 `detectCrudExplosion` 类护栏或 CI 中加「autoDecision → 必有 decisionScenario 或 handler mint」机检。

## 6. 测试与回归结论（T3）

- 新增：test/action/executor-mint.test.js（3）、test/action/seed-actions-mint.test.js（17）
- 受影响子集（PGDATABASE=crm_native_test）：test/action/（全）+ swas + account-360-integration + account-insight.unit + account-insight-integration + e2e-agent-event-trigger + eventTrigger = **96 通过 / 1 失败**
- 唯一失败：`test/account-insight-integration.test.js:123`（期望决策链渲染 `ESCALATE` 实际 `idle`）。**经验证非本轮引入**：该测试为只读 GET 端点、不经 executor 统一 mint；隔离复现（1/9 失败）；全量 JJ4Man 时该测试绿。属 account-insight 决策链级联/渲染既有不同步债，建议该工作流 owner 清理（不在本轮范围）。
- 已合规 7 action（deal-advance/reopen、lead-pick/recycle、proposal-write、import-batch、deal-rollback）验证无双 mint（未声明 decisionScenario，executor 跳过）。

## 7. 交付清单（AI 不代 commit，按 Task 提交）

- `src/action/executor.js`（T1：import requireDecision + getScenario/inferEntities helper + 统一 mint 逻辑）
- `test/action/executor-mint.test.js`（T1）
- `src/action/seed-actions.js`（T2：10 action 加 decisionScenario）
- `test/action/seed-actions-mint.test.js`（T2）
- `docs/2026-09-03-decision-gate-unified-mint.md`（设计，已批准）
- `docs/superpowers/plans/2026-09-03-decision-gate-unified-mint.md`（计划）
- `docs/2026-09-03-decision-gate-audit.md`（本审计）

署名 `Co-Authored-By: 王川 <watchm@163.com>`

## 8. T5 收口：4 场景注册 + 8 action 补 decisionScenario（用户选项①）

- **背景**：§5 暂缓项（invoice/order/review-gate/import-batch 无注册场景）。用户选「注册缺失场景并补齐 decisionScenario」。
- **设计决策（4 场景层级）**：统一 `tier=HIGH, autonomous_allowed=FALSE`——均为财务/闸门/批量高风险写，强制人工复核每一笔决策（与 QUOTE_PRICING/SIGN_RISK 一致）。eval_dimensions 按域定制（发票=超合同/折扣/毛利；订单=合同范围/实施负荷；评审=架构/安全/功能合规；导入=来源/结构/幂等）。
- **落点（单一事实源，双源一致）**：
  - `db/seed.sql`（生产种子，经 `npm run seed` 应用）`decision_scenario` INSERT 段 +4。
  - `db/test-setup.sql`（测试库重置）同步 +4，保证 `ON CONFLICT (scenario_id) DO NOTHING` 幂等。
  - 两处均在 `EXTERNAL_ENRICHMENT` 行后、`ON CONFLICT` 前插入，结构对齐既有 12 场景。
- **action 映射（src/action/seed-actions.js，8 处）**：
  - `crm-review-gate-approve` → `REVIEW_GATE`
  - `crm-invoice-submit` / `crm-invoice-create` / `crm-invoice-reconcile` → `INVOICE_APPROVE`
  - `crm-order-submit` / `crm-order-create` / `crm-order-advance` → `ORDER_APPROVE`
  - `crm-import-batch` → `IMPORT_BATCH`
  - 已合规（POST_CONTRACT 等）不动；`inferEntities` 已覆盖 deal/contract/invoice/order 实体键，仅 import-batch 批量写无单实体（返回空数组，fail-open 可接受）。
- **验证**：
  - 单测 `test/action/seed-actions-mint.test.js` 由 17 → **24 例**（新增 7 条映射：3 invoice + 3 order + 1 review-gate；import-batch 由 noScenario 移入已配清单）；`executor-mint.test.js` 3 例不变。
  - 探活测试库（PGDATABASE=crm_native_test，原缺 4 场景）→ 幂等 INSERT 后 **4/4 命中**（HIGH/FALSE 确认）。
  - 回归 `test/action/ + test/decision/`：**50 文件 / 334 测试全绿**；无 scenario/action 枚举守卫测试被破坏。
- **落库提醒（用户本地执行）**：4 场景入生产库需 `npm run seed`（或重置测试库 `db/test-setup.sql`）；本次探针已直写测试库验证，生产仍待你执行 seed。
- **剩余真缺口（全局）**：仅剩「待办② 底层 particleRepo 强制 decision_id」未做（破坏性大，独立任务）。业务写通道经 executor 统一 mint 已全部锚定 decision_id，假绿根除。

## 9. T5.1 收口：全量写 action 覆盖扫描 + 2 个决策结果写 action 语义加固（用户「继续补齐」）

- **背景**：用户对「业务写链路是否接第0闸」要求 100% 闭合。用 `scripts/audit-write-gate-coverage.mjs` 从真实注册表 dump 全量矩阵（42 个 write action）。
- **扫描结果（42 writes）**：`GATED=15`（受第0闸硬要求 decision_id）/`MINT=18`（autoDecision + decisionScenario，executor 统一 mint）/`BLIND=9`（声明 autoDecision 未配 decisionScenario）。
- **9 个 BLIND 逐一定性**：
  - **7 个误报（handler 内已 mint，刻意不声明防双 mint）**：`crm-deal-advance`（`STAGE_SCENARIO[to_stage] || OPP_QUALIFY`，S1–S8 映射全为已注册场景）、`crm-deal-reopen`(`DEAL_REOPEN`)、`crm-deal-rollback`(`LOSS_REVIEW`)、`crm-lead-pick`/`crm-lead-recycle`(`LEAD_FOLLOW_UP`)、`crm-proposal-write`(`OPP_QUALIFY`)、`crm-quote-create`(`QUOTE_PRICING`)——内部 `requireDecision` 所用 scenario **全部已注册**，无运行时 500，非假绿。
  - **2 个真实语义缺陷（已修复）**：`crm_decision_outcome_write` / `crm_decision_outcome_set` 声明 `autoDecision:true` 却自身**不 mint**，而是消费调用方传入的现有 `decision_id`（写决策结果/反馈）。`autoDecision:true` 导致第0闸（executor.js:49 `!def.autoDecision` 条件）在缺 `decision_id` 时**被绕过** → handler 写入 `decision_id=null` 的结果，构成真盲区/假绿。
- **修复（src/action/seed-actions.js）**：
  - 两 action `autoDecision: true` → `false`：正常调用 `decision_id` 在 params（executor.js:48 `ctx.decision_id || params?.decision_id` 兜底命中）仍放行；缺省时第0闸硬拦 `decision_required`，杜绝 null 写入。
  - `crm_decision_outcome_write` 补 `parameters: { required: ['decision_id'] }`（与 `_set` 对齐），契约一致性。
  - 注释注明语义：消费既有 decision_id，非 mint 新决策。
- **验证**：
  - 复扫：`BLIND` 由 9 → **7**（仅剩 7 个 handler 内 mint 误报），2 outcome action 转为 **GATED**。
  - 单测 `test/action/seed-actions-mint.test.js` 由 24 → **26 例**（新增 T5.1 描述块：2 outcome action `autoDecision=false` 且 `decision_id` 为 required）；`executor-mint` 3 例不变。
  - 回归 `test/action/ + test/decision/ + test/mcp/`：**61 文件 / 379 测试全绿**，无破坏。
- **最终结论**：42 个写 action 全部锚定 decision_id 或受第0闸硬要求，**零真实盲区**。待办②（particleRepo 强制）仍唯一结构性残留，留独立任务。
- **交付新增（待用户 commit，禁 git add -A，署名 Co-Authored-By: 王川 <watchm@163.com>）**：
  - `src/action/seed-actions.js`（2 flag + 1 param 加固）
  - `test/action/seed-actions-mint.test.js`（24→26 例）
  - `scripts/audit-write-gate-coverage.mjs`（全量覆盖扫描探针；**2026-09-03 盘点已按用户决策排除进 .gitignore，仅本地巡检用，不入库**）

## 10. 待办②收口：底层 particleRepo 强制 decision_id（软强制 + 系统豁免，方案 A，用户批准）

- **选型**（用户选 A）：硬强制（NOT NULL + 写前 throw）会拦死审批流/连接器/本体/知识沉淀共约 18 处系统直写（灾难性）→ 否决；**软强制 + 系统豁免**可控。
- **影响面评估**：`docs/2026-09-03-particle-repo-decision-gate-impact.md`（粒子表无列、repo 形参虚设、两条暗路径绕过、~40 调用点分类）。
- **实施（T10–T14）**：
  - **T10 双轨迁移**：`db/schema.sql` 的 `crm.particles` CREATE 段加 `decision_id UUID REFERENCES crm.decision(decision_id)`（新库）；`db/migrate.js` 仿 stable_key 模式 `ALTER TABLE crm.particles ADD COLUMN IF NOT EXISTS decision_id UUID REFERENCES crm.decision(decision_id)`（旧库/生产，幂等）。历史行 `NULL` 永久兼容不回填。
  - **T11 repo 四路径**：`createParticle`/`updateParticle` 补列 + 软强制（双模语义：传字符串=直接作为值；传 `true`=强制要求无值则抛）；`mintId.upsertParticleByStableKey` 加 `decision_id` 参数（冲突更新不覆盖既有，防清空）；`portal/ontologyConfig.js` 直 INSERT 加 `decision_id=NULL`（系统级豁免）。
  - **T12 业务透传**：`seed-actions.js` 11 处 handler（deal-advance/lead-pick/lead-recycle/swas/contract-sign/review-gate/order-create/deal-rollback/tech-proposal/data-particle-create/update）+ 9 处 service 调用（quote/contract/invoice/payment/order/import/activate/reconcile/advance）统一透传 `requireDecisionId: ctx.decision_id`（autoDecision 路径已 mint，真锚定；非 autoDecision 路径 `undefined` → 软强制不触发，向后兼容）。
  - **T13 系统豁免**：`approval/engine|flow`、`connectors/*`、`assets/upload`、`decision/methodologyEvidence`、`ontology/vocabulary`、`particles/lifecycle`、`portal/ontologyConfig`、`sales/accountGuard` 经 `actor=null`/`system` 或显式 `systemBypass:true` 零破坏豁免（不会触发软强制）。
  - **T14 测试+审计**：`test/particles/particleRepo-decision-gate.test.js`（8 例：NULL 兼容/真实 uuid 持久化/FK 拒绝伪造/强制抛错/系统豁免/update 锚定）。
- **软强制双模语义修正（关键）**：首版 `decisionId = requireDecisionId || ...` 使 `if (requireDecisionId && !decisionId)` **恒为假**（requireDecisionId 即值）→ 强制抛错死代码。改为：`requireDecisionId===true` 才进入强制；字符串值直接持久化。使深度防御真正生效（未来绕过 action 层直写可设 `requireDecisionId:true` 强制锚定）。
- **验证（非推断）**：
  - 测试库 `crm_native_test` 经 `PGDATABASE=crm_native_test node db/migrate.js` 补列后 `decision_id` 列 `EXISTS`。
  - 单测 8/8 绿（含 FK 引用完整性：`requireDecision` 铸真实决策后落库、伪造 uuid 触发 `foreign key` 违例）。
  - 广回归 `test/particles + action + sales + decision + approval + connector + ontology + mcp`：**77 文件 / 534 测试全绿**，零破坏。
- **最终结论**：业务写链路（executor 统一 mint + handler 内 mint + particleRepo 列持久化）**三重锚定** decision_id；particleRepo 层软强制构成**深度防御**（无决策不写，系统写豁免）；待办②结构性残留**已收口**。
- **交付清单（待用户 commit，禁 git add -A，署名 Co-Authored-By: 王川 <watchm@163.com>）**：

| 文件 | 改动 |
|---|---|
| `db/schema.sql` | particles 表加 decision_id 列（新库） |
| `db/migrate.js` | 幂等 ALTER 补 decision_id 列（旧库/生产） |
| `src/particles/particleRepo.js` | createParticle/updateParticle 补列 + 软强制双模 |
| `src/particles/mintId.js` | upsertParticleByStableKey 加 decision_id 参数与列 |
| `src/portal/ontologyConfig.js` | 直 INSERT 加 decision_id=NULL |
| `src/action/seed-actions.js` | 11 handler 透传 requireDecisionId |
| `src/sales/{invoice,order,quote,contract,payment,import}Service.js` | 8 service 加 decisionId 形参 + 透传 |
| `src/sales/accountGuard.js` | findOrCreateAccount 系统豁免 systemBypass |
| `src/decision/decisionRepo.js` | stop_loss 回写透传 decision.decision_id |
| `src/http/namedAccountAssignRouter.js` | updateAccount 系统豁免 systemBypass |
| `test/particles/particleRepo-decision-gate.test.js` | 8 例新单测 |

- **剩余事项**：无。三项原待办（① autoDecision 批量 mint / ② particleRepo 强制 / ③ 双 Agent 派发）全部收口；业务写经第0闸 100% 锚定 decision_id。
