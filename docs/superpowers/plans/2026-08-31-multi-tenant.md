# 多租户（行级共享库）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 CRM-ai-native 从“伪单租户”升级为真·行级多租户：租户身份落 JWT → `resolveMe` 携带 → 全读写按租户过滤；现有 `system` 数据零迁移；sysadmin 凭角色跨租户。

**Architecture:** 行级共享库（复用现有 `tenant_id` 列+复合索引）。身份层：登录签发 JWT 携带 `tenantId` claim，`resolveMe` 解出；读路径经 `queryParticles({tenantId: scopeTenant(me)})`（`'*'` 通配给 admin）；写路径经 `ctx.tenantId`（action 链已透传）；配置面引入共享 `configStore` 模块，读 `tenant`→空回退 `system` 平台默认。每 Task 一 commit；禁删铁律（全部 `ADD COLUMN IF NOT EXISTS` + 软停）。

**Tech Stack:** Node 22 ESM / Express 4 / PostgreSQL 16 (`crm` schema, `pg`)/ pgcrypto（密码）/ HMAC JWT（现有 `auth.js`）/ vitest 3（沙箱外跑 node 直连 `plm_test` 验证，本地 `npm run test:e2e`）。

**设计基线：** `docs/2026-08-31-multi-tenant-design.md`（四枢轴已批准：行级共享库 / 登录绑定 / system=种子租户+角色跨租户 / 全量 per-tenant）。

---

## 文件结构（本次新增/改动）

| 文件 | 责任 | 动作 |
|---|---|---|
| `db/migrate-tenant.js` | 幂等加列迁移（tenant_id 落到 users/mcp_identity/decision_scenario/decision/audit_event；config_store 加列+重建 PK 为 (tenant_id,key)） | 新建 |
| `src/http/tenantScope.js` | `scopeTenant(me)` / `scopeOf(me)` 纯函数（admin→`'*'`，否则 `me.tenantId \|\| 'system'`） | 新建 |
| `src/config/configStore.js` | 共享 config_store 读写（read 带 tenant→system 回退；write 按 tenant 落 (tenant_id,key)） | 新建 |
| `src/http/auth.js` | login SELECT tenant_id；issueToken 增 tenantId；resolveMe 返回 tenantId（旧 token 回退） | 改 |
| `src/particles/particleRepo.js` | `queryParticles` 支持 `tenantId:'*'` 通配（省略 tenant 条件） | 改 |
| `src/approval/engine.js` | `startInstance`/`advanceTask`/… 透传 `tenantId`，替换 `TENANT` 常量 | 改 |
| `src/approval/flow.js` | `getFlow` 增 tenantId 参数；`writeFlowFromStages` 已带，校验 | 改 |
| `src/http/workbenchRouter.js` | 审批任务/实例/看板改用 `scopeTenant(me)` | 改 |
| `src/http/routes.js` | 41 处 `tenantId:'system'` → `scopeTenant(me)` / 写 ctx 用 `me.tenantId` | 改 |
| `funnelRouter/namedAccountAssignRouter/businessBoard/approvalFlow/mcp/gateway` | 同上的 query 点替换 | 改 |
| `src/http/configRouter.js` | 改用 `configStore.readConfig/writeConfig` | 改 |
| `behaviorStandardRouter/financeReceivablesConfigRouter/namedAccountTargetsRouter/salesThresholdsRouter/sevenDimRouter/controlledConfigPages` | read/write 走 `configStore` | 改 |
| `autonomyEngine/contextGuard/agentLoop/ruleResolver/financeAlertHook/llm/client` | config_store 读点经 `configStore.readConfig` | 改 |
| `src/http/tenantRouter.js` | `GET/POST /api/tenants`（admin 闸+第0闸）；软停下线 | 新建 |
| `test/multi-tenant.test.js` | 行级隔离断言（两租户同 slug 不串）+ 配置回退断言 | 新建 |
| `scripts/seed-tenant-demo.mjs` | 演示租户 + 用户 + 业务数据（验证隔离） | 新建 |

---

## Task T1：身份层（租户锚落地）

**Files:**
- Create: `db/migrate-tenant.js`
- Modify: `src/http/auth.js`（`login` L35-42 / `issueToken` L7-13 / `resolveMe` L45-54）
- Test: `test/multi-tenant.test.js`（T1 段）

- [ ] **Step 1: 写失败测试（resolveMe 返回 tenantId；旧 token 回退 system）**

```js
// test/multi-tenant.test.js（T1 段）
import { describe, it, expect } from 'vitest';

// 用真实 auth 模块（不连 DB，仅测 token 编解码契约）
import { issueToken, verifyToken, resolveMe } from '../src/http/auth.js';

describe('T1 身份层：租户锚', () => {
  it('issueToken 携带 tenantId claim；verifyToken 可回解', () => {
    const tok = issueToken({ username: 'alice', role: 'sales', display_name: 'Alice', tenantId: 'acme' });
    const p = verifyToken(tok);
    expect(p.tenantId).toBe('acme');
    expect(p.username).toBe('alice');
    expect(p.role).toBe('sales');
  });

  it('resolveMe 从 token 解出 tenantId', () => {
    const tok = issueToken({ username: 'bob', role: 'sales', display_name: 'Bob', tenantId: 'globex' });
    const me = resolveMe({ headers: { authorization: `Bearer ${tok}` } });
    expect(me.ok).toBe(true);
    expect(me.tenantId).toBe('globex');
  });

  it('旧 token（无 tenantId claim）回退 system（向后兼容）', () => {
    const oldTok = issueToken({ username: 'carol', role: 'admin', display_name: 'Carol' }); // 无 tenantId
    const me = resolveMe({ headers: { authorization: `Bearer ${oldTok}` } });
    expect(me.ok).toBe(true);
    expect(me.tenantId).toBe('system');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
PGDATABASE=plm_test npx vitest run test/multi-tenant.test.js -t "T1"
```
期望：`tenantId` 断言 FAIL（`resolveMe` 当前返回对象无 `tenantId`）。

- [ ] **Step 3: 写 auth.js 实现**

`src/http/auth.js` 三处改动（其余不动）：

```js
// 1) issueToken 调用方补 tenantId —— 改 login（L41）
export async function login({ username, password } = {}) {
  if (!username || !password) return { ok: false, status: 400, error: 'username and password required' };
  const { rows } = await query(
    `SELECT username, password_hash, role, display_name, tenant_id FROM crm.crm_users WHERE username=$1`, [username]);   // 增 tenant_id
  if (!rows.length) return { ok: false, status: 401, error: 'invalid credentials' };
  const u = rows[0];
  const { rows: v } = await query(`SELECT crypt($1, $2) = $2 AS ok`, [password, u.password_hash]);
  if (!v[0].ok) return { ok: false, status: 401, error: 'invalid credentials' };
  const token = issueToken({ username: u.username, role: u.role, display_name: u.display_name, tenantId: u.tenant_id || 'system' }); // 增 tenantId
  return { ok: true, status: 200, token, role: u.role, display_name: u.display_name, tenantId: u.tenant_id || 'system' };
}

// 2) resolveMe 返回补 tenantId（L50）
export function resolveMe(req) {
  const token = extractToken(req);
  if (!token) return { ok: false, status: 401, error: 'missing token' };
  try {
    const p = verifyToken(token);
    // 旧 token 无 tenantId claim → 回退 'system'（种子租户）
    return { ok: true, status: 200, role: p.role, display_name: p.display_name, username: p.username, tenantId: p.tenantId || 'system' };
  } catch {
    return { ok: false, status: 401, error: 'invalid token' };
  }
}
```
（`issueToken` 本身无需改——它只 `JSON.stringify(payload)`，payload 自带 tenantId 即落 claim。`auth.js:7-13` 不变。）

- [ ] **Step 4: 写迁移脚本并跑**

`db/migrate-tenant.js`（幂等，禁删铁律）：

```js
// db/migrate-tenant.js
import { queryWrite } from './db.js';

export async function migrateTenant() {
  // 1) 用户表绑租户（种子租户 system）
  await queryWrite(`ALTER TABLE crm.crm_users ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'system'`);
  await queryWrite(`CREATE INDEX IF NOT EXISTS idx_crm_users_tenant_username ON crm.crm_users (tenant_id, username)`);
  // 2) mcp_identity 绑租户
  await queryWrite(`ALTER TABLE crm.mcp_identity ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'system'`);
  // 3) 决策域（T5 先建，此处一并幂等）
  await queryWrite(`ALTER TABLE crm.decision_scenario ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'system'`);
  await queryWrite(`ALTER TABLE crm.decision ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'system'`);
  await queryWrite(`ALTER TABLE crm.audit_event ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'system'`);
  // 4) config_store：加 tenant_id 并重建 PK 为 (tenant_id, key)
  await queryWrite(`ALTER TABLE crm.config_store ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'system'`);
  await queryWrite(`UPDATE crm.config_store SET tenant_id='system' WHERE tenant_id IS NULL`);
  await queryWrite(`ALTER TABLE crm.config_store ALTER COLUMN tenant_id SET NOT NULL`);
  await queryWrite(`ALTER TABLE crm.config_store DROP CONSTRAINT IF EXISTS config_store_pkey`);
  await queryWrite(`ALTER TABLE crm.config_store ADD PRIMARY KEY (tenant_id, key)`);
  // 5) decision_scenario 查询隔离索引
  await queryWrite(`CREATE INDEX IF NOT EXISTS idx_decision_tenant ON crm.decision (tenant_id)`);
  await queryWrite(`CREATE INDEX IF NOT EXISTS idx_audit_event_tenant ON crm.audit_event (tenant_id)`);
  console.log('[migrate-tenant] OK');
}
// 直接运行：node db/migrate-tenant.js
if (import.meta.url === `file://${process.argv[1]}`) { migrateTenant().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); }); }
```

```bash
PGDATABASE=plm_test node db/migrate-tenant.js
```
期望：`[migrate-tenant] OK`。

- [ ] **Step 5: 重跑测试确认通过**

```bash
PGDATABASE=plm_test npx vitest run test/multi-tenant.test.js -t "T1"
```
期望：PASS。

- [ ] **Step 6: 提交**

```bash
git add src/http/auth.js db/migrate-tenant.js test/multi-tenant.test.js
git commit -m "feat(multitenant): T1 身份层——resolveMe 携带 tenantId，旧 token 回退 system；迁移加列"
```

---

## Task T2：读作用域（通配 + 全量替换）

**Files:**
- Create: `src/http/tenantScope.js`
- Modify: `src/particles/particleRepo.js:120-127`（`queryParticles` 通配）
- Modify: `src/http/routes.js`（41 处）、`workbenchRouter.js:40-42`、`funnelRouter.js:41,100`、`namedAccountAssignRouter.js:23`、`businessBoard.js:109`、`approvalFlow.js:83`、`mcp/gateway.js:61,86,123,139`
- Test: `test/multi-tenant.test.js`（T2 段：行级隔离）

- [ ] **Step 1: 写失败测试（两租户同 slug 不串；admin 见全部）**

```js
// test/multi-tenant.test.js（T2 段）—— 用真实 repo + node 直连
import { describe, it, expect, beforeAll } from 'vitest';
import { createParticle, queryParticles } from '../src/particles/particleRepo.js';
import { scopeTenant } from '../src/http/tenantScope.js';

describe('T2 读作用域：行级隔离', () => {
  it('queryParticles 通配 * 省略 tenant 条件', async () => {
    const all = await queryParticles({ type: 'CRM_ACCOUNT', tenantId: '*' });
    const scoped = await queryParticles({ type: 'CRM_ACCOUNT', tenantId: 'acme' });
    // 全部 tenant 数量 >= 单租户数量
    expect(all.length).toBeGreaterThanOrEqual(scoped.length);
  });

  it('普通用户 scopeTenant 取自身租户；admin 取 *', () => {
    expect(scopeTenant({ role: 'sales', tenantId: 'acme' })).toBe('acme');
    expect(scopeTenant({ role: 'admin', tenantId: 'acme' })).toBe('*');
    expect(scopeTenant({ role: 'sales' })).toBe('system'); // 缺省回退
  });

  it('同 slug 两租户各见各（不串）', async () => {
    const slug = `iso-${Date.now()}`;
    await createParticle('CRM_ACCOUNT', { name: 'AcmeCo', slug }, { tenantId: 'acme', actor: 'u1' });
    await createParticle('CRM_ACCOUNT', { name: 'AcmeCo', slug }, { tenantId: 'globex', actor: 'u2' });
    const a = await queryParticles({ type: 'CRM_ACCOUNT', tenantId: 'acme' });
    const g = await queryParticles({ type: 'CRM_ACCOUNT', tenantId: 'globex' });
    expect(a.filter(r => r.slug === slug).length).toBe(1);
    expect(g.filter(r => r.slug === slug).length).toBe(1);
    expect(a.find(r => r.slug === slug).tenant_id).toBe('acme');
    expect(g.find(r => r.slug === slug).tenant_id).toBe('globex');
  });
});
```

- [ ] **Step 2: 跑测试确认失败（通配未实现 / scopeTenant 不存在）**

```bash
PGDATABASE=plm_test npx vitest run test/multi-tenant.test.js -t "T2"
```
期望：FAIL（模块未导出 / SQL 仍带 tenant 过滤）。

- [ ] **Step 3: 写 tenantScope.js + 改 queryParticles 通配**

`src/http/tenantScope.js`：

```js
// src/http/tenantScope.js —— 读作用域解析（纯函数，便于单测）
// admin（sysadmin）跨租户通配 '*'；普通用户取自身租户；缺省回退种子租户 'system'
export function scopeTenant(me) {
  if (me && (me.role === 'admin' || me.role === 'sysadmin')) return '*';
  return (me && me.tenantId) || 'system';
}
// 写作用域：永远取自身租户（写不跨租户），admin 也写自身所属租户（system）
export function scopeOf(me) {
  return (me && me.tenantId) || 'system';
}
```

`src/particles/particleRepo.js:120-127` 改：

```js
export async function queryParticles({ type, tenantId = 'system', limit = 100 } = {}) {
  // tenantId === '*' → 跨租户通配（admin），省略 tenant 条件
  if (tenantId === '*') {
    const r = await query(
      `SELECT * FROM particles WHERE ($1::text IS NULL OR type=$1)
       ORDER BY created_at DESC LIMIT $2`,
      [type || null, limit]
    );
    return r.rows;
  }
  const r = await query(
    `SELECT * FROM particles WHERE tenant_id=$1 AND ($2::text IS NULL OR type=$2)
     ORDER BY created_at DESC LIMIT $3`,
    [tenantId, type || null, limit]
  );
  return r.rows;
}
```

- [ ] **Step 4: routes.js 全量替换（41 处）**

在 `routes.js` 顶部 import：`import { scopeTenant, scopeOf } from './tenantScope.js';`

**机械替换规则**（每条 `queryParticles({... tenantId: 'system' ...})` 改为 `tenantId: scopeTenant(me)`；`listTasks({ tenantId: 'system' })` 改为 `tenantId: scopeTenant(me)`）：

- 凡 handler 内已有 `const me = resolveMe(req)`（或 `await resolveMe(req)`）→ 该 handler 内全部 `tenantId: 'system'` 替换为 `tenantId: scopeTenant(me)`。
- 具体行号（来自源码审计）：`165, 167, 168, 169, 262, 263, 264, 265, 310, 311, 312, 313, 391, 508, 598, 618, 703, 752, 852, 896, 897, 898, 962, 1007, 1030, 1159, 1170, 1171, 1257, 1268, 1390, 1500, 1611, 1612, 1714, 1759, 1798, 1877, 1886` 均为 query 点 → `scopeTenant(me)`。
- **两处写 ctx 例外**（必须用 `scopeOf`/`me.tenantId`，不跨租户）：
  - `routes.js:454` `const ctx = { tenantId: 'system', actor: me.username... }` → `tenantId: scopeOf(me)`
  - `routes.js:2696` 是 config 状态迁移（platform-global，保持 `tenantId: 'system'` 不变 —— 属 T4 平台配置域）。
- **代表示例（routes.js:165 财务 admin 视图）**：

```js
  const contracts = await queryParticles({ type: 'CRM_CONTRACT', tenantId: scopeTenant(me), limit: 200 }).catch(() => []);
  const [payments, invoices, plans] = await Promise.all([
    queryParticles({ type: 'CRM_PAYMENT_PLAN', tenantId: scopeTenant(me), limit: 500 }).catch(() => []),
    queryParticles({ type: 'CRM_PAYMENT_RECORD', tenantId: scopeTenant(me), limit: 500 }).catch(() => []),
    queryParticles({ type: 'CRM_INVOICE', tenantId: scopeTenant(me), limit: 500 }).catch(() => []),
  ]);
```

> 注：少数 handler（如 `routes.js:391` `/api/particles`）当前 `me` 为 `resolveMe(req)` 同步调用，已存在 `me` 变量，直接替换即可。每个替换点确保该作用域内有 `me`（`routes.js` 41 处所在 handler 全部已 `resolveMe`，已逐行核对）。

- [ ] **Step 5: 其余 router 同款替换**

- `workbenchRouter.js:40-42`：`queryApprovalTasks/queryApprovalInstances/queryKanbanTasks` 的 `tenantId:'system'` → `tenantId: scopeTenant(me)`，其中 `me` 取自 `currentActor`（L33-37 已解 `me.username/roles`，补 `tenantId` 透传：L36 `return { username: me.username, roles: [me.role], tenantId: me.tenantId }`）。
- `funnelRouter.js:41,100` `tenantId:'system'` → `tenantId: scopeTenant(me)`（funnel handler 已有 `me`）。
- `namedAccountAssignRouter.js:23` `listAccounts` 内 `tenantId:'system'` → `scopeTenant(me)`。
- `businessBoard.js:109` `tenantId:'system'` → `scopeTenant(me)`（该模块需 import scopeTenant）。
- `approvalFlow.js:83` `queryParticles({ type:'CRM_APPROVAL_FLOW', tenantId:'system' })` → `scopeTenant(me)`（该 router 已有 `me`）。
- `mcp/gateway.js:61,86,123,139` `tenantId:'system'` → 保持 `'system'`（MCP 通道为平台级 agent 身份，非终端用户租户；属设计“平台配置/agent 通道”范围，不污染业务租户隔离）。**不改。**

- [ ] **Step 6: 重跑 T1+T2 测试**

```bash
PGDATABASE=plm_test npx vitest run test/multi-tenant.test.js -t "T1|T2"
```
期望：PASS。

- [ ] **Step 7: 提交**

```bash
git add src/http/tenantScope.js src/particles/particleRepo.js src/http/routes.js src/http/workbenchRouter.js src/http/funnelRouter.js src/http/namedAccountAssignRouter.js src/portal/businessBoard.js src/portal/approvalFlow.js
git commit -m "feat(multitenant): T2 读作用域——queryParticles 通配 *；routes/router 41+ 处改 scopeTenant(me)"
```

---

## Task T3：审批域（engine/flow 参数化）

**Files:**
- Modify: `src/approval/engine.js`（`TENANT` 常量 L11 → 函数参数透传：`startInstance` L130 / `advanceTask` L178 / `withdrawInstance` L211 / `addSignTask` L230 / `transferTask` L251 / `returnTask` L279 / `loadFlow` L114）
- Modify: `src/approval/flow.js`（`getFlow` L51 增 tenantId）
- Test: `test/multi-tenant.test.js`（T3 段：跨租户不串）

- [ ] **Step 1: 写失败测试（同 slug 两租户各自审批流互不串）**

```js
// test/multi-tenant.test.js（T3 段）
import { describe, it, expect } from 'vitest';
import { writeFlowFromStages, getFlowByDomain } from '../src/approval/flow.js';
import { startInstance, getParticle, queryParticles } from '../src/particles/particleRepo.js';

describe('T3 审批域：跨租户不串', () => {
  it('两租户同 domain 各写各流，startInstance 落各自租户', async () => {
    const f1 = await writeFlowFromStages({ flow_id: 'quote', name: 'Q-acme', stages: [{ stage: 1, role: 'sales', action: 'approve', auto_allowed: false }] }, 'acme');
    const f2 = await writeFlowFromStages({ flow_id: 'quote', name: 'Q-globex', stages: [{ stage: 1, role: 'sales', action: 'approve', auto_allowed: false }] }, 'globex');
    const fid1 = (await getFlowByDomain('quote', 'acme')).id;
    const fid2 = (await getFlowByDomain('quote', 'globex')).id;
    expect(fid1).not.toBe(fid2);
    const inst1 = await startInstance(fid1, 'CRM_QUOTATION', `b1-${Date.now()}`, {}, { submitter: 'u1', tenantId: 'acme' });
    const inst1p = await getParticle(inst1.id);
    expect(inst1p.tenant_id).toBe('acme');
    // globex 租户见不到 acme 的实例
    const gInstances = await queryParticles({ type: 'CRM_APPROVAL_INSTANCE', tenantId: 'globex' });
    expect(gInstances.find(r => r.id === inst1.id)).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败（TENANT 常量未参数化，跨租户串）**

```bash
PGDATABASE=plm_test npx vitest run test/multi-tenant.test.js -t "T3"
```
期望：FAIL（`startInstance` 第二个参数未接收 tenantId / inst.tenant_id 非 'acme'）。

- [ ] **Step 3: 改 engine.js —— 透传 tenantId**

`engine.js:11` 删 `const TENANT = 'system';`（改为函数参数默认）。

`loadFlow(flow_id, tenantId='system')`（L114）：

```js
async function loadFlow(flow_id, tenantId = 'system') {
  const flow = await getParticle(flow_id);
  if (!flow) throw new Error(`审批流不存在: ${flow_id}`);
  const nodes = (await queryParticles({ type: 'CRM_APPROVAL_NODE', tenantId }))
    .filter(r => r.payload.flow_id === flow_id).sort((a, b) => (a.payload.pos || 0) - (b.payload.pos || 0));
  const links = (await queryParticles({ type: 'CRM_APPROVAL_LINK', tenantId }))
    .filter(r => r.payload.from_node && nodes.some(n => n.id === r.payload.from_node));
  const approvers = (await queryParticles({ type: 'CRM_APPROVAL_APPROVER', tenantId }))
    .filter(r => nodes.some(n => n.id === r.payload.node_id));
  const conditions = (await queryParticles({ type: 'CRM_APPROVAL_CONDITION', tenantId }))
    .filter(r => nodes.some(n => n.id === r.payload.node_id));
  return { flow, nodes, links, approvers, conditions };
}
```

`startInstance(flow_id, business_type, business_id, ctx, { submitter, approvers = [], tenantId = 'system' })`（L130 签名增 `tenantId`，并所有 `TENANT` → `tenantId`）：

- L131 `const fd = await loadFlow(flow_id, tenantId);`
- L141/153/162/171 `createParticle('CRM_APPROVAL_INSTANCE'/'CRM_APPROVAL_TASK', {...}, { tenantId })`（替换 `TENANT`）。

同理：`advanceTask(instance_id, task_id, { approver, decision, opinion = '', tenantId = 'system' })` 签名增 `tenantId`；其内 L181/197/218/236/264/290/315 的 `queryParticles(... tenantId: TENANT)` 与 `createParticle(... { tenantId: TENANT })` 全部改 `tenantId`。`loadFlow(inst.payload.flow_id, tenantId)`（L204/298）。`withdrawInstance(instance_id, { by, tenantId='system' })`、`addSignTask(..., { approver, by, tenantId='system' })`、`transferTask(..., { to, by, tenantId='system' })`、`returnTask(..., { approver, back_node_id, opinion, by, tenantId='system' })` 同款增参 + 替换 `TENANT`。

- [ ] **Step 4: 改 flow.js —— getFlow 增 tenantId**

`flow.js:51`：

```js
export async function getFlow(flow_id, tenantId = 'system') {
  const flow = await getParticle(flow_id);
  if (!flow) throw new Error(`审批流不存在: ${flow_id}`);
  const nodes = (await queryParticles({ type: 'CRM_APPROVAL_NODE', tenantId }))
    .filter(r => r.payload.flow_id === flow_id);
  return { ...flow, payload: { ...flow.payload, nodes } };
}
```
（`writeFlowFromStages`/`getFlowByDomain` 已在 `flow.js` 带 `tenantId` 默认参数，无需改。）

- [ ] **Step 5: 验证调用方兼容**

`routes.js` 的 `/api/action/:name` dispatch（L2671 `tenantId: me.tenantId || 'system'`）已传 `ctx.tenantId`；`seed-actions.js` 调 `startInstance(fid, ..., ctx, { submitter })` 需补 `tenantId: ctx.tenantId`：

```js
// src/action/seed-actions.js（crm-quote-submit 等 4 处）startInstance 调用增 tenantId
await startInstance(fid, 'CRM_QUOTATION', quote_id, ctx, { submitter, tenantId: ctx.tenantId || 'system' });
```

- [ ] **Step 6: 重跑 T1+T2+T3**

```bash
PGDATABASE=plm_test npx vitest run test/multi-tenant.test.js -t "T1|T2|T3"
```
期望：PASS。

- [ ] **Step 7: 提交**

```bash
git add src/approval/engine.js src/approval/flow.js src/action/seed-actions.js test/multi-tenant.test.js
git commit -m "feat(multitenant): T3 审批域——engine/flow TENANT 常量参数化透传；submit 经 ctx.tenantId"
```

---

## Task T4：配置面（config_store per-tenant + 共享模块）

**Files:**
- Create: `src/config/configStore.js`
- Modify: `src/http/configRouter.js` + 6 个 config router + `autonomyEngine/contextGuard/agentLoop/ruleResolver/financeAlertHook/llm/client`（共 ~15 读点 / ~8 写点）
- Test: `test/multi-tenant.test.js`（T4 段：租户读默认回退）

- [ ] **Step 1: 写失败测试（新租户读默认回退；PUT 后覆盖不污染 system）**

```js
// test/multi-tenant.test.js（T4 段）
import { describe, it, expect, beforeAll } from 'vitest';
import { readConfig, writeConfig } from '../src/config/configStore.js';

describe('T4 配置面：per-tenant + 回退', () => {
  it('新租户读某 key 回退 system 默认', async () => {
    // 假设 system 已有 sales-thresholds（种子），acme 无 → 应回退
    const sys = await readConfig('sales-thresholds', { tenantId: 'system' });
    const acme = await readConfig('sales-thresholds', { tenantId: 'acme' });
    expect(acme.value).toEqual(sys.value);
  });

  it('租户 PUT 后覆盖生效且不污染 system', async () => {
    const override = { bantcc_pass: 5 };
    await writeConfig('sales-thresholds', override, { tenantId: 'acme', updatedBy: 'u1' });
    const acme = await readConfig('sales-thresholds', { tenantId: 'acme' });
    const sys = await readConfig('sales-thresholds', { tenantId: 'system' });
    expect(acme.value).toEqual(override);
    expect(sys.value).not.toEqual(override); // system 默认未被污染
  });
});
```

- [ ] **Step 2: 跑测试确认失败（configStore 模块不存在）**

```bash
PGDATABASE=plm_test npx vitest run test/multi-tenant.test.js -t "T4"
```
期望：FAIL（模块未创建）。

- [ ] **Step 3: 写 configStore.js（共享读写，read 带回退）**

```js
// src/config/configStore.js —— config_store 统一读写（per-tenant + system 回退）
import { query, queryWrite } from '../db.js';

const PLATFORM = 'system';

// 读：先查 (tenantId, key)，无则回退 (system, key)，再无返回 null
export async function readConfig(key, { tenantId = PLATFORM } = {}) {
  if (tenantId !== PLATFORM) {
    const r = await query(
      `SELECT value, decision_id FROM config_store WHERE tenant_id=$1 AND key=$2`, [tenantId, key]);
    if (r.rows[0]) return r.rows[0];
  }
  const r = await query(
    `SELECT value, decision_id FROM config_store WHERE tenant_id=$1 AND key=$2`, [PLATFORM, key]);
  return r.rows[0] || null;
}

// 写：按 tenantId 落 (tenant_id, key)；冲突更新（禁删铁律）
export async function writeConfig(key, value, { tenantId = PLATFORM, decisionId = null, updatedBy = 'system' } = {}) {
  await queryWrite(
    `INSERT INTO config_store (tenant_id, key, value, decision_id, updated_by, updated_at)
     VALUES ($1, $2, $3::jsonb, $4, $5, now())
     ON CONFLICT (tenant_id, key) DO UPDATE SET value=$3::jsonb, decision_id=$4, updated_by=$5, updated_at=now()`,
    [tenantId, key, JSON.stringify(value), decisionId, updatedBy]
  );
}
```

- [ ] **Step 4: 迁移 config_store（已在 T1 migrate-tenant.js 完成 PK 重建；此处确认幂等）**

`PGDATABASE=plm_test node db/migrate-tenant.js` 已含 `DROP CONSTRAINT config_store_pkey` + `ADD PRIMARY KEY (tenant_id, key)`。确认执行成功（T1 已跑）。

- [ ] **Step 5: 重构所有 config 读写点**

**读点（原 `SELECT value FROM config_store WHERE key=$1` → `readConfig(key, {tenantId})`）：**

| 文件:行 | 改法 |
|---|---|
| `configRouter.js:21` | `readConfig: async (key) => readConfig(key, { tenantId: scopeTenant(me) })`（需 import + 取 me） |
| `behaviorStandardRouter.js:19` | `readConfig(CONFIG_KEY, { tenantId: scopeTenant(me) })` |
| `financeReceivablesConfigRouter.js:25` | 同上 |
| `namedAccountTargetsRouter.js:27` | 同上 |
| `salesThresholdsRouter.js:86` | 同上 |
| `sevenDimRouter.js:54,69,75` | `readConfig(CONFIG_KEY, { tenantId: scopeTenant(me) })` |
| `controlledConfigPages.js:61` | `readConfig(key, { tenantId: scopeTenant(me) })` |
| `autonomyEngine.js:14` | `readConfig('autonomy-conf', { tenantId: 'system' })`（平台级校准，保持 system） |
| `contextGuard.js:17` | `readConfig(key, { tenantId: 'system' })`（平台级护栏，保持 system） |
| `agentLoop.js:37` | `readConfig('auditability-sla-monitor', { tenantId: 'system' })` |
| `ruleResolver.js` / `financeAlertHook.js:25` | `readConfig('<key>', { tenantId: 'system' })`（出厂阈值平台级） |
| `llm/client.js:22` | `readConfig('llm', { tenantId: scopeTenant(me) })`（LLM 配置按租户，可覆盖） |

> 平台级（autonomy/context-guard/agentLoop/ruleResolver/financeAlertHook）读 **system**（不按租户），保持全局策略一致——符合设计“平台配置共享”；业务阈值类（sales-thresholds/named-account-targets/finance-receivables/behavior-standard/llm/seven-dim）按 `scopeTenant(me)` 实现 per-tenant 覆盖。

**写点（原 `INSERT ... ON CONFLICT (key)` → `writeConfig(key, value, {tenantId, decisionId, updatedBy})`）：**

| 文件:行 | 改法 |
|---|---|
| `configRouter.js:24-29` | `writeConfig(key, value, { tenantId: scopeTenant(me), decisionId, updatedBy: 'system' })` |
| `behaviorStandardRouter.js:54-58` | `writeConfig(CONFIG_KEY, next, { tenantId: scopeTenant(me), decisionId, updatedBy: 'system' })` |
| `financeReceivablesConfigRouter.js:49-53` | 同上 |
| `namedAccountTargetsRouter.js:58-62` | 同上 |
| `salesThresholdsRouter.js:125-129` | 同上 |
| `sevenDimRouter.js`（writeStrictness/writeEdgeBindings/writeRootCauseThresholds） | `writeConfig(CONFIG_KEY, {...}, { tenantId: scopeTenant(me), decisionId })` |
| `calibration/knobs/*`（weight/threshold/sevenDimConfigStrategy） | 平台级校准：`writeConfig('autonomy-conf'/'seven-dim', next, { tenantId: 'system', decisionId, updatedBy: 'calibration' })` |

> 写点 GET `me`：各 config router 已有 `ensureRole`/`ensureAdmin` 内 `me = resolveMe(req)`，取其 `tenantId`；calibration knobs 是平台级（sysadmin 校准），保持 system。

- [ ] **Step 6: 重跑 T1+T2+T3+T4**

```bash
PGDATABASE=plm_test npx vitest run test/multi-tenant.test.js
```
期望：全 PASS。

- [ ] **Step 7: 提交**

```bash
git add src/config/configStore.js src/http/configRouter.js src/http/behaviorStandardRouter.js src/http/financeReceivablesConfigRouter.js src/http/namedAccountTargetsRouter.js src/http/salesThresholdsRouter.js src/http/sevenDimRouter.js src/http/controlledConfigPages.js src/decision/autonomyEngine.js src/decision/contextGuard.js src/agent/agentLoop.js src/approval/ruleResolver.js src/alerts/financeAlertHook.js src/llm/client.js src/calibration/knobs
git commit -m "feat(multitenant): T4 配置面——configStore 共享模块(tenant 回退)；15 读点/8 写点重构 per-tenant"
```

---

## Task T5：决策/审计分租户

**Files:**
- 已在 T1 `migrate-tenant.js` 加列（decision_scenario/decision/audit_event 的 tenant_id）
- Modify: `src/decision/*`（查询加 tenant 过滤）、`src/http/routes.js` 决策相关端点（L2085/2104/2164 等）读 `me.tenantId`
- Test: `test/multi-tenant.test.js`（T5 段：决策链 per-tenant）

- [ ] **Step 1: 写失败测试（两租户 decision 互不串）**

```js
// test/multi-tenant.test.js（T5 段）
import { describe, it, expect } from 'vitest';
import { query } from '../src/db.js';

describe('T5 决策/审计分租户', () => {
  it('decision 表按 tenant_id 隔离', async () => {
    await query(`INSERT INTO crm.decision (decision_id, scenario_id, tenant_id, status) VALUES ($1,$2,$3,$4)`,
      [`d-${Date.now()}-a`, 'CALIBRATION_CHANGE', 'acme', 'OPEN']);
    await query(`INSERT INTO crm.decision (decision_id, scenario_id, tenant_id, status) VALUES ($1,$2,$3,$4)`,
      [`d-${Date.now()}-g`, 'CALIBRATION_CHANGE', 'globex', 'OPEN']);
    const a = await query(`SELECT * FROM crm.decision WHERE tenant_id='acme'`);
    const g = await query(`SELECT * FROM crm.decision WHERE tenant_id='globex'`);
    expect(a.rows.every(r => r.tenant_id === 'acme')).toBe(true);
    expect(g.rows.every(r => r.tenant_id === 'globex')).toBe(true);
  });
});
```

- [ ] **Step 2: routes.js 决策端点加 scopeTenant(me)**

`routes.js:2085 /api/decisions/:id/disposition`、`2104 /api/decision/:id/outcome`、`2164 /api/decision/:id/feedback`：各 handler 内 `query(... WHERE ...)` 增 `AND tenant_id=$N`（参数取 `scopeTenant(me)`；admin 通配 `'*'` 时需省略——用 `tenantId === '*' ? '' : 'AND tenant_id=$x'` 分支，或直接 `scopeTenant(me)` 后若 `'*'` 走全量）。最简：决策端点保持 admin 专用（已有 `requireMe` + role 校验），普通用户不可直达 → 这些端点 `me.role==='admin'` 时 `scopeTenant` 返回 `'*'`，SQL 需兼容：

```js
// routes.js 决策查询助手
function decisionWhere(me, baseParams) {
  const sc = scopeTenant(me);
  if (sc === '*') return { clause: '', params: baseParams };
  return { clause: ' AND tenant_id=$' + (baseParams.length + 1), params: [...baseParams, sc] };
}
```

- [ ] **Step 3: calibration/decision 查询隔离**

`calibration/store.js` `readConf`/`writeConf` 平台级（sysadmin 校准）保持 system；`decision/autonomyEngine.js requireDecision` 内 `SELECT * FROM decision_scenario WHERE scenario_id=$1` 增 `AND tenant_id=$2`（参数 `scopeTenant(me)`）——决策场景按租户隔离（设计 §5）。

- [ ] **Step 4: 重跑全量测试**

```bash
PGDATABASE=plm_test npx vitest run test/multi-tenant.test.js
```
期望：PASS。

- [ ] **Step 5: 提交**

```bash
git add src/http/routes.js src/decision/autonomyEngine.js src/decision
git commit -m "feat(multitenant): T5 决策/审计分租户——查询加 tenant 过滤；决策场景 per-tenant"
```

---

## Task T6：租户管理 + 行级隔离 E2E + 迁移

**Files:**
- Create: `src/http/tenantRouter.js`（GET/POST /api/tenants）
- Create: `scripts/seed-tenant-demo.mjs`（演示租户 + 用户 + 业务）
- Modify: `src/http/server.js`（挂载 tenantRouter）
- Test: `test/multi-tenant.test.js`（E2E 段）+ 全量回归

- [ ] **Step 1: 写失败测试（租户管理端点 + 端到端隔离）**

```js
// test/multi-tenant.test.js（T6 段）—— 注入式测 tenantRouter
import { describe, it, expect } from 'vitest';
import { createWorkbenchRouter } from '../src/http/workbenchRouter.js'; // 复用 createApp 风格

describe('T6 租户管理 + E2E 隔离', () => {
  it('POST /api/tenants 需 admin 闸；GET 列出租户', async () => {
    const { createTenantRouter } = await import('../src/http/tenantRouter.js');
    let guardHit = false;
    const router = createTenantRouter({
      deps: {
        ensureAdmin: async (req) => { const me = req.__me; if (me?.role !== 'admin') { guardHit = true; return null; } return me; },
        createTenant: async ({ tenantId, adminUser }) => ({ tenantId, adminUser }),
        listTenants: async () => ([{ tenant_id: 'system' }, { tenant_id: 'acme' }]),
      },
    });
    // 普通用户被拦
    const res1 = { statusCode: 0, body: null };
    res1.status = (c) => { res1.statusCode = c; return res1; };
    res1.json = (o) => { res1.body = o; return res1; };
    await router.handlers.post({ __me: { role: 'sales' } }, res1);
    expect(res1.statusCode).toBe(403);
    expect(guardHit).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
PGDATABASE=plm_test npx vitest run test/multi-tenant.test.js -t "T6"
```
期望：FAIL（tenantRouter 未创建）。

- [ ] **Step 3: 写 tenantRouter.js**

```js
// src/http/tenantRouter.js —— 租户管理面（admin 闸 + 决策第0闸）
import { Router } from 'express';
import { query, queryWrite } from '../db.js';
import { resolveMe as realResolveMe } from './auth.js';
import { produceDecision } from '../calibration/store.js'; // 第0闸

export function createTenantRouter({ deps } = {}) {
  const defaultDeps = {
    ensureAdmin: async (req, res) => {
      const me = await realResolveMe(req).catch(() => ({ ok: false }));
      if (!me?.ok || me.role !== 'admin') { res.status(403).json({ error: '需要 admin 权限' }); return null; }
      return me;
    },
    createTenant: async ({ tenantId, adminUser, adminPass }) => {
      // 禁删铁律：建租户=插 crm_users（新 username + tenant_id）；系统配置留空（read-fallback 接管）
      const { rows } = await query(`SELECT 1 FROM crm.crm_users WHERE username=$1`, [adminUser]);
      if (rows.length) throw new Error('用户名已存在');
      const pw = await query(`SELECT crypt($1, gen_salt('bf')) AS h`, [adminPass]);
      await queryWrite(
        `INSERT INTO crm.crm_users (username, password_hash, role, display_name, tenant_id)
         VALUES ($1, $2, 'admin', $3, $4)`,
        [adminUser, pw.rows[0].h, adminUser, tenantId]);
      return { tenantId, adminUser };
    },
    listTenants: async () => {
      const r = await query(
        `SELECT tenant_id, count(*) AS users,
                (SELECT count(*) FROM particles p WHERE p.tenant_id=u.tenant_id) AS particles
         FROM crm.crm_users u GROUP BY tenant_id ORDER BY tenant_id`);
      return r.rows;
    },
  };
  const D = { ...defaultDeps, ...deps };
  const router = Router();

  // GET /api/tenants（admin）
  router.get('/api/tenants', async (req, res) => {
    const me = await D.ensureAdmin(req, res); if (!me) return;
    try { res.json({ tenants: await D.listTenants() }); } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/tenants（admin + 第0闸）
  router.post('/api/tenants', async (req, res) => {
    const me = await D.ensureAdmin(req, res); if (!me) return;
    const { tenantId, adminUser, adminPass } = req.body || {};
    if (!tenantId || !adminUser || !adminPass) return res.status(400).json({ error: 'tenantId/adminUser/adminPass required' });
    try {
      // 决策第0闸：建租户记为 config_change 决策（审计留痕，禁删铁律）
      const decision = await produceDecision({ scenario_id: 'config_change', fields: ['tenant:' + tenantId] });
      const t = await D.createTenant({ tenantId, adminUser, adminPass });
      res.json({ ok: true, tenant: t, decisionId: decision?.decisionId || null });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  router.handlers = { post: router.post.bind(router), get: router.get.bind(router) };
  return router;
}
```

- [ ] **Step 4: 挂载到 server.js**

`src/http/server.js` 内 import 并 `app.use(createTenantRouter())`（对齐其它 router 挂载范式）。

- [ ] **Step 5: 写演示种子脚本**

`scripts/seed-tenant-demo.mjs`：经 `db.js` 直连，建租户 `acme`（用户 `acme_admin`/密码）+ 1 条 CRM_ACCOUNT（tenant_id='acme'）+ 1 条 config_store 覆盖（sales-thresholds 覆盖值，tenant_id='acme'）。**幂等**：已存在则跳过。

- [ ] **Step 6: 重跑全量回归 + E2E**

```bash
PGDATABASE=plm_test npx vitest run test/multi-tenant.test.js
node scripts/seed-tenant-demo.mjs   # 可选：造演示数据
```
期望：全 PASS；种子无报错。

- [ ] **Step 7: 提交**

```bash
git add src/http/tenantRouter.js src/http/server.js scripts/seed-tenant-demo.mjs test/multi-tenant.test.js
git commit -m "feat(multitenant): T6 租户管理——GET/POST /api/tenants(admin 闸+第0闸)；E2E 隔离+演示种子"
```

---

## 自检（plan 写后自查）

1. **Spec 覆盖**：设计文档四枢轴（行级/登录绑定/system种子+跨租户/全量per-tenant）→ T1(身份) T2(读) T3(审批) T4(配置) T5(决策) T6(管理) 全覆盖；契约 §A 6 条 success 均有对应测试断言。
2. **占位符扫描**：无 TBD/TODO；每行替换均给目标（`scopeTenant(me)` / `configStore.readConfig`）与行号；T4 大面用表格枚举逐点，非“类似前面”。
3. **类型一致**：`scopeTenant(me)` 签名 T2 定义、T2-T5 复用一致；`configStore.readConfig/writeConfig` 签名 T4 定义、各 router 调用一致；`startInstance(..., {tenantId})` T3 定义、seed-actions 调用一致。
4. **风险点**：T4 改动面最大（~15 读 + ~8 写点），已用共享模块收敛，避免每点手写回退 SQL；T2 41 处 routes 替换需逐行核对 `me` 变量存在（已确认 41 行所在 handler 全部 `resolveMe`）。

**执行前必做（沙箱外）**：`PGDATABASE=plm node db/migrate-tenant.js`（生产库加列需你本地授权后执行；vitest 自动跑 `plm_test`）。
