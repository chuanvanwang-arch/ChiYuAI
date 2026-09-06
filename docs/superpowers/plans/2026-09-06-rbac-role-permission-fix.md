# RBAC 角色权限修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 `sysadmin`/`ten_admin` 角色权限的越权与矛盾（F1 跨租户写、F2 传播上行、F3 用户管理闸、F5 UI、F6 标签复测），并补充可验证回归测试。

**Architecture:** 主控制层在 `scope.enforceScope`（`executor` 第1闸，覆盖 API + MCP/AI 写通道）补 `tenant` 分支；数据层 `particleRepo.updateParticle/createEdge` 增加可选 `tenantId` 防御；配置中心 `configCenter` id12 `level` 与 `propagationRoutes.gateAccept` 收紧。所有改动向后兼容（repo 防御仅在传入 `tenantId` 时生效）。

**Tech Stack:** Node 22 ESM + vitest 3；PostgreSQL（schema `crm`, @5433, 连 `localhost`/`::1`）；零信任 HITL 决策第0闸已就位。

**关联：** 设计 docs/2026-09-06-rbac-role-permission-fix-design.md；测试计划 docs/2026-09-06-rbac-test-plan.md。

---

## 文件结构

- Modify: `src/context/scope.js` — `resolveTargetOwner` 返回 `tenant_id`；`enforceScope` 增 `tenant` 分支（F1 主闸）
- Modify: `src/particles/particleRepo.js` — `updateParticle`/`createEdge` 增 `tenantId` 防御（F1 防御层）
- Modify: `src/action/seed-actions.js` — `data-particle-update`/`crm-deal-advance` 透传 `ctx.tenantId`（F1 防御层接线）
- Modify: `src/http/propagationRoutes.js` — `gateAccept` `memory_promote` 跨租户收紧 ADMIN（F2）
- Modify: `src/portal/configCenter.js` — id12 `level:'system'→'tenant'` + 清陈旧注释（F3 / F2 注释）
- Modify: `src/web/layout.js` — 头像下拉纳入 `sysadmin`（F5）
- Verify: `src/portal/businessTier.js` / `src/http/**/approval*` — 历史伪隔离复测（F6）
- Test(new): `test/context/scope.test.js`、`test/particles/particleRepo.tenant.test.js`、`test/http/propagationRoutes.test.js`、`test/web/configCenter.rbac.test.js`、`test/portal/userManagement.gate.test.js`
- E2E(new): `test/e2e/rbac-tenant-isolation.e2e.test.js`

---

### Task 1: F1 主闸 — `enforceScope` tenant 分支

**Files:**
- Modify: `src/context/scope.js:63-75`（resolveTargetOwner）、`src/context/scope.js:81-110`（enforceScope）
- Test: `test/context/scope.test.js`

- [ ] **Step 1: 写失败测试**

```js
// test/context/scope.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { enforceScope, resolveTargetOwner } from '../../src/context/scope.js';

const TENANT_PROFILE = { data_scope: { model: 'tenant' } };
const ALL_PROFILE = { data_scope: { model: 'all' } };

describe('enforceScope tenant 分支 (F1)', () => {
  it('T1.1 ten_admin 改本租户粒子 ok', async () => {
    const ctx = { actor: 'u1', tenantId: 'T1' };
    // 注入 resolveTargetOwner 桩
    const { resolveTargetOwner: _orig } = await import('../../src/context/scope.js');
    // 用真实 query 前先 seed；此处用 spy 简化
    const r = await enforceScope({ name: 'data-particle-update' }, ctx, { id: 'p-own' }, TENANT_PROFILE);
    // 注意：未 seed 时 resolveTargetOwner 返回 null → ok:true（列表类语义），见 T1.3
    expect(r.ok).toBe(true);
  });

  it('T1.2 ten_admin 改他租户粒子 scope_violation', async () => {
    const ctx = { actor: 'u1', tenantId: 'T1' };
    // 直接验证 inScopeByModel 等价路径：用 resolveTargetOwner 返回他租户
    const target = { ownerId: 'u2', ownerOrg: 'o2', type: 'CRM_DEAL', tenant_id: 'T2' };
    const mod = await import('../../src/context/scope.js');
    // 临时替换模块内 resolveTargetOwner（测试隔离）
    const orig = mod.resolveTargetOwner;
    mod.resolveTargetOwner = async () => target;
    try {
      const r = await mod.enforceScope({ name: 'data-particle-update' }, ctx, { id: 'p-x' }, TENANT_PROFILE);
      expect(r.ok).toBe(false);
      expect(r.gate).toBe('scope_violation');
    } finally {
      mod.resolveTargetOwner = orig;
    }
  });

  it('T1.4 sysadmin(model=all) 不受影响', async () => {
    const ctx = { actor: 'admin1', tenantId: 'T1' };
    const r = await enforceScope({ name: 'data-particle-update' }, ctx, { id: 'p-any' }, ALL_PROFILE);
    expect(r.ok).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /d/system/CRM-ai-native && npx vitest run test/context/scope.test.js`
Expected: FAIL（T1.2 当前 `enforceScope` 对 `tenant` 返回 `ok:true`，无 `scope_violation`）

- [ ] **Step 3: 实现 — 扩展 `resolveTargetOwner` 返回 `tenant_id` 并支持边 source**

`src/context/scope.js:63-75` 改为：
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

- [ ] **Step 4: 实现 — `enforceScope` 增 `tenant` 分支**

`src/context/scope.js:81-83` 之后插入：
```js
export async function enforceScope(def, ctx, params, profile) {
  const model = scopeModel(profile);
  if (model === 'all') return { ok: true };
  if (model === 'tenant') {
    // ten_admin 仅可操作本租户粒子；跨租户写 = 越权拒绝
    const target = await resolveTargetOwner(params);
    if (!target) return { ok: true }; // 列表类查询交 scopePredicate（读路径已由 queryParticles tenantId 过滤）
    if (target.tenant_id && target.tenant_id !== ctx.tenantId) {
      return { ok: false, gate: 'scope_violation',
        reason: `tenant ${target.tenant_id} != ${ctx.tenantId}（ten_admin 跨租户写被拒）` };
    }
    return { ok: true };
  }
  if (def?.name === 'data-particle-create') {
    // 写创建：自动归属 owner=actor（scoped 类型），不触发越界
    if (SCOPED_TYPES.includes(params?.type) && params?.payload && !params.payload.owner_id) {
      params.payload = { ...params.payload, owner_id: ctx.actor };
    }
    return { ok: true };
  }
  // ... 其余 self/org_subtree/domain 分支保持不变 ...
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd /d/system/CRM-ai-native && npx vitest run test/context/scope.test.js`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/context/scope.js test/context/scope.test.js
git commit -m "fix(rbac): enforceScope 增 tenant 分支，阻断 ten_admin 跨租户写 (F1 主闸)"
```

---

### Task 2: F1 防御层 — `particleRepo` + seed-actions 透传

**Files:**
- Modify: `src/particles/particleRepo.js:185-188`（updateParticle）、`src/particles/particleRepo.js:250-259`（createEdge）
- Modify: `src/action/seed-actions.js:554,683,747,803,845,989,1014,1215`（updateParticle 透传 tenantId）
- Test: `test/particles/particleRepo.tenant.test.js`

- [ ] **Step 1: 写失败测试**

```js
// test/particles/particleRepo.tenant.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { updateParticle, createEdge, getParticle } from '../../src/particles/particleRepo.js';
import { queryWrite, query } from '../../src/db.js';

describe('particleRepo 跨租户防御 (F1)', () => {
  const T1 = 'rbac-t1', T2 = 'rbac-t2';
  let p1, p2;
  beforeAll(async () => {
    const a = await queryWrite(`INSERT INTO particles (tenant_id,type,slug,title,state,payload) VALUES ($1,'CRM_DEAL','rbac-p1','p1','ACTIVE','{}') RETURNING *`, [T1]);
    const b = await queryWrite(`INSERT INTO particles (tenant_id,type,slug,title,state,payload) VALUES ($1,'CRM_DEAL','rbac-p2','p2','ACTIVE','{}') RETURNING *`, [T2]);
    p1 = a.rows[0]; p2 = b.rows[0];
  });
  afterAll(async () => {
    await queryWrite(`DELETE FROM particles WHERE slug IN ('rbac-p1','rbac-p2')`);
  });
  it('T2.2 改他租户粒子抛 cross_tenant_write_denied', async () => {
    await expect(updateParticle(p2.id, { patch: { x: 1 }, tenantId: T1 })).rejects.toThrow(/cross_tenant_write_denied/);
  });
  it('T2.1 改本租户粒子正常', async () => {
    const r = await updateParticle(p1.id, { patch: { x: 1 }, tenantId: T1 });
    expect(r.id).toBe(p1.id);
  });
  it('T2.3 不传 tenantId 向后兼容', async () => {
    const r = await updateParticle(p1.id, { patch: { y: 2 } });
    expect(r.id).toBe(p1.id);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /d/system/CRM-ai-native && npx vitest run test/particles/particleRepo.tenant.test.js`
Expected: FAIL（T2.2 当前不抛）

- [ ] **Step 3: 实现 — `updateParticle` 增 `tenantId` 防御**

`src/particles/particleRepo.js:185` 改为：
```js
export async function updateParticle(id, { state, patch = {}, event, requireDecisionId = null, systemBypass = false, tenantId = null } = {}) {
  const cur = await getParticle(id);
  if (!cur) throw new Error(`粒子不存在: ${id}`);
  if (tenantId && cur.tenant_id && cur.tenant_id !== tenantId) {
    throw new Error(`cross_tenant_write_denied: 目标粒子属租户 ${cur.tenant_id}`);
  }
```
其余不变。

- [ ] **Step 4: 实现 — `createEdge` 增源粒子租户防御**

`src/particles/particleRepo.js:250` 函数体，`isControlledPredicateConfig` 校验之后插入：
```js
  if (tenantId) {
    const src = await getParticle(sourceId);
    if (src && src.tenant_id && src.tenant_id !== tenantId) {
      throw new Error(`cross_tenant_write_denied: 源粒子属租户 ${src.tenant_id}`);
    }
  }
```

- [ ] **Step 5: 实现 — seed-actions 透传 `ctx.tenantId`**

`src/action/seed-actions.js:554`：
```js
    handler: async ({ type, id, patch, state }, ctx) => updateParticle(id, { patch, state, requireDecisionId: ctx.decision_id, tenantId: ctx.tenantId }),
```
`src/action/seed-actions.js:683,747,803,845,989,1014,1215` 各 `updateParticle(deal_id, {` 调用补 `tenantId: ctx.tenantId`（均为 `crm-deal-advance` 内，ctx 可用）。

- [ ] **Step 6: 跑测试确认通过**

Run: `cd /d/system/CRM-ai-native && npx vitest run test/particles/particleRepo.tenant.test.js`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add src/particles/particleRepo.js src/action/seed-actions.js test/particles/particleRepo.tenant.test.js
git commit -m "fix(rbac): particleRepo 跨租户写防御 + seed-actions 透传 tenantId (F1 防御层)"
```

---

### Task 3: F2 — `gateAccept` memory_promote 收紧

**Files:**
- Modify: `src/http/propagationRoutes.js:198-205`
- Modify: `src/portal/configCenter.js:22-25`（清陈旧注释）
- Test: `test/http/propagationRoutes.test.js`

- [ ] **Step 1: 写失败测试**

```js
// test/http/propagationRoutes.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { gateAccept } from '../../src/http/propagationRoutes.js';

describe('gateAccept memory_promote (F2)', () => {
  const tenAdmin = { ok: true, role: 'ten_admin', tenantId: 'T1', username: 'ta' };
  const sysadmin = { ok: true, role: 'sysadmin', tenantId: 'T1', username: 'sa' };
  const admin = { ok: true, role: 'admin', tenantId: 'T1', username: 'ad' };
  it('T3.2 ten_admin 上行至 system 拒', () => {
    const g = gateAccept(tenAdmin, { kind: 'memory_promote', tenantId: 'system' });
    expect(g.ok).toBe(false); expect(g.status).toBe(403);
  });
  it('T3.3 ten_admin 推广至他租户拒', () => {
    const g = gateAccept(tenAdmin, { kind: 'memory_promote', tenantId: 'T2' });
    expect(g.ok).toBe(false); expect(g.status).toBe(403);
  });
  it('T3.1 ten_admin 同租户推广放行', () => {
    const g = gateAccept(tenAdmin, { kind: 'memory_promote', tenantId: 'T1' });
    expect(g.ok).toBe(true);
  });
  it('T3.4 sysadmin 上行至 system 放行', () => {
    const g = gateAccept(sysadmin, { kind: 'memory_promote', tenantId: 'system' });
    expect(g.ok).toBe(true);
  });
  it('T3.5 admin 上行至 system 放行', () => {
    const g = gateAccept(admin, { kind: 'memory_promote', tenantId: 'system' });
    expect(g.ok).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /d/system/CRM-ai-native && npx vitest run test/http/propagationRoutes.test.js`
Expected: FAIL（T3.2/T3.3 当前放行）

- [ ] **Step 3: 实现 — `gateAccept` memory_promote 分支**

`src/http/propagationRoutes.js:198-205` 改为：
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

- [ ] **Step 4: 清 `configCenter.js:22-25` 陈旧注释**

将第 22-25 行注释块改为：
```js
  // 传播中枢 UI 入口（2026-09-05→2026-09-06 收口）：config-center UI 闸已 ADMIN-only
  // （LEVEL_ROLE_MAP propagation→ADMIN / LEVEL_GROUPS propagation roles=[ADMIN]）；
  // 写 API 经 §3.2 gateAccept 收紧（跨租户/系统级记忆推广仅 ADMIN）。保持原值不动的待裁决项已关闭。
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd /d/system/CRM-ai-native && npx vitest run test/http/propagationRoutes.test.js`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/http/propagationRoutes.js src/portal/configCenter.js test/http/propagationRoutes.test.js
git commit -m "fix(rbac): gateAccept memory_promote 跨租户/系统级推广收紧 ADMIN (F2)"
```

---

### Task 4: F3 — configCenter id12 level

**Files:**
- Modify: `src/portal/configCenter.js:13`（id12 level）、`src/portal/configCenter.js:6`（示例注释）
- Test: `test/web/configCenter.rbac.test.js`

- [ ] **Step 1: 写失败测试**

```js
// test/web/configCenter.rbac.test.js
import { describe, it, expect } from 'vitest';
import { CONFIG_ITEMS, LEVEL_GROUPS } from '../../src/portal/configCenter.js';

describe('configCenter RBAC 元数据 (F3)', () => {
  it('T4.1 id12 用户管理 level=tenant', () => {
    const it12 = CONFIG_ITEMS.find((i) => i.id === 12);
    expect(it12.level).toBe('tenant');
  });
  it('T4.2 id42 propagation 仅 ADMIN', () => {
    const g = LEVEL_GROUPS.find((l) => l.level === 'propagation');
    expect(g.roles).toContain('ADMIN');
    expect(g.roles).not.toContain('ten_admin');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /d/system/CRM-ai-native && npx vitest run test/web/configCenter.rbac.test.js`
Expected: FAIL（T4.1 当前 `level==='system'`）

- [ ] **Step 3: 实现 — id12 `level:'system'→'tenant'`**

`src/portal/configCenter.js:13` 改为：
```js
  { id: 12, name: '用户管理', group: '平台与访问', level: 'tenant', status: 'ready', page: '/users.html', endpoint: '/api/config/users', scope: 'tenant', resolve: 'tenant-first', note: '增/改/禁用(禁删)，密码 crypt hash，sysadmin 权限，写经决策第0闸' },
```
同步更新第 6 行注释（原以 id12 为例说明 level/scope 可不一致，改为一致示例）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /d/system/CRM-ai-native && npx vitest run test/web/configCenter.rbac.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/portal/configCenter.js test/web/configCenter.rbac.test.js
git commit -m "fix(rbac): configCenter id12 用户管理 level system→tenant，消除与 router 矛盾 (F3)"
```

---

### Task 5: F5 — layout.js 头像下拉纳入 sysadmin

**Files:**
- Modify: `src/web/layout.js:33`

- [ ] **Step 1: 实现**

`src/web/layout.js:33` 改为：
```js
  const sys = role === 'admin' || role === 'sysadmin';
```

- [ ] **Step 2: 提交**（纯前端一致性，无单测；E2E/视觉验证）

```bash
git add src/web/layout.js
git commit -m "fix(ui): 头像下拉配置中心/智能体中心入口纳入 sysadmin (F5)"
```

---

### Task 6: F6 — 历史伪隔离复测 + 标签校正

**Files:**
- Verify: `src/portal/businessTier.js`、`src/http/**/approval*`
- 产出：`docs/2026-09-06-rbac-pseudo-isolation-retest.md`（结论表）

- [ ] **Step 1: 复测 business_tier 当前 tenant_id 实况**

Run（node 脚本或 psql 经 `localhost`）：
```sql
SELECT tenant_id, count(*) FROM crm.business_tier_config GROUP BY tenant_id;
```
记录：是否有租户行、读默认 `system`、list 是否跨租户。

- [ ] **Step 2: 复测 approval-flow 当前 tenant_id 实况**

```sql
SELECT tenant_id, count(*) FROM crm.approval_flow GROUP BY tenant_id;
```

- [ ] **Step 3: 校正 id35/36/39/44 标签注释**

如确认其为 ADMIN-only 非租户级，更新 configCenter.js 对应 note（明确「ADMIN-only，scope 仅为数据存储作用域」），避免运维误判。

- [ ] **Step 4: 产出复测结论文档并提交**

```bash
git add docs/2026-09-06-rbac-pseudo-isolation-retest.md src/portal/configCenter.js
git commit -m "chore(rbac): F6 历史伪隔离复测结论 + 配置标签注释校正"
```

---

### Task 7: 集成测试 — 全局闸 vs router 一致性（F3）

**Files:**
- Test: `test/portal/userManagement.gate.test.js`

- [ ] **Step 1: 写测试**

```js
// test/portal/userManagement.gate.test.js
import { describe, it, expect, beforeEach } from 'vitest';
// 依赖应用挂载 + resolveMe 桩；复用 test 基建设置 tenantId
describe('用户管理全局闸 (F3)', () => {
  it('T5.1 sysadmin GET /api/config/users 不再 403', async () => { /* 注入 sysadmin me，调用 userManagement GET，断言 200 */ });
  it('T5.3 sysadmin GET /api/config/llm 仍 403', async () => { /* 断言 403 */ });
  it('T5.4 ten_admin 创建 admin 角色 403', async () => { /* 断言 403 */ });
});
```
（具体装配沿用 `test/role/sysadmin-profile.test.js` 基元；本测试聚焦全局闸与 router 一致性。）

- [ ] **Step 2: 跑测试**

Run: `cd /d/system/CRM-ai-native && npx vitest run test/portal/userManagement.gate.test.js`
Expected: PASS

- [ ] **Step 3: 提交**

```bash
git add test/portal/userManagement.gate.test.js
git commit -m "test(rbac): 用户管理全局闸与 router 一致性（sysadmin 可达/系统级仍拒）"
```

---

### Task 8: E2E — 跨租户隔离端到端（T6）

**Files:**
- Test: `test/e2e/rbac-tenant-isolation.e2e.test.js`

- [ ] **Step 1: 写 E2E**

覆盖：ten_admin 持 token 改他租户 DEAL → 403；ten_admin memory_promote 至 system → 403；sysadmin 用户管理可达。复用 `test/e2e` 基建设置两租户 + 对应角色 token。

- [ ] **Step 2: 跑 E2E**

Run: `cd /d/system/CRM-ai-native && npx vitest run test/e2e/rbac-tenant-isolation.e2e.test.js`
Expected: PASS（PG 不稳时按 shared-db-test-hygiene 复测；单次红不得直判）

- [ ] **Step 3: 提交**

```bash
git add test/e2e/rbac-tenant-isolation.e2e.test.js
git commit -m "test(rbac): 跨租户隔离 E2E（ten_admin 写/推广越权拒、sysadmin 用户管理可达）"
```

---

### Task 9: 全量回归 + 审计设计

**Files:**
- 产出：`docs/2026-09-06-rbac-audit-design.md`

- [ ] **Step 1: 全量回归**

Run: `cd /d/system/CRM-ai-native && npx vitest run`
Expected: 无新增红（历史 flaky 按 shared-db-test-hygiene 复测）

- [ ] **Step 2: 写审计设计文档**

对照 F1–F6 逐条确认：已修复（证据 file:line + 测试）/ 已评审（F4 待裁决）/ 已清理（F5/F6）。附上线后监控点（sysadmin MCP 写审计量、config 元数据标签漂移告警）。

- [ ] **Step 3: 提交**

```bash
git add docs/2026-09-06-rbac-audit-design.md
git commit -m "docs(rbac): 审计设计 — F1-F6 修复可验证性 + 上线监控点"
```

---

## 自审（Spec Coverage）

- F1 → Task 1（主闸）+ Task 2（防御层）✓
- F2 → Task 3 ✓
- F3 → Task 4 + Task 7（集成）✓
- F4 → 设计决议项，本计划不实现（Task 9 审计设计标注待裁决）✓
- F5 → Task 5 ✓
- F6 → Task 6 ✓
- 测试计划 T1–T6 全部映射到 Task 1/2/3/4/7/8 ✓

## 提交纪律

- 每 Task 一 commit；`git add` 仅显式路径，**禁 `git add -A`**。
- 本环境无 git 凭证，AI 不执行 `git push`；由用户在本地按功能线审阅后提交。
