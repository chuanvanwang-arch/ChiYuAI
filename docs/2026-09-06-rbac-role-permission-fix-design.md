# RBAC 角色权限修复设计（sysadmin / ten_admin）

- 设计日期：2026-09-06
- 作者：企业AI销售决策专家（设计态）
- 依据：2026-09-04 审计（F1–F6）+ 2026-09-06 代码复勘
- 流程：brainstorming（本文件）→ writing-plans → 实施 → 单元/E2E 测试 → 审计设计
- 关联文档：docs/2026-09-04-sysadmin-role-tenant-attribution-design.md、docs/2026-09-04-param-propagation-hub-design.md §15

---

## §0 结论摘要

1. **`ten_admin` 存在确证的跨租户写越权（F1，高危）**：`scope.js` 的 `enforceScope` 不识别 `data_scope.model='tenant'`，对 `ten_admin` 直接返回 `{ok:true}`；且 `particleRepo.updateParticle` / `createEdge` 按 `id` 写、无 `tenant_id` 校验。结果：`ten_admin`（含经 MCP 的 AI 写通道）可改写**任意租户**的商机/客户/合同/粒子。读路径因 `queryParticles` 强制 `tenantId` 过滤仍安全，但**写路径裸奔**。
2. **传播中枢（F2）配置中心 UI 闸已修复，但写 API 仍有残留越权**：复勘确认 `LEVEL_ROLE_MAP`（middleware/rbac.js:80）与 `LEVEL_GROUPS`（configCenter.js:82）已将 `propagation → ADMIN`，故配置中心入口已 ADMIN-only；但 `propagationRoutes.js:gateAccept` 对 `memory_promote` 仅要求 `TENANT_LEVEL_ROLES`，`ten_admin` 可将本租户记忆上行推广至 `system`（违反 §15.5「上下贯通仅 ADMIN」）。
3. **用户管理（F3，中危）配置元数据自相矛盾**：`configCenter.js` id12 `level='system'` 使全局 `createConfigLevelGate`（routes.js:179）对 `sysadmin` 返回 403，而 `userManagement.js` 的 router 放行 `sysadmin`——`sysadmin` 实际无法管理用户，与其角色定位冲突。
4. **`sysadmin` 数据范围过宽（F4）属设计决议项**，非代码缺陷：其 `data_scope='all'` + 可领 MCP token，权限面大于配置中心可达面，需用户拍板（见 §7）。
5. **F5（UI 不一致）/ F6（标签漂移 + 历史伪隔离复测）为清理项**。

**修复优先级**：F1（必修，最小改动）→ F2（必修，关残留）→ F3（必改，消除矛盾）→ F4（设计裁决）→ F5/F6（清理）。

---

## §1 角色权限范围权威定义

平台为三层角色模型（设计 §D5）。下表为代码实际执行口径（`roleProfiles.js` + `tenantScope.js` + `configRouter.js` + `mcp/auth.js`）：

| 角色 | 定位 | `data_scope.model` | 租户读作用域 | 配置中心可达（§15） | MCP 写 token |
|---|---|---|---|---|---|
| `admin` | 平台超级管理员 | `all`（FK 约束，未落入 profile） | `*` 跨租户（tenantScope.js:5） | system + tenant + propagation 全开 | **禁止**领取（mcp/auth.js:126 仅拦 admin） |
| `sysadmin` | 平台运营 / 租户治理（跨租户） | `all`（roleProfiles.js:24） | `*` 跨租户 | 仅 **tenant** 级（system/propagation 仅 ADMIN） | **可领取** |
| `ten_admin` | 租户管理员（仅本租户） | `tenant`（roleProfiles.js:25） | 自身租户 | 仅 **tenant** 级；system 级 403 | **可领取** |

**`sysadmin` 权威权限（按代码）**
- 租户治理：建/列租户（tenantRouter.js:16 闸 `admin||sysadmin`）；新租户须 `sysadmin` 作推荐者（selfRegister.js:109-118）。
- 用户管理：`userManagement.js` 各写端点闸 `admin||sysadmin`（但被 F3 全局闸拦截，见 §3.3）。
- 业务数据：`data_scope='all'` → `enforceScope` 放通（scope.js:83），可读写全部租户商机/客户/合同/回款。
- 配置：tenant 级配置项（阈值/计费/审批流等）可改；system/propagation 配置不可触达。

**`ten_admin` 权威权限（按代码，设计意图 = 仅本租户）**
- 本租户用户管理：`userManagement.js:285-291` 强制本租户 + 禁止分配/编辑 `admin`/`sysadmin`。
- 自助注册：新租户首注册者 = `ten_admin`（selfRegister.js:124）。
- tenant 级配置：可改本租户阈值/计费（salesThresholdsRouter.js、billingRoutes.js 含 `ten_admin`）。
- **设计意图**：仅本租户业务数据读写。但 `enforceScope` 对 `tenant` 模型空实现（F1）。

---

## §2 审计发现复盘（现状）

| # | 级别 | 发现 | 证据 | 现状（2026-09-06 复勘） |
|---|---|---|---|---|
| F1 | 高 | `ten_admin` 写操作跨租户越权 | scope.js:81-110（`tenant` 无分支→`ok:true`）；particleRepo.js:210（`UPDATE … WHERE id=$4` 无租户条件）；isParticleScoped 含 data-particle-update/crm-deal-advance/crm-proposal-write/data-particle-edge-create | **仍敞开，必修** |
| F2 | 高 | 传播中枢对 `ten_admin`/`sysadmin` 开放 | configCenter.js:42（level=propagation）；原称 LEVEL_ROLE_MAP 归 tenant | **UI 闸已 ADMIN-only（已修复）**；**写 API `memory_promote` 仍残留**（propagationRoutes.js:198-202） |
| F3 | 中 | 用户管理 id12 `level='system'` 与 router 矛盾 | configCenter.js:13 vs routes.js:179 全局闸 vs userManagement.js:226 | **仍矛盾，必改** |
| F4 | 中 | `sysadmin` 数据权限过宽且不对称 | roleProfiles.js:24；mcp/auth.js:126；scope.js:83 | **设计决议项，非缺陷** |
| F5 | 低 | UI 不一致：头像下拉仅 admin 显配置中心 | layout.js:33 vs layoutMenu.js:31 | **仍不一致，清理** |
| F6 | 信息 | 配置项 level/scope 标签漂移 + 历史伪隔离 | configCenter.js id35/36/39/44；businessTier.js | **需复测确认** |

---

## §3 修复设计

### §3.1 F1（高危）— `ten_admin` 跨租户写越权

**根因**：`enforceScope` 仅处理 `all/self/org_subtree/domain`，`model==='tenant'` 落到 line 109 `return {ok:true}`；且 `updateParticle`/`createEdge` 按 `id` 写无租户校验。

**改动 1 — `scope.js` 增加 `tenant` 分支（主控制，executor 第1闸，覆盖 API + MCP/AI 写通道）**

`resolveTargetOwner`（scope.js:63-75）扩展返回 `tenant_id`：
```js
async function resolveTargetOwner(params) {
  const id = params?.id || params?.account_id || params?.deal_id
    || params?.source_id || params?.target_id;
  if (!id) return null;
  const r = await query(
    `SELECT type, tenant_id, payload->>'owner_id' AS owner_id, payload->>'org_id' AS org_id
     FROM crm.particles WHERE (id::text=$1 OR slug=$1) LIMIT 1`,
    [id]
  );
  if (!r.rows.length) return null;
  const row = r.rows[0];
  const ownerOrg = row.owner_id ? await personOrg(row.owner_id) : (row.org_id || null);
  return { ownerId: row.owner_id, ownerOrg, type: row.type, tenant_id: row.tenant_id };
}
```

`enforceScope`（scope.js:81-110）在 `model==='all'` 之后插入 `tenant` 分支：
```js
export async function enforceScope(def, ctx, params, profile) {
  const model = scopeModel(profile);
  if (model === 'all') return { ok: true };
  if (model === 'tenant') {
    // ten_admin 仅可操作本租户粒子；跨租户写 = 越权拒绝
    const target = await resolveTargetOwner(params);
    if (!target) return { ok: true }; // 列表类查询交给 scopePredicate（读路径已由 queryParticles tenantId 过滤）
    if (target.tenant_id && target.tenant_id !== ctx.tenantId) {
      return { ok: false, gate: 'scope_violation',
        reason: `tenant ${target.tenant_id} != ${ctx.tenantId}（ten_admin 跨租户写被拒）` };
    }
    return { ok: true };
  }
  if (def?.name === 'data-particle-create') { /* 原逻辑不变 */ }
  // ... 其余 self/org_subtree/domain 分支不变
}
```

**改动 2 — `particleRepo.js` 数据层防御（defense-in-depth，可选 tenantId 入参，向后兼容）**

`updateParticle`（line 185-210）增加租户校验：
```js
export async function updateParticle(id, { state, patch = {}, event, requireDecisionId = null, systemBypass = false, tenantId = null } = {}) {
  const cur = (await query(`SELECT * FROM particles WHERE id = $1`, [id])).rows[0];
  if (!cur) return null;
  if (tenantId && cur.tenant_id && cur.tenant_id !== tenantId) {
    throw new Error('cross_tenant_write_denied: 目标粒子属租户 ' + cur.tenant_id);
  }
  // ... 原写逻辑不变
}
```
`createEdge`（line 250）同步：插入前校验 `source` 粒子 `tenant_id === tenantId`（若提供）。

**改动 3 — 写 handler 透传 `ctx.tenantId`**：`seed-actions.js` 中 `data-particle-update` / `crm-deal-advance` / `crm-proposal-write` / `data-particle-edge-create` 的 handler 在调用 `updateParticle`/`createEdge` 时传入 `ctx.tenantId`，使防御层生效。

**契约**
```contract-yaml
- task: "F1 enforceScope tenant 分支 + repo 租户防御"
  agent: decision-agent
  contract_task_id: ct-decision
  skills: [data-particle-read, data-particle-create]
  memory: [decision-agent]
  knowledge_scope: { layers: [L1, L2], max_hops: 5 }
  success: "enforceScope 对 model='tenant' 且 target.tenant_id != ctx.tenantId 返回 scope_violation；ten_admin 经 API/MCP 改他租户粒子→403/拒绝；unit+e2e 全绿"
```

---

### §3.2 F2（高危）— 传播中枢写 API 残留越权

**根因**：`gateAccept`（propagationRoutes.js:185-205）对 `memory_promote` 仅要求 `TENANT_LEVEL_ROLES`，`ten_admin` 可将本租户记忆上行推广至 `system`（违反 §15.5）。

**改动 — `propagationRoutes.js` 的 `gateAccept` 收紧 `memory_promote`**
```js
if (kind === 'memory_promote') {
  const targetTenant = tenantId || 'system';
  // §15.5：跨租户 / 上行至 system 仅 ADMIN；同租户内推广允许 tenant 级角色
  if (targetTenant !== me.tenantId && !hasRole(me, 'ADMIN')) {
    return { ok: false, status: 403, error: '跨租户/系统级记忆推广仅 ADMIN（§15.5）' };
  }
  if (!hasAnyRole(me, TENANT_LEVEL_ROLES, { targetTenantId: targetTenant })) {
    return { ok: false, status: 403, error: '记忆推广仅 tan_admin(本租户)/sysadmin/ADMIN 可采纳（§15.5）' };
  }
  return { ok: true, targetTenant };
}
```
config_store 分支（system→ADMIN 已正确）保持不变。`broadcastConfig`（下发 system→tenant）由 ADMIN 触发，不受影响。

**清理 — `configCenter.js:22-25` 陈旧注释**：删除「保持原值不动，待用户裁决」，改注「UI 闸已 ADMIN-only（LEVEL_ROLE_MAP propagation→ADMIN）；写 API 经 §3.2 收紧」。

**契约**
```contract-yaml
- task: "F2 gateAccept memory_promote 收紧 + 清陈旧注释"
  agent: decision-agent
  contract_task_id: ct-decision
  skills: [method-decision-enrich, method-decision-execute]
  memory: [decision-agent]
  knowledge_scope: { layers: [L1, L2], max_hops: 5 }
  success: "ten_admin 将记忆推广至 system(跨租户)→403；同租户内推广→放行；configCenter 陈旧注释已清除"
```

---

### §3.3 F3（中危）— 用户管理 id12 level 矛盾

**根因**：`configCenter.js` id12 `level='system'` → 全局 `createConfigLevelGate`（routes.js:179）对 `/api/config/users` 要求 ADMIN → `sysadmin` 被 403；但 `userManagement.js:226/250/279/317` 放行 `sysadmin`，且 id12 自身 note 写明「sysadmin 权限」。

**改动 — `configCenter.js` id12 `level: 'system'` → `level: 'tenant'`**
```js
{ id: 12, name: '用户管理', group: '平台与访问', level: 'tenant', status: 'ready',
  page: '/users.html', endpoint: '/api/config/users', scope: 'tenant', resolve: 'tenant-first',
  note: '增/改/禁用(禁删)，密码 crypt hash，sysadmin 权限，写经决策第0闸' },
```
同步更新 configCenter.js:6 的示例注释（原以 id12 为例说明 level/scope 可不一致，现应改为一致）。

**契约**
```contract-yaml
- task: "F3 configCenter id12 level system→tenant"
  agent: decision-agent
  contract_task_id: ct-decision
  skills: [method-decision-execute]
  memory: [decision-agent]
  knowledge_scope: { layers: [L1, L2], max_hops: 5 }
  success: "sysadmin 访问 /api/config/users 经全局闸→放行（不再 403）；userManagement router 的 sysadmin 放行生效"
```

---

### §3.4 F4（设计决议）— `sysadmin` 数据范围过宽

**现状**：`sysadmin` `data_scope='all'`（跨租户全量读写）+ 可领 MCP token（mcp/auth.js:126 仅拦 admin）。其权限面大于配置中心可达面（system/propagation 不可达），属不对称。

**待裁决选项（用户拍板，本设计不落地代码）**：
- 方案 A：维持 `sysadmin` 跨租户治理读写（与「平台运营/租户治理」定位一致），但要求 AI 写通道（MCP）对 `sysadmin` 强制 HITL + 全量审计留痕。
- 方案 B：将 `sysadmin` 数据范围收敛为治理类粒子（如租户/用户/配置类），业务粒子（DEAL/ACCOUNT/CONTRACT）仍按本租户或显式授权。

**本设计结论**：F4 不随本次代码提交；待用户在 §7 裁决后单独成设计。

---

### §3.5 F5（低危）— UI 不一致

**改动 — `layout.js:33`**
```js
export function userMenuHtml(role) {
  const sys = role === 'admin' || role === 'sysadmin';
  // ... 其余不变
}
```
使 `sysadmin` 头像下拉与侧栏 `menuFor`（layoutMenu.js:31 已含 sysadmin）一致显示「配置中心 / 智能体中心」。

**契约**
```contract-yaml
- task: "F5 layout.js 头像下拉纳入 sysadmin"
  agent: decision-agent
  contract_task_id: ct-decision
  skills: [data-particle-read]
  memory: [decision-agent]
  knowledge_scope: { layers: [L1, L2], max_hops: 5 }
  success: "sysadmin 头像下拉出现配置中心/智能体中心入口，与侧栏 menuFor 一致"
```

---

### §3.6 F6（信息）— 标签漂移 + 历史伪隔离复测

**动作（验证为主，非必改）**：
1. `configCenter.js` id35/36/39/44 `level='system'` 但 `scope='tenant'`：确认其为 ADMIN-only 非租户级（标签误导但不越权），校正注释或 level 命名。
2. 复测 `business_tier`（businessTier.js:50 读默认 `system`、:70 list 跨租户）与 `approval-flow` 当前 `tenant_id` 实况，确认 `ten_admin` 改动是否仍泄漏全平台（历史记为伪隔离）。
3. 输出复测结论表，作为审计设计输入。

**契约**
```contract-yaml
- task: "F6 配置标签漂移 + 伪隔离复测"
  agent: decision-agent
  contract_task_id: ct-decision
  skills: [data-particle-read]
  memory: [decision-agent]
  knowledge_scope: { layers: [L1, L2], max_hops: 5 }
  success: "输出 business_tier/approval-flow 当前 tenant_id 隔离实况结论 + id35/36/39/44 标签校正建议"
```

---

## §4 测试计划（概要，详见任务 #2）

- **单元**：`enforceScope` `tenant` 分支（放行/拒绝/列表类）；`gateAccept` memory_promote 跨租户拒绝；`inScopeByModel` 不变。
- **集成**：`userManagement` 全局闸 vs `sysadmin` 放行（F3）；`createConfigLevelGate` propagation→ADMIN。
- **E2E**：`ten_admin` 跨租户写→403；`ten_admin` 记忆上行推广至 system→403；`sysadmin` 用户管理可达；configCenter id12 行为符合设计。

## §5 开发计划（概要，详见任务 #3）

按功能线分组提交（每 Task 一 commit，禁 `git add -A`）：
1. `scope.js` + `particleRepo.js`（F1）
2. `propagationRoutes.js` + `configCenter.js` 注释（F2）
3. `configCenter.js` id12（F3）
4. `layout.js`（F5）
5. `businessTier.js` 复测 + 标签校正（F6）

## §6 风险与回滚

- **F1 回归风险**：`enforceScope` tenant 分支若 `ctx.tenantId` 在部分合法调用点为空（如系统任务），需确保系统写走 `bootstrap`/`systemBypass` 且 `ctx.tenantId` 非空（executor.js:95-104 已 fail-closed 缺 tenantId）。回滚：revert `scope.js` 该分支。
- **F3 副作用**：改 id12 为 `tenant` 后 `sysadmin` 可跨租户管理用户（与设计一致），无新增越权面。
- **F2 收紧**：仅影响跨租户/system 推广，同租户推广不变，业务无感。

## §7 设计决策待裁决（F4）

请用户就 §3.4 方案 A / B 拍板：`sysadmin` 是否维持跨租户全量读写，或收敛为治理类粒子 + AI 写通道 HITL。本设计不预置代码。

---

## 附录：契约自检（P7）

- 结构性：每个任务含 `agent + skills + memory + success` 四字段（✓）。
- 注册表对齐（`--registry src/agent/agentSpec.js`）：`agent=decision-agent` 解析存在；`skills` ⊆ decision-agent.skillCalls（`data-particle-read`/`data-particle-create`/`method-decision-enrich`/`method-decision-execute` 均在其 skillCalls）；`memory=[decision-agent]` ∈ 其 read；`knowledge_scope.layers=[L1,L2]` ⊆ 其 layers（✓）。
- 运行：`node scripts/validate-contract.mjs docs/2026-09-06-rbac-role-permission-fix-design.md --registry src/agent/agentSpec.js` → 预期 `valid:true`。
