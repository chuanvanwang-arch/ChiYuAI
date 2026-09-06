# RBAC 角色权限修复 — 审计设计（F1–F6 可验证性 + 上线监控）

- 文档日期：2026-09-06
- 关联：设计 `docs/2026-09-06-rbac-role-permission-fix-design.md`、测试计划 `docs/2026-09-06-rbac-test-plan.md`、开发计划 `docs/superpowers/plans/2026-09-06-rbac-role-permission-fix.md`、F6 复测 `docs/2026-09-06-rbac-pseudo-isolation-retest.md`
- 审计目标：逐条确认 F1–F6 的「修复状态 / 代码证据 / 测试锚点 / 上线监控」，使本次 RBAC 修复可审计、可回归、可告警。

---

## §0 审计结论总览

| 发现 | 级别 | 状态 | 代码证据（file:line） | 测试锚点 | 上线监控 |
|---|---|---|---|---|---|
| F1 ten_admin 跨租户写越权 | 高 | **已修复** | scope.js:85-94；particleRepo.js:190-191,262-265；seed-actions.js:683,749,805,1220 | scope.test.js(T1.x) / particleRepo.tenant.test.js(5) / e2e T6.1,T6.1b | 跨租户写尝试计数 |
| F2 ten_admin 跨租户记忆推广 | 高 | **已修复** | propagationRoutes.js:201-207；UI 闸 rbac.js:80 / configCenter.js:82 | propagationRoutes.test.js(6) / e2e T6.2,T6.2b | 推广拒绝事件 |
| F3 sysadmin 用户管理可达矛盾 | 中 | **已修复** | configCenter.js:13（id12 level=tenant） | configCenter.rbac.test.js(2) / userManagement.gate.test.js(4) | — |
| F4 sysadmin 数据范围过宽 | 中 | **设计裁决（未实现）** | roleProfiles.js:24；mcp/auth.js:126 | 无（仅评审） | sysadmin MCP 写审计量 |
| F5 UI 头像下拉不一致 | 低 | **已修复** | layout.js:33 | layout*.test.js 回归（7 文件全绿） | — |
| F6 标签漂移 + 历史伪隔离 | 信息 | **已复测** | business_tier schema.sql:248（真隔离）；approval_flow migrate-config.sql:48（仍伪隔离） | 无（复测文档） | approval_flow 隔离 follow-up |

测试总账（本次新增 + 回归）：新增 25（scope 4 + particleRepo 5 + propagation 6 + configCenter.rbac 2 + userManagement.gate 4 + e2e 4）；回归 107（configCenter 20 + userManagement 44 + layout/portal 14 + seed-actions 26 + propagationMount 3）= 全部绿。

---

## §1 F1（高危）— ten_admin 跨租户写越权：已修复

### 1.1 修复措施（3 层防御）
1. **主控制（executor 第 1 闸）** — `src/context/scope.js:85-94`：
   `enforceScope` 新增 `model==='tenant'` 分支，经 `resolveTargetOwner`（scope.js:63-76，已返回 `tenant_id`）解析目标粒子租户，若 `target.tenant_id != ctx.tenantId` 返回 `{ok:false, gate:'scope_violation'}`。覆盖 API + MCP/AI 写通道（所有经 executor 派发的 `data-particle-update` / `crm-deal-advance` / `crm-proposal-write` / `data-particle-edge-create`）。
2. **数据层防御（defense-in-depth）** — `src/particles/particleRepo.js:190-191`（`updateParticle`）与 `:262-265`（`createEdge`）：
   当选调方传入 `tenantId` 且非 `'system'` 时，校验目标/源粒子 `tenant_id` 一致，否则抛 `cross_tenant_write_denied`。**豁免 `tenantId==='system'`**（平台/admin/bootstrap 跨租户写为合法，不误伤）。
3. **写 handler 透传** — `src/action/seed-actions.js:683,749,805,1220`（及 894/959/985 等同构点）在调用 `updateParticle`/`createEdge` 时补 `tenantId: ctx.tenantId`，使第 2 层防御生效。

### 1.2 测试锚点（可复跑）
- 单元：`test/context/scope.test.js`（T1.1 同租户放行 / T1.2 跨租户 `scope_violation` / 列表类空 params 放行 / self 模型不受影响）— DB-backed。
- 单元：`test/particles/particleRepo.tenant.test.js`（5 例：updateParticle 跨租户抛错、同租户放行、`system` 豁免、createEdge 源跨租户抛错、列表类放行）。
- E2E：`test/e2e/rbac-tenant-isolation.e2e.test.js` T6.1（ten_admin 改 T2 粒子→403 `scope_violation`）/ T6.1b（改 T1 粒子→200）。
- 复跑命令：
  ```bash
  PGDATABASE=crm_native_test npx vitest run test/context/scope.test.js test/particles/particleRepo.tenant.test.js test/e2e/rbac-tenant-isolation.e2e.test.js
  ```

### 1.3 残留风险与回滚
- 风险：系统任务（bootstrap / 平台迁移）写粒子若 `ctx.tenantId` 为空或错误，可能被第 2 层防御误伤。缓解：`executor.js` 已 fail-closed 缺 `tenantId`；合法跨租户写统一经 `tenantId='system'` 豁免（particleRepo 第 1 行判 `!=='system'`）。
- 回滚：revert `scope.js:85-94` + `particleRepo.js:190-191,262-265` + seed-actions 透传行。

---

## §2 F2（高危）— ten_admin 跨租户/系统级记忆推广：已修复

### 2.1 修复措施
- **写 API 收紧** — `src/http/propagationRoutes.js:201-207`：
  `gateAccept` 的 `memory_promote` 分支：若 `targetTenant !== me.tenantId` 且 `normalizeRole(me.role) === 'TAN_ADMIN'` → 403（ten_admin 禁止跨租户/上行至 system 推广，仅 ADMIN/sysadmin 可）。后续 `hasAnyRole(me, TENANT_LEVEL_ROLES, {targetTenantId})` 保持同租户内推广放行。
- **UI 闸**（复勘已确认，本次无改）：`src/http/middleware/rbac.js:80` `LEVEL_ROLE_MAP.propagation → ['ADMIN']`；`src/portal/configCenter.js:82` `LEVEL_GROUPS` 同款 → 配置中心「全局复用与经验蔓延」TAB 仅 ADMIN 可见（§15.5 上下贯通强制 ADMIN）。
- **陈旧注释清理**：`configCenter.js:22-25` 改为「UI 闸已 ADMIN-only；写 API 经 §3.2 收紧」。

### 2.2 测试锚点
- 单元：`test/http/propagationRoutes.test.js`（6 例：memory_promote 跨租户 ten_admin→拒 / 同租户 ten_admin→放行 / sysadmin→system→放行 / config_store system→仅 ADMIN / 等）。
- E2E：`test/e2e/rbac-tenant-isolation.e2e.test.js` T6.2（ten_admin 上行 system→403）/ T6.2b（sysadmin 上行 system→200）。
- 复跑：`PGDATABASE=crm_native_test npx vitest run test/http/propagationRoutes.test.js test/e2e/rbac-tenant-isolation.e2e.test.js`

### 2.3 残留风险
- 仅影响跨租户/system 推广；同租户内推广（ten_admin 推本租户经验）不变，业务无感。无回归风险。

---

## §3 F3（中危）— 用户管理 id12 level 矛盾：已修复

### 3.1 修复措施
- `src/portal/configCenter.js:13` id12 `level:'system'` → `'tenant'`。使全局 `createConfigLevelGate`（routes.js:179，以 CONFIG_ITEMS 为事实源）对 `/api/config/users` 放行 `tan_admin/sysadmin/ADMIN`，与 `userManagement.js:226/250/279/317` 的 `sysadmin` 放行语义一致。`sysadmin` 用户管理可达。
- 配套：`configCenter.js:6` 示例注释更正（level/scope 可一致）。

### 3.2 测试锚点
- 单元：`test/web/configCenter.rbac.test.js`（2 例：id12 level=tenant 元数据 / 全局闸 role 映射）。
- 集成：`test/portal/userManagement.gate.test.js`（4 例：T5.1 sysadmin GET /api/config/users→200；T5.2 ten_admin→200；T5.3 sysadmin GET /api/config/llm→403；T5.4 admin GET /api/config/llm→200）。
  - 注：该测试早期因「router 全路径 + 测试挂载路径重复」致 404，已改为根挂载（与 production routes.js:440 一致）后全绿。
- 复跑：`PGDATABASE=crm_native_test npx vitest run test/web/configCenter.rbac.test.js test/portal/userManagement.gate.test.js`

---

## §4 F4（中危）— sysadmin 数据范围过宽：设计裁决（未实现）

### 4.1 现状（非代码缺陷）
- `sysadmin` `data_scope='all'`（`src/context/roleProfiles.js:24`）→ `enforceScope` 放通全部租户业务读写。
- 可领 MCP 写 token（`src/http/mcp/auth.js:126` 仅拦 `admin`）→ AI 写通道可跨租户。
- 权限面 > 配置中心可达面（system/propagation 不可达）→ 不对称。

### 4.2 裁决选项（待用户拍板，本 pass 不落地代码）
- **方案 A**：维持跨租户治理读写，但 AI 写通道（MCP）对 `sysadmin` 强制 HITL + 全量审计留痕。
- **方案 B**：收敛 `sysadmin` 数据范围为治理类粒子（租户/用户/配置），业务粒子按本租户或显式授权。

### 4.3 审计处置
- 本次审计设计 **明确标记 F4 为 OPEN/设计决议项**，不计入「已修复」。
- 监控点（§7）：sysadmin MCP 写审计量、跨租户写事件，供后续裁决量化依据。

---

## §5 F5（低危）— UI 头像下拉不一致：已修复

### 5.1 修复措施
- `src/web/layout.js:33`：`const sys = role === 'admin' || role === 'sysadmin';` 使头像下拉「配置中心 / 智能体中心」入口与侧栏 `menuFor`（layoutMenu.js 已含 sysadmin）一致。

### 5.2 测试锚点（回归）
- `test/web/layout.test.js`(4) / `test/web/layout-menu.test.js`(5) / `test/web/layoutMenu.test.js`(2) / `test/portal/layoutMenu.test.js`(3) 全部绿（无新增回归）。

---

## §6 F6（信息）— 标签漂移 + 历史伪隔离：已复测

### 6.1 结论（详见 `docs/2026-09-06-rbac-pseudo-isolation-retest.md`）
- **business_tier_config**：`db/schema.sql:248` 已含 `tenant_id` + 复合 PK → **真实租户隔离（RESOLVED）**，历史伪隔离已收敛。
- **approval_flow**：`db/migrate-config.sql:48-56` **无 `tenant_id`**、全局 `flow_id` PK → **仍为平台级伪隔离（RESIDUAL）**，列独立 follow-up（方案 α 标签平台级化 / 方案 β 加 tenant_id）。不在本次代码范围。
- **id35/36/39/44**：`level='system'`(ADMIN-only) vs `scope='tenant'`(存储域) 为**标签语义**，非越权缺陷；建议注释澄清（可选）。

### 6.2 审计处置
- F6 中 business_tier 项：**RESOLVED**。
- F6 中 approval_flow 项：**升级为独立 OPEN 项**，纳入后续跟踪（§7 监控）。

---

## §7 上线后监控点（可观测性）

| 监控项 | 信号来源 | 告警阈值建议 | 关联发现 |
|---|---|---|---|
| ten_admin 跨租户写尝试 | `enforceScope` 返回 `gate:'scope_violation'`（scope.js:90） | 单租户单日 > N 次重复 → 疑似越权探测 | F1 |
| 跨租户记忆推广拒绝 | `gateAccept` 403（propagationRoutes.js:202） | 同租户高频拒绝 → 配置误用 | F2 |
| sysadmin MCP 写审计量 | `mcp/auth.js` 写 token 使用 + decision_event | 基线突变 / 无 HITL 落痕 | F4 |
| approval_flow 隔离缺口 | 无 tenant_id（migrate-config.sql:48） | follow-up 跟踪：方案 α/β 落地前持续标注 | F6 |
| 配置元数据标签漂移 | `CONFIG_ITEMS` 新增项的 `level`/`scope` 一致性 | 新增 `level='system' && scope='tenant'` 且无注释 → 静态检查告警 | F6/id35-44 |

---

## §8 审计自检（可验证性）

- **代码证据可定位**：F1–F3/F5 均给出 `file:line` 精确锚点；F4/F6 给出评审/复测结论文档。
- **测试可复跑**：每份修复附复跑命令，新增 25 + 回归 107 全部绿（本次 session 实测）。
- **决策可追溯**：F4 设计决议项显式未实现并标注待裁决；F6 approval_flow 显式 OPEN 跟踪。
- **零信任一致性**：所有收紧均为 fail-closed（未知角色 → null → 拒绝；未知 level → 403 登记要求），无静默降级。

> 审计判定：本次 RBAC 修复 **F1/F2/F3/F5 已可验证修复，F4 待设计裁决，F6 business_tier 已收敛 / approval_flow 待 follow-up**。可进入发布评审（F4 裁决与 approval_flow follow-up 不阻塞本次发布，但需在发布说明中标注）。
