# MCP 身份签发治理缺陷修复 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 MCP 身份签发通道的五处治理缺陷（T1 提权角色闸 / T2 真 PATCH + 吊销不可逆 / T3 tenant_id 落库 / T4 下拉表单与文案分流 / T5 配置中心 TAB 占位），消除"sysadmin 看得见点不进"的死循环体感，并打掉被 stub 测试遮蔽的 L2 假绿。

**Architecture:** 后端 `src/portal/mcpIdentity.js` 为主改动点——管理通道 `list/create/put` 补显式 `requireAdmin`（与全局 `createConfigLevelGate` 路径精确匹配纵深防御）；`put` 改动态 SET 真 PATCH 并加"已吊销即 409"硬闸；`create` 显式落 `tenant_id`。前端 `mcp-identities.html` 改内联下拉表单（选项来自后端 `roles`，禁硬编码）；`my-api-keys.html` 文案按角色分流；`config.html` 系统级/传播 TAB 对非 ADMIN 显示不可点占位 + 替代通路文案（抽取 `src/portal/configTabs.js` 纯函数以便单测）。不改 `admin` 禁领 token 设计意图、不放宽 id27 `level:'system'`、不砍菜单。

**Tech Stack:** Node 22 ESM · Express 4 · vitest 3 · PostgreSQL(pg) · 纯前端 ESM + `/portal/*` 模块。

---

## 文件结构（本次改动）

| 文件 | 动作 | 任务 |
|---|---|---|
| `src/portal/mcpIdentity.js` | 改 | T1（`requireAdmin` + 3 handler 闸）· T2（`put` 真 PATCH + 吊销闸）· T3（`create` 落 `tenant_id`） |
| `src/web/mcp-identities.html` | 改 | T4（内联下拉表单 + 403 文案） |
| `src/web/my-api-keys.html` | 改 | T4（文案按角色分流） |
| `src/portal/configTabs.js` | **新** | T5（纯函数 `buildLevelTabs`） |
| `src/web/config.html` | 改 | T5（占位 TAB 渲染） |
| `test/web/mcpIdentity.test.js` | 改 | T1/T2（新返回契约 + 401/403/409 分支） |
| `test/portal/mcpIdentityAdminGate.test.js` | **新** | T1（stub Express 闸验证） |
| `test/portal/mcpIdentityPatch.test.js` | **新** | T2（真库集成） |
| `test/portal/mcpIdentityTenant.test.js` | **新** | T3（真库集成） |
| `test/portal/configTabs.test.js` | **新** | T5（纯函数单测） |

---

## Task 1 — T1：管理通道补显式 ADMIN 闸（堵提权链）

**Files:** Modify `src/portal/mcpIdentity.js`；Modify `test/web/mcpIdentity.test.js`；Create `test/portal/mcpIdentityAdminGate.test.js`

- [ ] **Step 1: 写失败测试（stub Express 闸验证）**

新建 `test/portal/mcpIdentityAdminGate.test.js`：

```js
// test/portal/mcpIdentityAdminGate.test.js — T1 集成（stub deps，验证角色闸放行/拦截）
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { createMcpIdentityRouter } from '../../src/portal/mcpIdentity.js';

const okMe = (role) => ({ ok: true, role, tenantId: 'system', username: `${role}-u`, id: `${role}-id` });

function mkApp(role) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.me = okMe(role); next(); });
  const deps = {
    resolveMe: (req) => req.me,
    list: async () => ({ rows: [], roles: [] }),
    create: async () => ({ row: { id: 'x' }, token_plaintext: 'tok' }),
    put: async () => ({ row: { id: 'x' } }),
    produceDecision: async () => ({ decisionId: null, ok: true }),
  };
  app.use(createMcpIdentityRouter(deps));
  return app;
}

let server, base;
beforeAll(() => new Promise((res) => { server = mkApp('sales').listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; res(); }); }));
afterAll(() => server.close());

describe('T1 管理通道角色闸', () => {
  it('sales GET /api/mcp-identities → 403', async () => {
    const r = await fetch(`${base}/api/mcp-identities`, { headers: { 'x-role': 'sales' } });
    expect(r.status).toBe(403);
  });
  it('sales POST /api/mcp-identities → 403', async () => {
    const r = await fetch(`${base}/api/mcp-identities`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-role': 'sales' }, body: '{}' });
    expect(r.status).toBe(403);
  });
  it('sales PUT /api/mcp-identities/:id → 403（提权链第③步被阻断）', async () => {
    const r = await fetch(`${base}/api/mcp-identities/x`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-role': 'sales' }, body: '{"role_tag":"sysadmin"}' });
    expect(r.status).toBe(403);
  });
  it('admin PUT /api/mcp-identities/:id → 200', async () => {
    const adminApp = mkApp('admin');
    const s2 = adminApp.listen(0, '127.0.0.1');
    await new Promise((res) => s2.once('listening', res));
    const port = s2.address().port;
    const r = await fetch(`http://127.0.0.1:${port}/api/mcp-identities/x`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-role': 'admin' }, body: '{"actor":"a"}' });
    expect(r.status).toBe(200);
    s2.close();
  });
  it('未登录 → 401', async () => {
    const app = express(); app.use(express.json());
    app.use((req, res, next) => { req.me = { ok: false, error: 'missing' }; next(); });
    app.use(createMcpIdentityRouter({ resolveMe: (req) => req.me, list: async () => ({ rows: [], roles: [] }) }));
    const s = app.listen(0, '127.0.0.1'); await new Promise((res) => s.once('listening', res));
    const r = await fetch(`http://127.0.0.1:${s.address().port}/api/mcp-identities`);
    expect(r.status).toBe(401);
    s.close();
  });
});
```

- [ ] **Step 2: 跑测试确认失败（当前无闸，全返回 200）**

```powershell
cd D:\system\CRM-ai-native
node node_modules/.bin/vitest run test/portal/mcpIdentityAdminGate.test.js
```

预期：前 3 个 `expect(403)` 失败（实为 200）；admin/401 用例因结构不同可能已部分满足，但整体 FAIL。

- [ ] **Step 3: 实现 requireAdmin + 三处 handler 闸**

编辑 `src/portal/mcpIdentity.js`：

在顶部 import 区新增（置于 `import { newStructuredToken } ...` 之后）：

```js
import { hasRole } from '../http/middleware/rbac.js';
```

在 `export function createMcpIdentityRouter(deps = {}) {` 之前新增：

```js
// 管理通道统一闸：MCP 身份签发 = 平台最高敏感写，仅 ADMIN。
// 与 createConfigLevelGate（rbac.js:86，路径精确匹配）纵深防御——
// 全局闸覆盖 /api/mcp-identities 精确路径，本闸覆盖含参数的子路径（如 PUT /:id）。
const requireAdmin = async (req, res) => {
  const me = await D.resolveMe(req);
  if (!me?.ok) { res.status(401).json({ error: me?.error || '未登录' }); return null; }
  if (!hasRole(me, 'ADMIN')) {
    res.status(403).json({ error: 'MCP 身份签发仅 ADMIN 可操作（凭据签发为平台最高敏感写）' });
    return null;
  }
  return me;
};
```

> 注意：`requireAdmin` 引用 `D`（在 `createMcpIdentityRouter` 内定义）。必须把它定义在 `createMcpIdentityRouter` **内部、handlers 之前**，或改为接收 `D` 参数。推荐：放在 `createMcpIdentityRouter` 函数体内、`const D = ...` 之后、`const handlers = ...` 之前。下方 Step 3 的最终落点以"函数体内"为准。

`list` handler 首行插入：

```js
    list: async (req, res) => {
      try {
        const me = await requireAdmin(req, res);
        if (!me) return;
        const { rows, roles } = await D.list();
```

`create` handler 首行插入：

```js
    create: async (req, res) => {
      try {
        const me = await requireAdmin(req, res);
        if (!me) return;
        const { actor, person_id, role_tag, scopes, expires_at } = req.body || {};
```

`put` handler 首行插入（完整 put 实现见 Task 2 Step 3，此处仅加闸行）：

```js
    put: async (req, res) => {
      try {
        const me = await requireAdmin(req, res);
        if (!me) return;
        const { id } = req.params;
```

- [ ] **Step 4: 跑测试确认通过**

```powershell
cd D:\system\CRM-ai-native
node node_modules/.bin/vitest run test/portal/mcpIdentityAdminGate.test.js
```

预期：全 PASS。

- [ ] **Step 5: 提交**

```powershell
cd D:\system\CRM-ai-native
git add src/portal/mcpIdentity.js test/portal/mcpIdentityAdminGate.test.js
git commit -m "feat(mcp-identity): T1 管理通道 list/create/put 补显式 ADMIN 角色闸，堵提权链"
```

---

## Task 2 — T2：put 改真 PATCH + 吊销不可逆 409

**Files:** Modify `src/portal/mcpIdentity.js`；Modify `test/web/mcpIdentity.test.js`；Create `test/portal/mcpIdentityPatch.test.js`

> **纪律**：D5 缺陷正是由 stub 测试遮蔽的 L2 假绿，本任务必须补**真库集成测试**，只改 stub 等于继续骗自己。

- [ ] **Step 1: 写失败测试（真库集成）**

新建 `test/portal/mcpIdentityPatch.test.js`：

```js
// test/portal/mcpIdentityPatch.test.js — T2 真库集成：打掉 L2 假绿（吊销必失败 + 已吊销复活）
import { test, expect, beforeAll, afterAll } from 'vitest';
import { createMcpIdentityRouter } from '../../src/portal/mcpIdentity.js';
import { query } from '../../src/db.js';

const adminMe = { ok: true, role: 'admin', tenantId: 'system', username: 'admin' };
const router = createMcpIdentityRouter({ resolveMe: async () => adminMe });

function mockRes() {
  let code = 200, body = null;
  return {
    status: (c) => { code = c; return { json: (p) => { body = p; } }; },
    json: (p) => { body = p; },
    get _code() { return code; }, get _body() { return body; },
  };
}

beforeAll(async () => {
  await query(`INSERT INTO crm.role_context_profile (role_tag) VALUES ('sales'),('sysadmin') ON CONFLICT (role_tag) DO NOTHING`);
});
afterAll(async () => {
  await query(`DELETE FROM crm.mcp_identity WHERE actor LIKE 'test-%'`);
});

async function seed(actor) {
  const id = 'test-' + actor + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  await query(
    `INSERT INTO crm.mcp_identity (id, token_hash, actor, role_tag, tenant_id, enabled)
     VALUES ($1, crypt('x', gen_salt('bf')), $2, 'sales', 'system', TRUE)`, [id, actor]);
  return id;
}

test('仅传 revoked_at → 吊销成功，actor/role_tag 不被写 NULL', async () => {
  const id = await seed('revoke-only');
  const res = mockRes();
  await router.handlers.put({ params: { id }, body: { revoked_at: new Date().toISOString() } }, res);
  expect(res._code).toBe(200);
  const row = (await query(`SELECT actor, role_tag, enabled, revoked_at FROM crm.mcp_identity WHERE id=$1`, [id])).rows[0];
  expect(row.actor).toBe('revoke-only');   // 关键：未被改 NULL（旧 bug 会撞 NOT NULL → 400）
  expect(row.role_tag).toBe('sales');
  expect(row.enabled).toBe(false);
  expect(row.revoked_at).toBeTruthy();
});

test('对已吊销行再 PUT → 409，revoked_at 永不被清空', async () => {
  const id = await seed('revoked-then-edit');
  const r1 = mockRes();
  await router.handlers.put({ params: { id }, body: { revoked_at: new Date().toISOString() } }, r1);
  expect(r1._code).toBe(200);
  const r2 = mockRes();
  await router.handlers.put({ params: { id }, body: { actor: 'changed' } }, r2);
  expect(r2._code).toBe(409);
  const row = (await query(`SELECT revoked_at, actor FROM crm.mcp_identity WHERE id=$1`, [id])).rows[0];
  expect(row.revoked_at).toBeTruthy();     // 关键：未被编辑清空
  expect(row.actor).toBe('revoked-then-edit');
});

test('仅传 actor → 其余字段（scopes/expires_at/enabled）保持原值', async () => {
  const id = await seed('keep-fields');
  await query(`UPDATE crm.mcp_identity SET scopes='{"deny_domains":["X"]}'::jsonb, expires_at='2030-01-01'::timestamptz WHERE id=$1`, [id]);
  const res = mockRes();
  await router.handlers.put({ params: { id }, body: { actor: 'renamed' } }, res);
  expect(res._code).toBe(200);
  const row = (await query(`SELECT actor, scopes, expires_at, enabled FROM crm.mcp_identity WHERE id=$1`, [id])).rows[0];
  expect(row.actor).toBe('renamed');
  expect(row.scopes).toEqual({ deny_domains: ['X'] });
  expect(String(row.expires_at)).toContain('2030');
  expect(row.enabled).toBe(true);
});
```

- [ ] **Step 2: 跑测试确认失败（旧全覆盖 UPDATE 撞 NOT NULL / 复活）**

```powershell
cd D:\system\CRM-ai-native
node node_modules/.bin/vitest run test/portal/mcpIdentityPatch.test.js
```

预期：第 1 个用例 FAIL（旧 `put` 把 actor 写 NULL → 400，且集成测试直接打真库）；其余用例因契约不符报错。

- [ ] **Step 3: 实现真 PATCH + 吊销闸 + 新返回契约**

编辑 `src/portal/mcpIdentity.js`：

替换 `defaultDeps.put`（约 80-87 行）为：

```js
  put: async (id, patch) => {
    // 吊销不可逆（与"绝对禁删"同源纪律）：已吊销行拒绝任何再修改，
    // 否则编辑操作会清空 revoked_at 使失效凭据复活（D5 安全事故）。
    const cur = (await query(
      `SELECT id, revoked_at FROM crm.mcp_identity WHERE id=$1`, [id])).rows[0];
    if (!cur) return { notFound: true };
    if (cur.revoked_at) return { revoked: true };
    // 真 PATCH：只写"显式传入"的列（未传 → 不出现在 SET 中）
    const COLS = ['actor', 'role_tag', 'scopes', 'enabled', 'expires_at', 'revoked_at'];
    const sets = []; const vals = [id]; let n = 1;
    for (const c of COLS) {
      if (!(c in patch)) continue;
      n += 1;
      sets.push(`${c}=$${n}${c === 'scopes' ? '::jsonb' : ''}`);
      vals.push(c === 'scopes' ? JSON.stringify(patch[c] || {}) : patch[c]);
    }
    if (!sets.length) return { noop: true };
    const r = await query(
      `UPDATE crm.mcp_identity SET ${sets.join(', ')}
        WHERE id=$1 RETURNING id, actor, role_tag, enabled, revoked_at`, vals);
    return { row: r.rows[0] || null };
  },
```

同步替换 `put` handler 的分支（约 216-219 行）为：

```js
        const updated = await D.put(id, patch);
        if (updated?.notFound) return res.status(404).json({ error: '身份不存在' });
        if (updated?.revoked)  return res.status(409).json({ error: '身份已吊销，不可再修改（吊销不可逆）' });
        if (updated?.noop)     return res.status(400).json({ error: '无可更新字段' });
        const decision = await D.produceDecision({ key: 'mcp-identity', id });
        res.json({ ok: true, row: updated.row, decision: decision?.decisionId || null });
```

- [ ] **Step 4: 同步单测新契约（改 test/web/mcpIdentity.test.js）**

在 `test/web/mcpIdentity.test.js` 中：

(a) `makeDeps` 基对象增加默认 `resolveMe`（否则 list/create/put 改闸后老测试会因 `D.resolveMe` 未定义而抛错）：

```js
    resolveMe: async () => ({ ok: true, username: 'admin', tenantId: 'system', role: 'admin', level: 'ADMIN' }),
```

(b) `makeDeps.put` stub 改为新契约 `{row}`：

```js
    put: async (id, patch) => {
      const row = store.find((s) => s.id === id);
      if (!row) return { notFound: true };
      Object.assign(row, patch);
      return { row };
    },
```

(c) 现有 `put 编辑生效` / `put 吊销置 revoked_at` 用例仍成立（stub 返回 `{row}`，handler 读取 `updated.row`）。

(d) 新增 409 单测分支：

```js
test('put 已吊销行 → 409 且 revoked_at 未清空', async () => {
  const deps = makeDeps({ put: async () => ({ revoked: true }) });
  const router = createMcpIdentityRouter(deps);
  const res = mockRes();
  await router.handlers.put({ params: { id: 'id-1' }, body: { actor: 'x' } }, res);
  expect(res._code).toBe(409);
});
```

- [ ] **Step 5: 跑测试确认全绿**

```powershell
cd D:\system\CRM-ai-native
node node_modules/.bin/vitest run test/portal/mcpIdentityPatch.test.js test/web/mcpIdentity.test.js
```

预期：全 PASS（含真库集成 3 例）。

- [ ] **Step 6: 提交**

```powershell
cd D:\system\CRM-ai-native
git add src/portal/mcpIdentity.js test/portal/mcpIdentityPatch.test.js test/web/mcpIdentity.test.js
git commit -m "fix(mcp-identity): T2 put 改动态SET真PATCH + 已吊销行409，消除吊销失败与复活"
```

---

## Task 3 — T3：管理 create 补 tenant_id 落库

**Files:** Modify `src/portal/mcpIdentity.js`；Create `test/portal/mcpIdentityTenant.test.js`

- [ ] **Step 1: 写失败测试（真库集成）**

新建 `test/portal/mcpIdentityTenant.test.js`：

```js
// test/portal/mcpIdentityTenant.test.js — T3 真库集成：tenant_id 显式落库
import { test, expect, beforeAll, afterAll } from 'vitest';
import { createMcpIdentityRouter } from '../../src/portal/mcpIdentity.js';
import { query } from '../../src/db.js';

const adminMe = { ok: true, role: 'admin', tenantId: 'system', username: 'admin' };
const router = createMcpIdentityRouter({ resolveMe: async () => adminMe });

function mockRes() {
  let code = 200, body = null;
  return {
    status: (c) => { code = c; return { json: (p) => { body = p; } }; },
    json: (p) => { body = p; },
    get _code() { return code; }, get _body() { return body; },
  };
}

beforeAll(async () => {
  await query(`INSERT INTO crm.role_context_profile (role_tag) VALUES ('sales') ON CONFLICT (role_tag) DO NOTHING`);
});
afterAll(async () => {
  await query(`DELETE FROM crm.mcp_identity WHERE actor LIKE 'test-tenant-%'`);
});

test('create 带 tenant_id → 落库该租户', async () => {
  const res = mockRes();
  await router.handlers.create({ body: { actor: 'test-tenant-acme', role_tag: 'sales', tenant_id: 'acme-auto' } }, res);
  expect(res._code).toBe(200);
  const row = (await query(`SELECT tenant_id FROM crm.mcp_identity WHERE id=$1`, [res._body.id])).rows[0];
  expect(row.tenant_id).toBe('acme-auto');
});

test('create 不带 tenant_id → 落库 system（平台级接入方）', async () => {
  const res = mockRes();
  await router.handlers.create({ body: { actor: 'test-tenant-system', role_tag: 'sales' } }, res);
  expect(res._code).toBe(200);
  const row = (await query(`SELECT tenant_id FROM crm.mcp_identity WHERE id=$1`, [res._body.id])).rows[0];
  expect(row.tenant_id).toBe('system');
});
```

- [ ] **Step 2: 跑测试确认失败（旧 INSERT 无 tenant_id 列 → 落默认 system）**

```powershell
cd D:\system\CRM-ai-native
node node_modules/.bin/vitest run test/portal/mcpIdentityTenant.test.js
```

预期：第 1 个用例 FAIL（落库值为 `system` 而非 `acme-auto`）。

- [ ] **Step 3: 实现 create 落 tenant_id**

编辑 `src/portal/mcpIdentity.js`：

替换 `defaultDeps.create`（约 70-78 行）为：

```js
  create: async (input) => {
    const { id, tokenPlain } = newStructuredToken();
    const r = await query(
      `INSERT INTO crm.mcp_identity (id, token_hash, actor, person_id, role_tag, scopes, expires_at, tenant_id)
       VALUES ($1, crypt($2, gen_salt('bf')), $3, $4, $5, $6::jsonb, $7, $8)
       RETURNING id, actor, role_tag, enabled, revoked_at, tenant_id`,
      [id, tokenPlain, input.actor, input.person_id || null, input.role_tag,
       JSON.stringify(input.scopes || {}), input.expires_at || null,
       input.tenant_id || 'system']);   // 平台级接入方默认 system；租户接入方由管理页显式指定
    return { row: r.rows[0], token_plaintext: tokenPlain };
  },
```

并在 `create` handler 透传 `tenant_id`（约 197 行）：

```js
        const { actor, person_id, role_tag, scopes, expires_at, tenant_id } = req.body || {};
        if (!actor || !role_tag) return res.status(400).json({ error: 'actor 与 role_tag 必填' });
        const created = await D.create({ actor, person_id, role_tag, scopes, expires_at, tenant_id });
```

- [ ] **Step 4: 跑测试确认通过**

```powershell
cd D:\system\CRM-ai-native
node node_modules/.bin/vitest run test/portal/mcpIdentityTenant.test.js
```

预期：全 PASS。

- [ ] **Step 5: 提交**

```powershell
cd D:\system\CRM-ai-native
git add src/portal/mcpIdentity.js test/portal/mcpIdentityTenant.test.js
git commit -m "fix(mcp-identity): T3 管理 create 显式落 tenant_id（默认 system，可指定租户）"
```

---

## Task 4 — T4：新增身份改内联下拉 + 文案分流

**Files:** Modify `src/web/mcp-identities.html`；Modify `src/web/my-api-keys.html`

> **纪律（UI 铁律 `docs/specs/2026-09-05-ui-authoring-rules.md`）**：改动前读该 spec；提交前必须 `node scripts/ui-lint.mjs` 通过，禁止 `--no-verify`、禁止加排除名单。

- [ ] **Step 1: 写失败断言（grep 角色字面量应不存在）**

无独立单测文件，用 grep 作为验收（见 Step 5）。先记录基线：当前 `mcp-identities.html:70` 硬编码了 `sales/manager/finance/presales/contract_admin`。

- [ ] **Step 2: 改 mcp-identities.html 为内联下拉表单**

编辑 `src/web/mcp-identities.html`：

(a) `load()` 内保存 `roles` 到模块作用域（在 `<script type="module">` 顶部加 `let ROLES = [];`，并在 `load()` 中 `ROLES = roles;`）。

(b) 替换 `document.getElementById('add').onclick = ...`（约 67-77 行）为：

```js
let ROLES = [];
// （上面这行放在 import 之后、load() 之前）

async function load() {
  const { rows, roles } = await get('/api/mcp-identities');
  ROLES = roles || [];
  document.getElementById('list').innerHTML = renderMcpIdentities(rows, ROLES);
  const s = mcpIdentitySummary(rows);
  document.getElementById('summary').textContent = `共 ${s.count} 个 · 启用 ${s.enabled} · 已吊销 ${s.revoked}`;
  bindRows();
}

document.getElementById('add').onclick = () => {
  const existing = document.getElementById('addForm');
  if (existing) { existing.remove(); return; }
  const form = document.createElement('div');
  form.id = 'addForm';
  form.className = 'add-form';
  form.innerHTML = `
    <label>接入方 actor <input class="f-actor-new" placeholder="如 kavak-bot" /></label>
    <label>角色 <select class="role-tag-new">${roleOptions(ROLES)}</select></label>
    <label>租户 tenant_id（可选，留空=平台级） <input class="f-tenant-new" placeholder="acme-auto 或留空" /></label>
    <div>
      <crm-button id="addSubmit">创建</crm-button>
      <crm-button id="addCancel">取消</crm-button>
    </div>`;
  document.querySelector('main').insertBefore(form, document.getElementById('list'));
  form.querySelector('#addCancel').onclick = () => form.remove();
  form.querySelector('#addSubmit').onclick = async () => {
    const actor = form.querySelector('.f-actor-new').value.trim();
    const role_tag = form.querySelector('.role-tag-new').value;
    const tenant_id = form.querySelector('.f-tenant-new').value.trim() || undefined;
    if (!actor || !role_tag) { alert('actor 与 role_tag 必填'); return; }
    const data = await post('/api/mcp-identities', { actor, role_tag, tenant_id });
    form.remove();
    if (data.token_plaintext) {
      document.getElementById('tokenText').textContent = data.token_plaintext;
      document.getElementById('tokenModal').style.display = 'flex';
    } else { alert('创建失败：' + (data.error || '未知')); }
  };
};
```

(c) `load()` 外层加 403 兜底——把 `async function load()` 首行包 try/catch：

```js
async function load() {
  try {
    const { rows, roles } = await get('/api/mcp-identities');
    ROLES = roles || [];
    document.getElementById('list').innerHTML = renderMcpIdentities(rows, ROLES);
    const s = mcpIdentitySummary(rows);
    document.getElementById('summary').textContent = `共 ${s.count} 个 · 启用 ${s.enabled} · 已吊销 ${s.revoked}`;
    bindRows();
  } catch (e) {
    document.getElementById('list').innerHTML = `<div class="empty">加载失败：${e.message}（MCP 身份签发仅 ADMIN 可访问；sysadmin 请使用 crm-cli auth login 自助领取）</div>`;
  }
}
```

(d) 在 `<style>` 内追加 `.add-form` 样式（可选，保持可读）：

```css
  .add-form { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:12px; margin-bottom:12px; display:flex; flex-direction:column; gap:8px; }
  .add-form label { font-size:13px; color:var(--mut); display:flex; flex-direction:column; gap:4px; }
```

- [ ] **Step 3: 改 my-api-keys.html 文案按角色分流**

编辑 `src/web/my-api-keys.html`：

(a) import 增加 `me`：

```js
import { get, post, put, token, me } from '/portal/api.js';
```

(b) `load()` 取角色并传给 `render`：

```js
async function load() {
  try {
    const m = await me().catch(() => null);
    const j = await get('/api/mcp-identities/me');
    render(j.rows || [], m?.role);
  } catch (e) { root.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}
```

(c) `render(rows, role)` 中替换底部 note（约 71 行）为按角色分流：

```js
    const roleNote = (() => {
      if (role === 'sysadmin' || role === 'ten_admin') {
        return `你是平台级角色（${role}）。请使用 <code>crm-cli auth login</code>（或 MCP <code>crm_login</code>）自助领取 8 小时临时 token：<br><code>crm-cli auth login --role ${role}</code><br>如需为具体接入方签发长期凭据，请联系 ADMIN 在「连接器 / MCP 身份配置」操作。`;
      }
      if (role === 'admin') {
        return `admin 为平台治理账号，按设计不持有 MCP 凭据；请以 admin 身份在「连接器 / MCP 身份配置」为具体接入方签发。`;
      }
      return `零信任：token 明文仅在创建时一次性返回，系统只存哈希、不可恢复；不再使用请及时吊销（软标记，可追溯）。`;
    })();
    ${body}
    <div class="note">${roleNote}</div>`;
```

- [ ] **Step 4: ui-lint 通过**

```powershell
cd D:\system\CRM-ai-native
node scripts/ui-lint.mjs
```

预期：无报错（若有新增页面规则误伤，按 UI 铁律修正页面而非加排除）。

- [ ] **Step 5: grep 验收——页面无角色字面量硬编码**

```powershell
cd D:\system\CRM-ai-native
Select-String -Path src/web/mcp-identities.html -Pattern "prompt\(" | ForEach-Object { $_.Line }
# 预期：无任何 prompt( 调用（已改内联表单）
Select-String -Path src/web/mcp-identities.html -Pattern "sales/manager/finance/presales/contract_admin" | ForEach-Object { $_.Line }
# 预期：无匹配（角色列表来自后端 roles）
```

- [ ] **Step 6: 提交**

```powershell
cd D:\system\CRM-ai-native
git add src/web/mcp-identities.html src/web/my-api-keys.html
git commit -m "feat(mcp-identity): T4 新增身份改后端驱动下拉 + my-api-keys 文案按角色分流"
```

---

## Task 5 — T5：配置中心 TAB 占位（消除"看得见点不进"）

**Files:** Create `src/portal/configTabs.js`；Modify `src/web/config.html`；Create `test/portal/configTabs.test.js`

> 决策（已批准）：**不砍菜单**（`layoutMenu.js:31` / `layout.js:33` 保持不变，保留 sysadmin 的 14 个租户级配置面入口）。仅改 `/config` 内系统级/传播 TAB 的渲染：非 ADMIN 时显示**不可点占位 + 替代通路文案**，不渲染条目明细。

- [ ] **Step 1: 写失败测试（纯函数单测）**

新建 `test/portal/configTabs.test.js`：

```js
// test/portal/configTabs.test.js — T5 纯函数：非 ADMIN 系统级 TAB 占位、不泄露条目明细
import { test, expect } from 'vitest';
import { buildLevelTabs } from '../../src/portal/configTabs.js';

test('ADMIN：系统级/租户级/传播 均可见且非占位', () => {
  const tabs = buildLevelTabs({ level: 'ADMIN' });
  const sys = tabs.find((t) => t.level === 'system');
  expect(sys.visible).toBe(true);
  expect(sys.placeholder).toBe(false);
  expect(tabs.find((t) => t.level === 'tenant').placeholder).toBe(false);
});

test('sysadmin：系统级可见但占位（不可点），租户级正常', () => {
  const tabs = buildLevelTabs({ level: 'SYSADMIN' });
  const sys = tabs.find((t) => t.level === 'system');
  expect(sys.visible).toBe(true);
  expect(sys.placeholder).toBe(true);          // 关键：看得见但不可点
  expect(tabs.find((t) => t.level === 'tenant').placeholder).toBe(false);
  expect(tabs.find((t) => t.level === 'propagation').placeholder).toBe(true);
});

test('ten_admin：系统级占位、租户级正常', () => {
  const tabs = buildLevelTabs({ level: 'TAN_ADMIN' });
  expect(tabs.find((t) => t.level === 'system').placeholder).toBe(true);
  expect(tabs.find((t) => t.level === 'tenant').placeholder).toBe(false);
});
```

- [ ] **Step 2: 跑测试确认失败（buildLevelTabs 尚未定义）**

```powershell
cd D:\system\CRM-ai-native
node node_modules/.bin/vitest run test/portal/configTabs.test.js
```

预期：FAIL（`Cannot find module .../configTabs.js`）。

- [ ] **Step 3: 实现纯函数 configTabs.js**

新建 `src/portal/configTabs.js`：

```js
// src/portal/configTabs.js — 配置中心一级分组 TAB 可见性（§15 权限重分组 + T5 占位）
// 纯函数，便于单测；config.html 通过 /portal/configTabs.js 引入。
export function buildLevelTabs(me = {}) {
  const level = me.level || null;
  const isAdmin = level === 'ADMIN';
  return [
    // 系统级：仅 ADMIN 可点；非 ADMIN 显示不可点占位（暴露分组名，不泄露条目明细）
    { level: 'system', name: '系统级', visible: true, placeholder: !isAdmin },
    { level: 'tenant', name: '租户级', visible: true, placeholder: false },
    // 传播中枢（上下贯通 §15.5）：权限等同系统级，仅 ADMIN 可点
    { level: 'propagation', name: '全局复用与经验蔓延', visible: true, placeholder: !isAdmin },
  ];
}
```

- [ ] **Step 4: 改 config.html 使用 buildLevelTabs + 占位渲染**

编辑 `src/web/config.html`：

(a) 在 `<script type="module">` 顶部 import 增加：

```js
  import { buildLevelTabs } from '/portal/configTabs.js';
```

(b) 替换 `render(me)` 内 `LEVEL_TABS` 定义与 tab/panel 创建（约 89-104 行）为：

```js
  function render(me) {
    const tabsEl = document.getElementById('tabs');
    const panelsEl = document.getElementById('panels');
    // §15.2 + T5：系统级/传播 TAB 非 ADMIN 显示不可点占位 + 替代通路文案（不渲染条目明细）
    const tabs = buildLevelTabs(me);
    tabs.forEach((lt, gi) => {
      const tab = document.createElement('div');
      tab.className = 'tab' + (gi === 0 ? ' on' : '') + (lt.placeholder ? ' placeholder' : '');
      tab.textContent = lt.name;
      tab.dataset.gi = gi;
      tabsEl.appendChild(tab);

      const panel = document.createElement('div');
      panel.className = 'cfg-group' + (gi === 0 ? ' on' : '');
      panel.dataset.gi = gi;
      if (lt.placeholder) {
        panel.innerHTML = `<div class="cfg-placeholder">
          <p><b>${esc(lt.name)}</b>配置仅 ADMIN 可访问（§15 权限重分组）。</p>
          <p>MCP 身份（连接器）签发请联系平台管理员，或使用 <code>crm-cli auth login</code> 自助领取 8 小时临时 token。</p>
        </div>`;
      } else {
        // 原 LEVEL_GROUPS_MARKUP 渲染（仅本 level 条目）
        panel.innerHTML = LEVEL_GROUPS_MARKUP
          .map((g) => {
            const items = g.items.filter((id) => (byId[id]?.level || 'tenant') === lt.level);
            if (!items.length) return '';
            return `<div class="cfg-sub" data-group="${esc(g.name)}">
              <h3>${esc(g.name)}</h3>
              <h4>${items.map((id) => byId[id]?.name || id).join(' · ')}</h4>
              <div class="cfg-grid">${items.map((id) => {
                const it = byId[id]; if (!it) return '';
                const href = it.page ? `href="${esc(it.page)}"` : '';
                return `<a class="cfg-card${it.read ? ' read' : ''}" ${href}><div class="cfg-head"><h4>${esc(it.name)}</h4></div><div class="cfg-sum">${esc(it.summary || '')}</div></a>`;
              }).join('')}</div>
            </div>`;
          }).join('');
      }
      panelsEl.appendChild(panel);
    });
```

(c) 在 `<style>` 内追加占位样式：

```css
  .tab.placeholder { opacity: .55; cursor: not-allowed; border-bottom: 2px dashed var(--line); }
  .cfg-placeholder { padding: 20px; background: var(--panel); border: 1px dashed var(--line); border-radius: 10px; color: var(--mut); font-size: 13px; line-height: 1.7; }
  .cfg-placeholder code { background: var(--bg); padding: 2px 6px; border-radius: 4px; color: var(--ac); }
```

- [ ] **Step 5: 跑测试确认通过**

```powershell
cd D:\system\CRM-ai-native
node node_modules/.bin/vitest run test/portal/configTabs.test.js
```

预期：全 PASS。

- [ ] **Step 6: 确认菜单零变化（既有 layoutMenu.test.js 不回归）**

```powershell
cd D:\system\CRM-ai-native
node node_modules/.bin/vitest run test/portal/layoutMenu.test.js
```

预期：PASS（sysadmin 仍可见「配置中心」；本任务未触碰 `layoutMenu.js`）。

- [ ] **Step 7: 提交**

```powershell
cd D:\system\CRM-ai-native
git add src/portal/configTabs.js src/web/config.html test/portal/configTabs.test.js
git commit -m "feat(config): T5 系统级/传播 TAB 非 ADMIN 显示不可点占位 + 替代通路文案"
```

---

## 全量回归与交付

- [ ] **Step 1: 全量跑相关测试（确认无新增确定性失败）**

```powershell
cd D:\system\CRM-ai-native
node node_modules/.bin/vitest run test/web/mcpIdentity.test.js test/portal/mcpIdentityAdminGate.test.js test/portal/mcpIdentityPatch.test.js test/portal/mcpIdentityTenant.test.js test/portal/configTabs.test.js test/portal/layoutMenu.test.js
```

- [ ] **Step 2: A/B 归因（防 flaky 误判）**

若单次出现不确定失败：备份本次改动 → `git stash` 或 `git checkout -- <本次路径>` → 同批复跑 → 若仍红则属基线 flaky（非本任务引入），还原改动后记录。参考 `docs/specs` 中"跨会话共享 crm_native_test 并发两 vitest 互 TRUNCATE"说明，跑前确认无并发实例。

- [ ] **Step 3: 提交纪律终检**

```powershell
cd D:\system\CRM-ai-native
git log -1 --oneline
git status --short
```

预期：`git status --short` 为空（全部已提交），最近 5 条 commit 对应 T1–T5。

---

## 自检（Self-Review）

**1. 规格覆盖**：§0 五项 ↔ Task 1–5 一一对应（T1=§3.1、T2=§3.2、T3=§3.3、T4=§3.4、T5=§3.5）。§4 测试矩阵 6 项：#1→Task1/2 单测、#2→Task1 新、#3→Task2 新、#4→Task3 新、#5→Task5 新、#6→Task5 既有 layoutMenu 断言保留。✅

**2. 占位符扫描**：无 TBD/TODO；每步含完整代码或精确行号锚点。✅

**3. 类型一致性**：`D.put` 返回契约 `{row}|{notFound}|{revoked}|{noop}` 在 Task2 Step3 定义、Task2 Step4 单测与 Task1 既有用例同步；`buildLevelTabs` 返回 `{level,name,visible,placeholder}` 在 Task5 Step3 定义、Step1 测试消费一致。✅

**4. 范围边界**：未触碰 `admin` 禁领 token 设计意图、`role_context_profile` 无 admin 行、id27 `level:'system'`、`SELF_ROLES` 白名单、`context-routing` 红线、`layoutMenu.js`/`layout.js`。✅
