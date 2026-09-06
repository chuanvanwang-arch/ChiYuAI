# 套餐闸门修复设计（2026-09-06）

## §0 结论

套餐的三道闸门（功能模块 / Token / 席位）**机制上按租户解析，但 Token 闸实际不生效，功能模块闸存在三处"缺租户即放行 system"的兜底**。本设计修复 5 项缺陷，策略已由用户拍板：**LLM 调用缺 tenantId 时记 system + 告警，不阻断**（选 B）。

## §1 现状盘点（代码级证据）

### 1.1 Token 计量/预检覆盖

| 出口 | 位置 | 是否计量 | 是否预检 |
|---|---|---|---|
| `callChat` | `src/llm/client.js:143-144` | 仅 `if (metering && metering.tenantId)` | 同条件 |
| `embed` | `src/llm/embeddingClient.js:31-32` | 同上 | 同条件 |
| `getLlmThink` → `llmThink` | `src/agent/agentLoop.js:72-73` | ✅ 唯一传了 `tenantId` 的调用 | ✅ |
| `embedText`（决策向量化） | `src/knowledge/embed.js:23` → `src/decision/decisionRepo.js:154/528/550` | ❌ 未传 metering | ❌ |
| Action 级计量 | `src/action/executor.js:201-208` | ⚠ 写库但 `tokensIn/Out` 恒 0 | ❌ |

实况数据：
- 本地 `crm.token_accounting`：`system` 104 条 / 10253 token；`acme-chem` 18 条 **tok=0**
- 生产 `crm.token_accounting`：**0 行**（从未计量）

### 1.2 缺租户兜底（绕过口子）

| 位置 | 代码 | 后果 |
|---|---|---|
| `src/action/executor.js:98` | `resolveEntitlements(ctx.tenantId \|\| 'system')` | 缺 tenantId → system 全权益，绕过第 1.7 闸 |
| `src/http/routes.js:3088` | `p1Ctx`: `tenantId: me.tenantId \|\| 'system'` | 登录态缺租户 → system |
| `src/mcp/auth.js:83` | `buildMcpCtx`: `tenantId: explicitTenantId = 'system'` | MCP 未显式传租户 → system |

### 1.3 权益门禁覆盖

- 声明 `requiresEntitlement` 的 Action：**14 个**（approval_flow×7 / customer_360×2 / advanced_reporting×2 / event_automation×1 / decision_autonomy×1 / ai_agents×1）
- Action 总量：**59**（含 `data-particle-*` substrate 与 `admin-*` 平台管理）
- 实况：`crm.tenants.plan` 生产 3 租户（system / jiadian / co-1b1fqe1）**全 NULL** → 回退 `billing-settings.default_plan='free'`

## §2 决策点（已拍板）

**Q：LLM 调用缺 tenantId 时如何处理？→ B（记 system + 告警，不阻断）**
- 理由：不打断任何存量链路；代价是 system 恒豁免，漏传调用仍不计入租户额度——故必须**告警可观测**（emit trace），作为后续收敛的抓手。

## §3 P0-1：Token 计量/预检下沉到 LLM 出口

**目标**：每次 LLM/Embedding 调用都计量、都预检；缺租户不阻断但留痕。

改动：
1. `src/llm/client.js:143` 与 `src/llm/embeddingClient.js:31`
   - 预检与计量从 `if (metering && metering.tenantId)` 改为**无条件执行**
   - `tenantId = metering?.tenantId ?? null`；为 null 时：
     - `emit('trace','llm-metering-missing-tenant', { action, source, channel })` 告警
     - 按 `system` 计量（system 租户恒不限额，不阻断）
2. `src/knowledge/embed.js` / `src/ontology/embedding.js`：透传 `metering`（`embedText(text, { metering })`），使决策向量化路径纳入计量
3. `src/decision/decisionRepo.js:154/528/550`：`embedText(..., { metering: { tenantId, actor, action } })`（决策域已有 tenantId 上下文）

## §4 P0-2：Action 计量回填真实 token

**问题**：`executor.js:201` 的 `ctx.tokensIn/Out` 调用方不提供 → 恒 0。

**方案**：`callChat` 返回结构扩展为 `{ text, usage }`（向后兼容：默认仍返回字符串，新增 `callChatWithUsage` 或在 opts 传 `returnUsage:true`）；
- `getLlmThink`/`llmThink` 内部累积 usage，通过 `metering.onUsage({in,out})` 回调回传
- Action 执行处（`executor.js:201`）改为由调用链回填：优先 `ctx.tokensIn/Out`，缺省取本轮 LLM 累积值
- 保持 fail-open：计量失败不阻断主写

## §5 P1-1：去掉三处 `|| 'system'` 兜底

原则：**显式 system 允许（平台内部身份），缺失必须可识别并 fail-closed**。

1. `src/mcp/auth.js:83`：`tenantId` 缺省值 `system` 保留，但新增 `tenantIdExplicit` 标记（显式传入=true）
2. `src/http/routes.js:3088` `p1Ctx`：`tenantId: me.tenantId ?? null`（不再兜底），`tenantIdExplicit: !!me.tenantId`
3. `src/action/executor.js:95-105`：
   - `def.requiresEntitlement` 非空且 `ctx.tenantId` 缺失（null/undefined）→ **拒绝执行**，`gate:'plan_entitlement_missing_tenant'`，emit trace
   - `ctx.tenantId === 'system'`（显式平台身份）→ 维持全权益放行

风险与前置：需确认所有 dispatch 调用点（11 处）ctx 都带 tenantId。已知 `p1Ctx`（routes.js:3088）与 `buildMcpCtx`（auth.js:83）覆盖主要通道；`skills/registry.js:81/91`、`connectorRouter.js:22` 需核查并补齐。

## §6 P1-2：给生产租户配档位

生产 3 租户 `plan` 全 NULL → 免费档。需设定：

| 租户 | 现状 | 建议 |
|---|---|---|
| `system` | NULL | 保持 NULL/按 system 豁免（不建议设档） |
| `jiadian` | NULL | 待用户指定 |
| `co-1b1fqe1` | NULL | 待用户指定 |

⚠ 属生产写操作，需用户显式指定档位后执行（不擅自改）。

## §7 P2：扩充 requiresEntitlement 覆盖

映射原则（substrate 与平台管理不加门禁，避免全租户不可用）：

| 权益键 | 覆盖 Action |
|---|---|
| `core_crm` | crm-contract-create/submit/expiring、crm-order-create/submit/advance、crm-invoice-create/submit/reconcile、crm-quote-create/estimate/submit/activate、crm-proposal-write、crm-followup-schedule、crm-import-batch、crm-lead-pick/recycle、crm-deal-advance/reopen/rollback/swas-update、crm-asset-attach |
| `ai_agents` | agent-dispatch、crm-knowledge-upsert、crm-cross-entity-query |
| `customer_360` | crm-account-360、crm-customer-360 |
| `decision_autonomy` | decision-disposition、crm-review-gate-evaluate/approve、crm-stage-progression-evaluate |
| `event_automation` | crm-followup-schedule（如归属事件域，二选一） |
| `approval_flow` | crm-approval-add-sign/approve/flow-define/start/transfer/withdraw |
| `advanced_reporting` | crm-finance-receivables、admin-tenant-usage、crm-funnel-classify |
| `audit_provenance` | decision-retrospective、admin-decision-health |
| `rbac_advanced` | crm-field-permission |
| `memory` | crm-memory-read/upsert |
| `mcp_access` | MCP 通道整体（在 gateway 层校验，不逐 Action 声明） |
| `industry_config` | admin-param-diagnosis（配置面，RBAC 已控，可不声明） |
| data-particle-* | 不加（substrate 基础能力） |
| admin-* | 不加（sys-admin RBAC 已控） |

同步：`src/billing/planSchema.js` `KNOWN_ENTITLEMENTS` 与守护测试 `test/billing/planSchema.test.js`（解析 seed-actions 防漂移）需同步。

## §8 风险与回滚

| 风险 | 缓解 |
|---|---|
| P1-1 fail-closed 打断存量调用 | 先全量核查 dispatch 调用点并补齐 tenantId；本地全链路验证后再上生产 |
| P2 门禁过严导致租户功能不可用 | 生产租户 plan 多为 NULL（免费档）→ 扩充门禁后会大面积拦截，**必须先完成 P1-2 配档位再上线 P2** |
| Token 计量开闸后用量激增 | 生产 token_accounting 0 行，开闸后开始累积；预检为 block 模式的档位可能在首个计费周期被封顶 → 上线前复核各档 `token_overage_mode` |
| 回滚 | 全部改动为代码级 + 配置级，无 DDL；git revert 即可 |

## §9 验证计划

1. 单测：`test/billing/planSchema.test.js`（权益白名单防漂移）+ 新增 Token 计量用例
2. 本地手验：触发一次 LLM 调用 → 确认 `crm.token_accounting` 落真实 token 且 tenant_id 正确
3. 本地手验：缺 tenantId 调用 → 确认 emit trace 告警且不阻断
4. 本地手验：缺 tenantId 的受门禁 Action → 确认被拒（gate=plan_entitlement_missing_tenant）
5. 全量回归（~2612 例，允许已知 flaky）
6. 生产：本地通过后 hotfix/release

## §10 实施顺序（依赖驱动）

P0-1 → P0-2 → P1-1（含调用点补齐）→ **P1-2 配档位（需用户指定）** → P2（依赖 P1-2）→ 验证 → 生产
