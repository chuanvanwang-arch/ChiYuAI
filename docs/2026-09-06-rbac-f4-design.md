# F4 设计文档 — sysadmin 数据范围收敛（方案 C：双轨）

- 日期：2026-09-06
- 状态：设计已批准（方案 C），待 writing-plans → 实现
- 上游：2026-09-06-rbac-role-permission-fix-design.md（F1–F3/F5 已修，F4 裁决项）；2026-09-06-rbac-audit-design.md §4
- 契约校验：`node scripts/validate-contract.mjs docs/2026-09-06-rbac-f4-design.md --registry src/agent/agentSpec.js`

---

## §0 现状与问题（证据驱动）

| 项 | 证据 | 说明 |
|---|---|---|
| sysadmin 全量数据范围 | `src/context/roleProfiles.js:24` `data_scope: { model: 'all' }` | 平台治理角色，跨租户读写全开 |
| enforceScope 全量直通 | `src/context/scope.js:84` `if (model === 'all') return { ok: true }` | 任何租户业务粒子写均放通 |
| MCP 写 token 可领 | `src/mcp/auth.js:126-129` 仅拦 `admin`；`sysadmin` 直发写 token | AI 写通道可跨租户写 |
| 配置可达面窄 | `src/http/middleware/rbac.js:80` `LEVEL_ROLE_MAP.propagation = ADMIN-only` | sysadmin 被挡在 system/propagation 级 → **权限面(数据 all) >> 配置可达面(租户级)**，不对称 |

**核心风险**：`sysadmin` 作为平台治理角色，却拥有跨租户业务数据（CRM_DEAL/ACCOUNT/…）的读写全权，且 AI 写通道可借此跨租户写。属中危权限过宽。

---

## §1 方案对比（已呈用户，选定 C）

| 方案 | 读范围 | 写范围 | 消除风险 | 代价 |
|---|---|---|---|---|
| A 最小改动 | 全量 | 仅 MCP 写通道 HITL；HTTP 业务写仍 all | 仅 AI 跨租户写 | HTTP 业务写过宽未解，不对称仍在 |
| B 严格收敛 | 限治理类 | 限治理类（业务读写全拒） | 完全消除不对称 | 失去跨租户业务读（排障需 ADMIN 升级） |
| **C 双轨（选定）** | 全量（诊断保留） | 业务粒子写拒（HTTP+MCP 双闸）；治理写 HITL+审计 | 消除最危险轴（写跨租户）+ 闭合写不对称 | 读不对称保留（低风险，可运维） |

**选定理由**：写跨租户是最高危轴；C 在 executor 第1闸（enforceScope）+ MCP 双重拦截业务写，闭环写不对称；读保留全量以便平台排障。改动中等、零信任一致（fail-closed）。

---

## §2 选定方案 C 设计

### C1 数据模型（roleProfiles.js）
`sysadmin` 种子由 `data_scope: { model: 'all' }` 改为：
```js
data_scope: {
  model: 'all',                                  // 读：跨租户全量（诊断/排障）
  write_scope: { model: 'governance', exclude_types: BUSINESS_PARTICLE_TYPES }
}
```
`src/context/scope.js` 新增治理类常量（单一事实源，与 SCOPED_TYPES 同文件）：
```js
export const BUSINESS_PARTICLE_TYPES = [
  'CRM_DEAL', 'CRM_ACCOUNT', 'CRM_CONTACT',
  'CRM_TECHNICAL_PROPOSAL', 'CRM_INVOICE', 'CRM_PAYMENT_RECORD',
  'CRM_CONTRACT', 'CRM_QUOTATION', 'CRM_ORDER',
];
```
> 治理类粒子（放行跨租户写）：`CRM_PERSON`（用户/角色记录，用户管理依赖）、tenant/config/`config_store`/`business_tier_config`/billing/approval/方法论 等非业务表。**CRM_PERSON 必须保留在治理类**，否则 sysadmin 用户管理写被误杀（审计 F3 已修复的可达性回退）。

### C2 写闸（scope.js enforceScope）
`enforceScope`（`scope.js:82`）顶部以 `write_scope` 覆盖写路径 model：
```js
export async function enforceScope(def, ctx, params, profile) {
  const ws = profile?.data_scope?.write_scope;        // 写专属范围
  const model = ws ? ws.model : scopeModel(profile);  // 读仍用 data_scope.model
  if (model === 'all') return { ok: true };
  if (model === 'governance') {
    const target = await resolveTargetOwner(params);
    if (!target) return { ok: true };                  // 列表类查询交 scopePredicate
    if (BUSINESS_PARTICLE_TYPES.includes(target.type)) {
      return { ok: false, gate: 'scope_violation',
        reason: `sysadmin 写范围限治理类，业务粒子 ${target.type} 不可写（需 ADMIN 升级或 HITL 决策）` };
    }
    return { ok: true };                               // 治理类粒子跨租户写放行
  }
  if (model === 'tenant') { /* …既有 F1 分支不变… */ }
  // self / org_subtree / domain 既有分支不变
}
```
> `scopePredicate`（`scope.js:127`，读路径）保持 `model:'all' → 无 clause` → sysadmin 跨租户读全量，不变。

### C3 MCP/AI 写通道零信任（mcp/auth.js）
`src/mcp/auth.js:126` 增加 `sysadmin` 分支：
- 业务写：由 C2 在 executor 第1闸双闸拒（HTTP+MCP 同源），无需额外代码；token `scopes` 写入 `{ write_scope:'governance', deny_business_write:true }` 供 MCP 层短路前置拒。
- 治理写：经既有决策第0闸（`src/action/executor.js:28` 缺 `decision_id` 拒）→ 强制 HITL；落 `crm.task_audit` 全量留痕。
- `sysadmin` 仍可领写 token（治理类写可用），但业务写被 C2 拒、治理写须 HITL。

### C4 测试（新增）
`test/context/scope.sysadmin.test.js`：
- T1 sysadmin 写 CRM_DEAL → `enforceScope` 返回 `gate:'scope_violation'`（C2）。
- T2 sysadmin 写 CRM_PERSON（治理）→ `ok:true`（C1 排除项正确）。
- T3 sysadmin 读路径 `scopePredicate` 无 clause（跨租户读全量）。
- T4 sysadmin `data_scope.write_scope` 结构断言（C1）。
- 回归：`test/role/sysadmin-profile.test.js`（data_scope=all 现状断言需同步改为含 write_scope）、`test/context/scope.test.js`、E2E 现有 sysadmin 路径。

---

## §3 任务分解 + 生命契约（living contract）

```contract-yaml
- task: "F4-1 sysadmin write_scope 数据模型 + BUSINESS_PARTICLE_TYPES 常量"
  agent: decision-agent
  contract_task_id: ct-decision
  skills: [data-particle-read]
  memory: [decision-agent]
  success: "sysadmin profile.data_scope 含 write_scope.governance；BUSINESS_PARTICLE_TYPES 导出且含 9 个业务粒子类型"
- task: "F4-2 enforceScope 写闸 governance 分支（业务粒子写拒）"
  agent: decision-agent
  contract_task_id: ct-decision
  skills: [data-particle-read]
  memory: [decision-agent]
  success: "enforceScope 对 sysadmin 写 CRM_DEAL 返回 gate:'scope_violation'；写 CRM_PERSON 返回 ok:true"
- task: "F4-3 MCP/AI 写通道零信任（sysadmin HITL + task_audit 留痕）"
  agent: decision-agent
  contract_task_id: ct-decision
  skills: [data-particle-read]
  memory: [decision-agent]
  success: "mcp/auth.js sysadmin 治理写须 decision_id(HITL)；业务写被 enforceScope 双闸拒；task_audit 留痕"
- task: "F4-4 单元/E2E 测试（sysadmin 业务写拒 / 治理写放行）"
  agent: decision-agent
  contract_task_id: ct-decision
  skills: [data-particle-read]
  memory: [decision-agent]
  success: "test/context/scope.sysadmin.test.js 全绿；sysadmin-profile.test.js 与 scope.test.js 回归通过"
```

---

## §4 监控点（审计可验证性）

| 指标 | 来源 | 告警 |
|---|---|---|
| sysadmin 业务粒子写尝试 | `enforceScope` 返回 `gate:'scope_violation'`（scope.js C2） | 单租户单日 > N 次 → 疑似越权探测 |
| sysadmin 治理写 HITL 落痕 | `task_audit` + `decision_event` | 无 decision_id 落痕却写成功 → 闸失效 |
| 读范围不对称 | `data_scope.model='all'` 读全量 | 仅记录，不告警（方案 C 已知取舍） |

---

## §5 影响面 / 回归

- **不破坏**：F1（ten_admin 跨租户写拒）、F2（记忆推广）、F3（sysadmin 用户管理可达）、F5（UI 下拉）——C 仅收窄 sysadmin 写范围，不动 ten_admin。
- **需同步更新**：`test/role/sysadmin-profile.test.js:34` 断言 `data_scope.model==='all'` → 改为断言含 `write_scope`。
- **决策第0闸复用**：C3 治理写 HITL 直接复用 `executor.js:28` 既有 decision_id 闸，不新增闸。
- **fail-closed 一致**：未知 `write_scope.model` → `scopeModel` 回退 `data_scope.model`（all）；业务写拒为显式分支，无静默降级。

---

## §6 闭环回写（P10 占位，待 workbench 监控写入）

| task | agent | gap_type | observed | expected | severity |
|---|---|---|---|---|---|
| （运行期填充） | | | | | |

> 本表由 agent-workbench 监控 `contract-yaml` 执行后 upsert；同 `(task,gap_type)` 复发 ≥2 次 → 提 SKILL 改进建议（需用户批准）。
