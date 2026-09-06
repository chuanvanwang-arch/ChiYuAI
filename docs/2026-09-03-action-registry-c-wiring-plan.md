# 实施计划：Action Registry 全量接线（C 方案）

> 日期：2026-09-03 | 作者：WorkBuddy | 状态：待用户批准
> 前置审计：`src/action/seed-actions.js`、`src/action/registry.js`、`src/http/routes.js`、`src/agent/agentSpec.js`、`src/mcp/tools.js` 静态交叉分析（脚本 `scripts/_c_audit.mjs` 复现）

## §0 背景与审计结论

MCP 暴露面由 `src/mcp/tools.js` 的 `buildMcpTools()` 遍历 `listActions()` **全量暴露（无过滤）**。注册表共 **74 个 action**（crm 56 + method 9 + data 6 + decision 2 + agent 1）。

静态交叉分析结论（证据：`scripts/_c_audit.mjs`）：

| 维度 | 数量 | 说明 |
|---|---|---|
| 注册 action 总数 | 74 | seed 66 + connector 3 + 动态 method 9 − 重叠 |
| MCP 实际暴露 | 74 | `buildMcpTools()` 无过滤 |
| agentSpec 授权闭包引用 | 19 | 4 个业务 agent + 2 个决策 agent 的 capabilities.actions/skillCalls 去重 |
| routes 真正走 `dispatch` 的 | 3 | `data-particle-create`(routes:530)、通用 `POST /api/actions/:name`(routes:2871)、`data-particle-update`(routes:2905) |
| 死表面（注册但零调用点） | 52 | 注册了、暴露了、但 agentSpec 不授权、routes 无专门端点（仅经通用 dispatch 入口可达，web 未触发） |

**根因（非 bug，架构错位）**：Action Registry 是 MCP/agent 的**契约面**，但不是运行系统的**执行契约**。web UI 的日常端点（如 account-360 页 routes:1325-1473）直接调底层函数 `loadDecisions/loadTimelineSources/buildMetrics/queryParticles`，**绕开 `actionExecutor.dispatch`**。

## §1 C 方案收敛定义（不字面"全量"）

字面全量接线（把 52 个死表面都补 routes 端点）**不可行也不必要**——其中大量是**引擎/审批流/MCP 客户端专用**（如 `crm-approval-*`、`crm_calibration_*`、`crm_decision_*`、`agent-dispatch`），本就不该被 web 调用。

务实收敛为 **"让注册表成为真实执行契约"** 三批：

- **P1 核心业务 action 接线（最高价值）**：为 agentSpec 已授权、但 web 无专门触发入口的业务 action 补 `routes` HTTP 端点，统一走 `actionExecutor.dispatch(name, body, ctx)`，获得统一鉴权 + HITL 闸。
- **P2 引擎/外部消费型 action 元数据正名**：给审批流/校准/决策/agent/ method 类 action 加 `lifecycle: 'engine'`，MCP 仍暴露但语义明确，消除"死表面"误判。
- **P3 孤儿 action 治理（零信任，不物理删）**：52 个死表面中，确无业务触发点的降级为 `lifecycle: 'reserved'`（默认）；**物理删除违反禁 DELETE 铁律，需逐条显式授权**，故不列入本计划自动执行项。

## §2 P1 详细设计（核心接线）

### §2.1 P1 清单（agentSpec 已授权、web 无端点的业务 action）

| action | handler 实现度（种子审计） | 接线动作 |
|---|---|---|
| `crm-deal-advance` | ✅ getParticle/requireDecision/advanceStage/updateParticle/startGradedApproval | 补 `POST /api/crm/deal/:id/advance` → dispatch |
| `crm-deal-reopen` | ✅ getParticle/requireDecision/reopenDeal | 补 `POST /api/crm/deal/:id/reopen` → dispatch |
| `crm-asset-attach` | ✅ getParticle/createEdge | 补 `POST /api/crm/asset/attach` → dispatch |
| `crm-review-gate-approve` | ✅ getParticle/updateParticle | 补 `POST /api/crm/review-gate/:id/approve` → dispatch |
| `crm-memory-upsert` | ✅ import/appendMemory | 补 `POST /api/crm/memory` → dispatch |
| `crm-account-360` | ⚠ 仅 getParticle/queryNeighbors，**与 web 聚合页不一致** | 见 §2.2 对齐 |

> `method-*` 9 个不在 seed 静态注册（method engine 动态接管，对应 skill 无 steps[]），不在 P1 范围，归 P2 标 `engine`。

### §2.2 `crm-account-360` 一致性收口（关键）

现状不一致：
- **action handler**（`seed-actions.js` `crm-account-360`）：仅 `getParticle` + `queryNeighbors` —— 轻量版，不含决策链/时间线/指标。
- **web 聚合页**（`routes.js:1325-1473`）：调 `loadRelatedParticles/loadTimelineSources/loadDecisions/loadDecisionTrace/buildMetrics/applyScopeFilter/maskMetricsByPerm` 全家桶。

收口方案（二选一，建议 B）：
- **A**：action handler 扩充为调用 `insightService` 全家桶，返回与 web 页一致的数据；web 页改为 `dispatch('crm-account-360')`。收益：单一契约。风险：handler 需复刻聚合逻辑，回归面大。
- **B（推荐）**：保持 web 聚合页直调（页面级编排本就不该是单 action），但 `crm-account-360` action 明确标 `lifecycle: 'engine'`/保留为 agent 视角的轻量"取账户+邻居"语义，**在 SKILL/文档中澄清两套语义并存**，不强行合并。避免为"接线"而破坏已验证的聚合页。

### §2.3 端点实现模板（统一契约）

每个 P1 端点遵循：
```js
router.post('/api/crm/deal/:id/advance', requireAuth, async (req, res) => {
  const ctx = { actor: await resolveActor(me.username), tenantId: scopeTenant(me) };
  const r = await actionExecutor.dispatch('crm-deal-advance', { id: req.params.id, ...req.body }, ctx);
  // dispatch 内部已含 requireDecision + 权限 + HITL；失败时返回结构化错误
  return res.json(r);
});
```
复用 routes:530 / routes:2905 已有的 dispatch 调用范式，保证鉴权/HITL 一致。

## §3 P2 / P3 详细设计

### §3.1 P2 引擎型元数据（lifecycle: 'engine'）

在 `registerAction({...})` 增加可选字段 `lifecycle`（默认 `'active'`）。`buildMcpTools()` 读取后：
- `'engine'`：MCP 仍暴露，但 tool.description 前缀 `[引擎]` 标注，表明由审批流/校准/决策/agent 框架内部触发。
- 涉及 action（审计清单）：
  - 审批流：`crm-approval-flow-define/start/approve/withdraw/transfer/add-sign`
  - 校准：`crm_calibration_patches/metrics/patch_generate/patch_approve/patch_reject/patch_rollback`
  - 决策：`crm_decision_*/decision-disposition/crm_graph_query/crm_gate_outcome/crm_root_cause_list`
  - agent：`agent-dispatch`
  - method：`method-*`（9 个，动态注册处同步加）

### §3.3 P3 孤儿降级（零信任，reserved）

52 个死表面中，除 P2 引擎型外，剩余（如 `crm-quote-create/submit/activate`、`crm-contract-create/submit`、`crm-invoice-create/submit/reconcile`、`crm-order-create/submit/advance`、`crm-payment-plan-create/record-create`、`crm-lead-pick/recycle`、`crm-proposal-write`、`crm-customer-360`（与 account-360 疑似重复）、`crm-cross-entity-query`、`crm-finance-receivables`、`crm-import-batch`、`crm-deal-rollback`、`crm-deal-swas-update`、`crm-funnel-classify`、`crm-behavior-check`、`crm-stage-progression-evaluate`、`crm-review-gate-evaluate`、`crm-followup-schedule`、`crm-field-permission`）——

默认全部标 `lifecycle: 'reserved'`（MCP 暴露但标注"暂未接线"），**不物理删除**（遵守禁 DELETE 铁律）。`crm-customer-360` 与 `crm-account-360` 重复嫌疑单独立项核对（可能合并）。

`buildMcpTools()` 对 `reserved` 可在 description 加 `[reserved]` 前缀，供前端/MCP 客户端识别。

## §4 专家包 / SKILL / MCP 联动（用户原问）

| 组件 | 是否需更新 | 动作 |
|---|---|---|
| **MCP** | 暴露机制不改；补 `lifecycle` 标注 | `src/mcp/tools.js` 读取 lifecycle 加描述前缀 |
| **SKILL** | 12 个 SKILL.md 的 Action 清单 ⊆ 注册表（`skills-action-mapping.test.js` 锁死），本身没坏；P1/P2/P3 改动注册表后 **必须同步**这些清单 | 改完跑 `skills-action-mapping.test.js` |
| **专家包** `plugin/openclaw.plugin.json` v1.3.0 | 暂不动（列 16 skill 磁盘齐全）；若后续改 skill 名才同步 | — |

## §5 风险与回滚

- **风险1**：P1 端点与现有 web 直调逻辑重复 → 用 §2.3 统一范式复用，不复制业务逻辑。
- **风险2**：`crm-account-360` 语义分裂 → 走 §2.2 B（不合并），文档澄清。
- **风险3**：`lifecycle` 字段未读 → registry/dispatch 缺省 `'active'`，不影响现有行为（向后兼容）。
- **回滚**：每 Task 一 commit；若某端点引入回归，`git revert` 单文件即可。

## §6 测试与验收

- 新增 `test/action-registry-wiring.test.js`：断言 P1 六个 action 经 `POST /api/actions/:name` 与新增语义端点均能 dispatch 成功（用已授权 agent/test token）。
- `skills-action-mapping.test.js` 必须仍绿（SKILL 清单同步后）。
- `scripts/_c_audit.mjs` 改造为 `lifecycle` 巡检：断言无 `active` 却零调用的孤儿（除 engine/reserved 外）。
- 手工 E2E：admin 登录后 `POST /api/crm/deal/:id/advance` 真实推进一个商机，确认 decision_id 写入（零信任 HITL 触发）。

## §7 任务拆分（每 Task 一 commit）

- **T1**：registry/seed 增加 `lifecycle` 字段 + `listActions` 透传；`buildMcpTools` 读取加描述前缀。回归 `skills-action-mapping.test.js`。
- **T2**：P2 引擎型 `lifecycle: 'engine'` 标注（审批流/校准/决策/agent/method 共 ~21 个）。
- **T3**：P1 六个业务 action 补 routes 端点（§2.3 范式）。含 `crm-account-360` 按 §2.2 B 收敛。
- **T4**：P3 孤儿 `lifecycle: 'reserved'` 标注（~31 个，排除已标 engine + account-360 已处理）。
- **T5**：`crm-customer-360` vs `crm-account-360` 重复核对（立项，不自动删）。
- **T6**：审计脚本改造为 lifecycle 巡检 + 新增 wiring 测试 + 全量回归。

## §8 需用户决策的点

1. **§2.2 `crm-account-360` 收口**：A（合并到 dispatch，回归面大）/ B（保留两套语义，推荐）。
2. **P3 物理删除**：默认 reserved 降级（不删）；若坚持清理`crm-customer-360` 等重复项，需逐条显式授权（违反禁 DELETE 铁律的"代码删除"仍需你确认）。
3. **T3 是否同时让 web 聚合页改调 dispatch**：建议否（页面编排保持直调，见 §2.2 B）。

## §9 2026-09-03 后续决策：MCP 暴露面按方案 A 过滤 reserved

- **用户拍板（A）**：MCP 暴露面按 lifecycle 收敛——**隐藏 `reserved` 死表面，保留 `active` + `engine`**；注册表全量 74 保留不删（禁 DELETE 铁律，仅收暴露层）。
- **实现**：`src/mcp/tools.js:43` 由 `const all = listActions();` 改为 `listActions().filter(a => a.lifecycle !== 'reserved')`；read/write/read_sensitive 三循环自动收敛；`[引擎]`/`[reserved]` 描述前缀保留（reserved 已不进暴露集，前缀仅 engine 生效）。
- **效果**：注册 74（engine 31 / reserved 30 / active 13）→ **MCP 暴露 41**（+crm_login=42），较原 ~70 收敛约 30 个死表面。
- **回归**：`test/mcp/tools.test.js` 新增 3 例（reserved 不暴露 / active+engine 仍暴露 / 暴露数<注册数）。
- **不改动 §4 语义**：机制仍遍历 `listActions()` 全量，仅加 lifecycle 过滤层；reserved 物理删除仍不被允许。
