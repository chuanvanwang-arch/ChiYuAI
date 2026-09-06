# F4 sysadmin 数据范围收敛（方案 C）— 实施计划

> 设计：docs/2026-09-06-rbac-f4-design.md（已批准）
> 用户决策：2026-09-06 22:0x「进入 writing-plans → 实施【同意】」
> 流程顺序：brainstorming → writing-plans → 实施（本文件为实施阶段输入）

---

## §0 目标

将 `sysadmin` 的**写范围**从「跨租户全量业务写」收敛为「治理类写 + 业务写拒绝」：

- **读**：保持 `data_scope.model='all'` → 跨租户全量读（诊断/排障保留，方案 C 明确保留）。
- **写**：新增 `data_scope.write_scope = { model:'governance', exclude_types:BUSINESS_PARTICLE_TYPES }`：
  - 业务粒子（CRM_DEAL/ACCOUNT/CONTACT/…）写 → **拒绝**（gate=`scope_violation`）。
  - 治理类（CRM_PERSON/租户/配置/…）写 → 放行（其中治理写仍走第 0 闸 HITL）。
- **MCP/AI 通道**：`sysadmin` 领写 token 仍可，但业务写被第 1 闸双拒、治理写须 `decision_id`（HITL）。

设计意图：**业务粒子写是最高危轴（跨租户业务污染），写收敛后闭合；读保留以便平台运维排障**（方案 C 明确取舍）。

---

## §1 改动清单（文件级）

| 文件 | 操作 | 内容 |
|---|---|---|
| `src/context/scope.js` | Modify | ① 导出 `BUSINESS_PARTICLE_TYPES` 常量（9 业务粒子）；② `enforceScope` 顶部加 `write_scope` 覆盖：`governance` 分支拒业务粒子写 |
| `src/context/roleProfiles.js` | Modify | `sysadmin` 种子 `data_scope` 增 `write_scope:{model:'governance', exclude_types:BUSINESS_PARTICLE_TYPES}` |
| `src/mcp/auth.js` | Modify | 身份 `scopes` 注入 `{ write_scope:'governance', deny_business_write:true }`（供 MCP 层短路前置）；业务写由第 1 闸双拒、治理写走第 0 闸 HITL |
| `test/context/scope.sysadmin.test.js` | **Create** | C4 四用例（T1 业务写拒 / T2 治理写放行 / T3 读全量 / T4 结构断言） |
| `test/role/sysadmin-profile.test.js` | Modify | 同步断言 `data_scope` 含 `write_scope.governance` |
| `db/schema.sql` / `db/migrate-*.sql`（如需） | 检查 | 若 `role_context_profile` 有种子快照需同步（grep 确认后定） |

---

## §2 实施顺序（依赖驱动，每 Task 一 commit）

> 铁律：每 Task 一 commit（显式路径 add，禁 git add -A）；禁 DELETE；沙箱无凭证，产 PowerShell 命令由用户本机执行。

### Task 1 — scope.js：BUSINESS_PARTICLE_TYPES + governance 写分支
**文件**：`src/context/scope.js`
**要点**：
- `SCOPED_TYPES`（:78）旁新增导出：
  ```js
  export const BUSINESS_PARTICLE_TYPES = [
    'CRM_DEAL', 'CRM_ACCOUNT', 'CRM_CONTACT',
    'CRM_TECHNICAL_PROPOSAL', 'CRM_INVOICE', 'CRM_PAYMENT_RECORD',
    'CRM_CONTRACT', 'CRM_QUOTATION', 'CRM_ORDER',
  ];
  ```
- `enforceScope`（:82）顶部：`const ws = profile?.data_scope?.write_scope;`/`const model = ws ? ws.model : scopeModel(profile);`
- `model==='governance'` 分支（插在 `all` 之后、`tenant` 之前）：
  ```js
  if (model === 'governance') {
    const target = await resolveTargetOwner(params);
    if (!target) return { ok: true };               // 列表类查询交 scopePredicate
    if (BUSINESS_PARTICLE_TYPES.includes(target.type)) {
      return { ok: false, gate: 'scope_violation',
        reason: `sysadmin 写范围限治理类，业务粒子 ${target.type} 不可写（需 ADMIN 升级或 HITL 决策）` };
    }
    return { ok: true };                             // 治理类粒子跨租户写放行
  }
  ```
- 读路径 `scopePredicate` 不动（`model:'all' → 无 clause`）→ sysadmin 读全量保留。

### Task 2 — roleProfiles.js：sysadmin 种子增 write_scope
**文件**：`src/context/roleProfiles.js:24`
```js
{ role_tag: 'sysadmin', …,
  data_scope: {
    model: 'all',                                   // 读：跨租户全量（诊断/排障）
    write_scope: { model: 'governance', exclude_types: BUSINESS_PARTICLE_TYPES }
  },
  retrieval_cfg: DEFAULT_RETRIEVAL },
```
- 从 scope.js `import { BUSINESS_PARTICLE_TYPES }`（仅作为种子类型清单引用；运行时权威在 scope.js）。
- `seedProfiles` 幂等 `WHERE NOT EXISTS` → 现网已存在行**不会自动更新**：需 `db/migrate-*-sysadmin-write-scope.sql` 或播种脚本补 `UPDATE`（grep `role_context_profile` seed 后定，见 Task 5）。

### Task 3 — mcp/auth.js：身份 scopes 注入写范围
**文件**：`src/mcp/auth.js`
- `buildMcpCtx`（:83）产物 `scopes`（:100）扩为：
  ```js
  scopes: { ...base.scopes, write_scope:'governance', deny_business_write:true } // sysadmin 时
  ```
  - 精确插入点：`resolveIdentity` 返回身份后，若 `role==='sysadmin'` 则 `scopes.deny_business_write=true`、`scopes.write_scope='governance'`。
  - MCP 层（`gateway.js` 或写 Action 前置）遇到 `deny_business_write` 且目标为业务粒子 → 短路 403。
- 设计 §C3：业务写由第 1 闸（scope.js）双拒（HTTP+MCP 同源），治理写仍走第 0 闸（executor.js:28 缺 decision_id 拒 → HITL）。

### Task 4 — 测试：scope.sysadmin.test.js + sysadmin-profile 同步
**文件（Create）**：`test/context/scope.sysadmin.test.js`
- T1 sysadmin（write_scope=governance）写 CRM_DEAL（带 id 指向业务粒子）→ `{ok:false, gate:'scope_violation'}`。
- T2 sysadmin 写 CRM_PERSON（治理）→ `{ok:true}`。
- T3 读路径 `scopePredicate` 对 `model:'all'`（无 write_scope 覆盖读）→ 无 clause（跨租户全量）。
- T4 `data_scope.write_scope` 结构断言（`model==='governance'` + `exclude_types` 含 9 类）。
**文件（Modify）**：`test/role/sysadmin-profile.test.js:30-35`
- 断言补 `expect(p.data_scope.write_scope.model).toBe('governance')`。

### Task 5 — DB 种子同步（grep 确认后）
- grep `role_context_profile` 的种子入口（`db/seed.sql` / `db/migrate.js` / `scripts/seed-*.mjs`），将 sysadmin `data_scope` 增量 `write_scope` 同步；
- 若现网已播种则补 `UPDATE … WHERE role_tag='sysadmin' AND data_scope->>'model'='all'`（幂等，禁 DELETE）。

### Task 6 — 回归
- `test/context/scope.test.js`（既有，`all`/`tenant` 分支不受影响）；
- `test/role/sysadmin-profile.test.js`（改后）；
- E2E `test/e2e/rbac-tenant-isolation.e2e.test.js`（sysadmin 路径）；
- 全量回归注意：共享测试库并发 TRUNCATE 伪失败（单次红不得直判，按 shared-db-test-hygiene 复测）。

---

## §3 风险与回滚

| 风险 | 缓解 |
|---|---|
| sysadmin 合法治理写被误拒 | `BUSINESS_PARTICLE_TYPES` 白名单明确 9 类；CRM_PERSON 显式在治理类（F3 用户管理不误杀） |
| 存量角色上下文 profile 缓存 | `seedProfiles`/`loadProfile` 内存缓存 `cache`：实施后需 `invalidate('sysadmin')` 或重启进程使新 write_scope 生效 |
| MCP 短路误伤治理写 | `deny_business_write` 仅对业务粒子短路；治理写仍走第 0 闸（不静默放行） |
| 回滚 | 代码级全可回滚：revert `scope.js` governance 分支 + `roleProfiles.js` sysadmin 行 + `mcp/auth.js` scopes 覆盖；DB 种子可 UPDATE 回 `{model:'all'}` |

---

## §4 验证命令（可复现）

```bash
# 单元（新增 + 回归）
PGDATABASE=crm_native_test npx vitest run test/context/scope.sysadmin.test.js test/role/sysadmin-profile.test.js test/context/scope.test.js
# E2E（sysadmin 路径）
PGDATABASE=crm_native_test npx vitest run test/e2e/rbac-tenant-isolation.e2e.test.js
# grep 确认无旧写范围残留
grep -rn "deny_business_write\|write_scope" src/ | head -20
```

---

## §5 完成判据（设计契约）

1. `sysadmin` 写 CRM_DEAL → `gate:'scope_violation'`（HTTP + MCP 双拒）。
2. `sysadmin` 写 CRM_PERSON → 放行（治理类）。
3. `sysadmin` 读全量 → `scopePredicate` 无 clause（不变）。
4. MCP 层 `sysadmin` 领写 token 仍可，被 `deny_business_write` 短路业务写、治理写走第 0 闸。
5. 全量回归无新增红（已知 flaky 不直判）。
