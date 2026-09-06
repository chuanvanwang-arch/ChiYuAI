# RBAC 角色权限修复 — 测试计划

- 关联设计：docs/2026-09-06-rbac-role-permission-fix-design.md
- 日期：2026-09-06
- 框架：vitest（与现有 `test/` 套件一致）；E2E 复用 `test/e2e/*` 或 supertest 式 HTTP 端到端
- 目标：覆盖 F1/F2/F3/F5/F6 的「修复后行为」，并对 F4 留观测点（不写断言）

---

## T1 单元层 — `enforceScope` tenant 分支（F1 主控制）

文件：`test/context/scope.test.js`（新建或并入既有 scope 测试）

| 用例 | 输入 | 预期 |
|---|---|---|
| T1.1 | `profile.data_scope.model='tenant'`，`params.id` 指向本租户粒子（`target.tenant_id === ctx.tenantId`） | `{ok:true}` |
| T1.2 | `model='tenant'`，`params.id` 指向**他租户**粒子（`target.tenant_id !== ctx.tenantId`） | `{ok:false, gate:'scope_violation'}` |
| T1.3 | `model='tenant'`，无 `id`/`account_id`/`deal_id`（列表类） | `{ok:true}`（交 `scopePredicate`，读路径由 `queryParticles` tenantId 过滤） |
| T1.4 | `model='all'`（sysadmin/exec） | `{ok:true}`（不受影响，回归） |
| T1.5 | `model='self'`（sales） | 行为不变（`inScopeByModel('self')`） |
| T1.6 | `resolveTargetOwner` 返回含 `tenant_id` 字段 | 断言 `target.tenant_id` 为粒子实际租户 |

**前置**：用内存 profile 或 `loadProfile` 注入 `ten_admin`；mock `ctx.tenantId`。

---

## T2 单元层 — `particleRepo` 数据层防御（F1 defense-in-depth）

文件：`test/particles/particleRepo.test.js`

| 用例 | 输入 | 预期 |
|---|---|---|
| T2.1 | `updateParticle(id, {tenantId:'T1'})`，目标粒子 `tenant_id='T1'` | 正常返回更新行 |
| T2.2 | `updateParticle(id, {tenantId:'T1'})`，目标粒子 `tenant_id='T2'` | 抛 `cross_tenant_write_denied` |
| T2.3 | `updateParticle(id)` 不传 `tenantId` | 向后兼容，不抛（仅防御层，主闸在 enforceScope） |
| T2.4 | `createEdge(..., {tenantId:'T1'})`，source 粒子 `tenant_id='T1'` | 正常插入 |
| T2.5 | `createEdge(..., {tenantId:'T1'})`，source 粒子 `tenant_id='T2'` | 抛 `cross_tenant_write_denied` |

**前置**：seed 两租户粒子（`T1`/`T2`）；`systemBypass=false` 确保非系统写。

---

## T3 单元层 — `gateAccept` memory_promote（F2 残留）

文件：`test/http/propagationRoutes.test.js`（复用 `__setDeps` 注入桩）

| 用例 | 角色 | `tenantId`（入参） | `me.tenantId` | 预期 |
|---|---|---|---|---|
| T3.1 | ten_admin | 本租户（== me.tenantId） | 本租户 | `{ok:true}` |
| T3.2 | ten_admin | `system`（跨租户上行） | 本租户 | `{ok:false, status:403}` |
| T3.3 | ten_admin | 他租户 T2（!= me.tenantId） | T1 | `{ok:false, status:403}` |
| T3.4 | sysadmin | `system` | — | `{ok:true}`（TENANT_LEVEL_ROLES） |
| T3.5 | admin | `system` | — | `{ok:true}` |
| T3.6 | config_store + `system` 目标 | 任意 | — | `{ok:true}`（既有 ADMIN 分支，回归） |

**前置**：`__setDeps` 注入 `requireDecision`/`writeConfig` 桩，避免真实 PG/决策链。

---

## T4 单元层 — 配置中心元数据（F3 + 标签）

文件：`test/web/configCenter.test.js`（既有，补断言）

| 用例 | 断言 |
|---|---|
| T4.1 | `CONFIG_ITEMS` 中 `id===12` 的 `level === 'tenant'`（F3 修复后） |
| T4.2 | `id===42`（propagation）`level === 'propagation'` 且 `LEVEL_GROUPS` 该 level `roles` 含 `'ADMIN'`（F2 UI 闸，回归） |
| T4.3 | `createConfigLevelGate` 对 `level='propagation'` 端点要求 ADMIN；`ten_admin` 命中 → 403 |

---

## T5 集成层 — 全局闸 vs router 一致性（F3）

文件：`test/portal/userManagement.test.js` 或 `test/http/routes.test.js`

| 用例 | 请求 | 身份 | 预期 |
|---|---|---|---|
| T5.1 | `GET /api/config/users` | sysadmin | 200（不再被全局 `createConfigLevelGate` 403） |
| T5.2 | `GET /api/config/users` | ten_admin | 200（本租户） |
| T5.3 | `GET /api/config/llm` | sysadmin | 403（system 级仍仅 ADMIN，确认 sysadmin 不可越 system） |
| T5.4 | `POST /api/config/users`（创建 admin 角色） | ten_admin | 403（禁止分配平台级角色，回归既有约束） |

**前置**：`resolveMe` 注入对应角色 + `tenantId`；`createConfigLevelGate(CONFIG_ITEMS)` 全局挂载。

---

## T6 E2E 层（详见任务 #5）

| 用例 | 链路 | 预期 |
|---|---|---|
| T6.1 | ten_admin 持 MCP/API token 调 `data-particle-update`（改他租户 DEAL） | 403 / scope_violation 拒绝 |
| T6.2 | ten_admin 调 `POST /api/propagation/accept`（kind=memory_promote, tenantId=system） | 403 |
| T6.3 | sysadmin 访问 `/users.html` + `GET /api/config/users` | 可达（F3） |
| T6.4 | configCenter 渲染 id12 出现在「租户级」分组而非「系统级」 | 符合 |

---

## T7 观测点（F4，仅记录不断言）

- 记 `sysadmin` 经 MCP 写通道的 `decision_event` / 审计量（落 `monitor_event`），供后续裁决方案 A/B 参考。
- 不写失败/通过断言，避免预设结论。

---

## 通过判据

- T1–T5 全绿；T6 E2E 全绿（PG 不稳时单次红不得直判，按 shared-db-test-hygiene 复测）。
- 无既有 `configCenter.test.js` / `sysadmin-profile.test.js` / `scope` 测试退化。
