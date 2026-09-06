# 连接器 / MCP 身份配置页（item 27）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 `crm.mcp_identity` 表补配置页 + 端点，让连接器/MCP 身份可经界面新增/编辑/吊销（零信任：token 仅存哈希、明文一次性返回、绝对禁删）。

**Architecture:** 复用 RBAC / business-tier / approval-flow / alert-rule 同构范式——专属 Router `createMcpIdentityRouter`（位于 `src/portal/mcpIdentity.js`）+ 渲染纯函数 + `mcp-identities.html` 管理页 + routes 挂载 + 配置中心第 27 项翻 ready。写经决策第0闸（镜像 `approvalFlow.js:97`），绝对禁 DELETE，吊销 = `revoked_at` 软标记。

**Tech Stack:** Node 22 ESM + Express 4 + PostgreSQL（pgcrypto `crypt`/`gen_salt`）+ vitest 3（globals OFF，测试须 `import { test, expect } from 'vitest'`）。

---

## Task 1: 渲染纯函数 + 测试

**Files:**
- Create: `src/portal/mcpIdentity.js`
- Test: `test/web/mcpIdentity.test.js`

- [ ] **Step 1: 写失败渲染测试（RED）**

新建 `test/web/mcpIdentity.test.js`：
```js
import { test, expect } from 'vitest';
import {
  renderMcpIdentities, mcpIdentitySummary, roleOptions, statusBadge,
} from '../../src/portal/mcpIdentity.js';

const ROWS = [
  { id: 'u1', actor: 'kavak-bot', role_tag: 'sales', scopes: { deny_domains: ['CRM_PAYMENT_RECORD'] }, enabled: true, revoked_at: null, expires_at: null },
  { id: 'u2', actor: 'fin-bot', role_tag: 'finance', scopes: {}, enabled: false, revoked_at: '2026-08-01T00:00:00Z', expires_at: null },
  { id: 'u3', actor: 'ext-bot', role_tag: 'presales', scopes: {}, enabled: true, revoked_at: null, expires_at: '2026-01-01T00:00:00Z' },
];
const ROLES = ['sales', 'manager', 'finance', 'presales', 'contract_admin'];

test('renderMcpIdentities 渲染行含 actor/role', () => {
  const html = renderMcpIdentities(ROWS, ROLES);
  expect(html).toContain('kavak-bot');
  expect(html).toContain('data-id="u1"');
  expect(html).toContain('role-tag-select');
});

test('roleOptions 渲染角色下拉', () => {
  const html = roleOptions(ROLES);
  expect(html).toContain('<option value="sales">');
  expect(html).toContain('<option value="finance">');
});

test('scopes 摘要渲染 deny_domains', () => {
  const html = renderMcpIdentities(ROWS, ROLES);
  expect(html).toContain('CRM_PAYMENT_RECORD');
});

test('statusBadge 启用/已吊销/过期', () => {
  expect(statusBadge(ROWS[0])).toContain('启用');
  expect(statusBadge(ROWS[1])).toContain('已吊销');
  expect(statusBadge(ROWS[2])).toContain('过期');
});

test('mcpIdentitySummary 计数', () => {
  const s = mcpIdentitySummary(ROWS);
  expect(s.count).toBe(3);
  expect(s.enabled).toBe(2);
  expect(s.revoked).toBe(1);
});

test('renderMcpIdentities 空列表', () => {
  expect(renderMcpIdentities([], ROLES)).toContain('尚未配置任何 MCP 身份');
});
```

- [ ] **Step 2: 运行测试确认失败（模块未建）**

Run: `cd /d/system/CRM-ai-native && node node_modules/vitest/vitest.mjs run test/web/mcpIdentity.test.js 2>&1 | tail -15`
Expected: FAIL（`Cannot find module '../../src/portal/mcpIdentity.js'`）

- [ ] **Step 3: 实现渲染纯函数（GREEN）**

新建 `src/portal/mcpIdentity.js` 上半段（Router 在 Task 2 追加）：
```js
// src/portal/mcpIdentity.js — 连接器/MCP 身份配置（第 27 项）
// 零信任：token 仅存哈希（crm.mcp_identity.token_hash），明文仅创建时一次性返回前端
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function roleOptions(roles = []) {
  return (roles || [])
    .map((r) => `<option value="${esc(r)}">${esc(r)}</option>`)
    .join('');
}

// 状态徽标：启用 / 已吊销 / 过期（过期 = enabled 且 expires_at < now）
export function statusBadge(row = {}) {
  if (row.revoked_at) return `<span class="badge revoked">已吊销</span>`;
  if (row.enabled && row.expires_at && new Date(row.expires_at) < new Date()) return `<span class="badge expired">过期</span>`;
  return row.enabled ? `<span class="badge enabled">启用</span>` : `<span class="badge disabled">停用</span>`;
}

export function renderScopes(scopes = {}) {
  const s = scopes || {};
  if (!Object.keys(s).length) return `<span class="scopes empty">（全量）</span>`;
  const deny = Array.isArray(s.deny_domains) && s.deny_domains.length ? s.deny_domains.join(', ') : '';
  return `<span class="scopes">${deny ? `拒绝域: ${esc(deny)}` : esc(JSON.stringify(s))}</span>`;
}

export function renderMcpIdentities(rows = [], roles = []) {
  const list = rows || [];
  if (!list.length) return `<div class="empty">尚未配置任何 MCP 身份（crm.mcp_identity）</div>`;
  const roleOpts = roleOptions(roles);
  const trs = list
    .map((r) => `<tr class="mcp-row" data-id="${esc(r.id)}">
      <td class="m-actor"><input class="f-actor" value="${esc(r.actor)}" /></td>
      <td class="m-role"><select class="role-tag-select">${roleOpts}</select></td>
      <td class="m-scopes">${renderScopes(r.scopes)}</td>
      <td class="m-status">${statusBadge(r)}</td>
      <td class="m-exp">${r.expires_at ? esc(r.expires_at) : '—'}</td>
      <td class="m-ops">
        <button class="save-row">保存</button>
        <button class="revoke-row" ${r.revoked_at ? 'disabled' : ''}>吊销</button>
      </td>
    </tr>`)
    .join('');
  return `<table class="mcp-table"><thead><tr>
    <th>接入方(actor)</th><th>角色</th><th>域范围</th><th>状态</th><th>过期</th><th>操作</th>
  </tr></thead><tbody>${trs}</tbody></table>`;
}

export function mcpIdentitySummary(rows = []) {
  const list = rows || [];
  const enabled = list.filter((r) => r.enabled && !r.revoked_at).length;
  const revoked = list.filter((r) => r.revoked_at).length;
  return { count: list.length, enabled, revoked };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd /d/system/CRM-ai-native && node node_modules/vitest/vitest.mjs run test/web/mcpIdentity.test.js 2>&1 | tail -12`
Expected: PASS（6/6）

- [ ] **Step 5: 提交**

```bash
git add src/portal/mcpIdentity.js test/web/mcpIdentity.test.js
git commit -m "feat(mcp-identity): 渲染纯函数+6测试"
```

---

## Task 2: Router 工厂 + handler 测试

**Files:**
- Modify: `src/portal/mcpIdentity.js`（追加 Router + `defaultDeps`）
- Test: `test/web/mcpIdentity.test.js`（追加 handler 注入测试）

- [ ] **Step 1: 追加失败 handler 测试（RED）**

在 `test/web/mcpIdentity.test.js` 末尾追加：
```js
import { createMcpIdentityRouter } from '../../src/portal/mcpIdentity.js';

function makeDeps(over = {}) {
  const store = [];
  let decisionCount = 0;
  const base = {
    list: async () => ({
      rows: store.map((s) => ({ ...s, token_hash: 'HIDDEN' })),
      roles: ['sales', 'manager', 'finance'],
    }),
    create: async (input) => {
      const id = 'id-' + (store.length + 1);
      const row = { id, actor: input.actor, role_tag: input.role_tag, enabled: true, revoked_at: null };
      store.push(row);
      return { row, token_plaintext: 'tok-' + id };
    },
    put: async (id, patch) => {
      const row = store.find((s) => s.id === id);
      if (!row) return null;
      Object.assign(row, patch);
      return row;
    },
    produceDecision: async () => ({ decisionId: 'd-' + (++decisionCount), ok: true }),
  };
  return { ...base, ...over };
}

function mockRes() {
  let code = 200, body = null;
  return {
    status: (c) => { code = c; return { json: (p) => { body = p; } }; },
    json: (p) => { body = p; },
    get _code() { return code; }, get _body() { return body; },
  };
}

test('list 返回 rows+roles 且不含 token_hash', async () => {
  const router = createMcpIdentityRouter(makeDeps());
  const res = mockRes();
  await router.handlers.list({}, res);
  expect(res._body.rows).toBeDefined();
  expect(res._body.roles).toContain('sales');
  expect(JSON.stringify(res._body.rows)).not.toContain('token_hash');
  expect(JSON.stringify(res._body.rows)).not.toContain('HIDDEN');
});

test('create 生成 token + 决策闸 + 返回明文', async () => {
  const deps = makeDeps();
  const router = createMcpIdentityRouter(deps);
  const res = mockRes();
  await router.handlers.create({ body: { actor: 'kavak-bot', role_tag: 'sales', scopes: { deny_domains: ['CRM_PAYMENT_RECORD'] } } }, res);
  expect(res._body.id).toBeDefined();
  expect(res._body.token_plaintext).toMatch(/^tok-/);
  expect(res._body.decision).toBe('d-1');
});

test('create 缺 actor → 400', async () => {
  const router = createMcpIdentityRouter(makeDeps());
  const res = mockRes();
  await router.handlers.create({ body: { role_tag: 'sales' } }, res);
  expect(res._code).toBe(400);
});

test('put 编辑生效 + 决策闸', async () => {
  const deps = makeDeps();
  const router = createMcpIdentityRouter(deps);
  const res = mockRes();
  await router.handlers.put({ params: { id: 'id-1' }, body: { actor: 'renamed', role_tag: 'manager', enabled: false } }, res);
  expect(res._body.ok).toBe(true);
  expect(res._body.decision).toBe('d-1');
  expect(res._body.row.actor).toBe('renamed');
});

test('put 吊销置 revoked_at + enabled=false', async () => {
  const deps = makeDeps();
  const router = createMcpIdentityRouter(deps);
  const res = mockRes();
  await router.handlers.put({ params: { id: 'id-1' }, body: { revoked_at: '2026-08-27T00:00:00Z' } }, res);
  expect(res._body.row.revoked_at).toBe('2026-08-27T00:00:00Z');
  expect(res._body.row.enabled).toBe(false);
});

test('put 未知 id → 404', async () => {
  const router = createMcpIdentityRouter(makeDeps());
  const res = mockRes();
  await router.handlers.put({ params: { id: 'nope' }, body: { actor: 'x' } }, res);
  expect(res._code).toBe(404);
});

test('router.handlers 无 delete 键（绝对禁删）', async () => {
  const router = createMcpIdentityRouter(makeDeps());
  expect(router.handlers.delete).toBeUndefined();
  expect(typeof router.handlers.list).toBe('function');
  expect(typeof router.handlers.create).toBe('function');
  expect(typeof router.handlers.put).toBe('function');
});
```

- [ ] **Step 2: 运行测试确认失败（createMcpIdentityRouter 未定义）**

Run: `cd /d/system/CRM-ai-native && node node_modules/vitest/vitest.mjs run test/web/mcpIdentity.test.js 2>&1 | tail -15`
Expected: FAIL（7 例 handler 失败）

- [ ] **Step 3: 实现 Router 工厂（GREEN）**

在 `src/portal/mcpIdentity.js` 末尾追加（import 段放文件顶部需与渲染函数共存，故统一在文件最上 import）：
```js
import { Router } from 'express';
import { query } from '../db.js';
import { requireDecision } from '../decision/autonomyEngine.js';
import { recordDecisionEvent } from '../decision/decisionRepo.js';
import { randomBytes } from 'crypto';

const defaultDeps = {
  list: async () => {
    const r = await query(
      `SELECT id, actor, person_id, role_tag, scopes, expires_at, enabled, revoked_at
         FROM crm.mcp_identity ORDER BY created_at DESC`);
    const roles = await query(`SELECT role_tag FROM crm.role_context_profile ORDER BY role_tag`);
    return { rows: r.rows, roles: roles.rows.map((x) => x.role_tag) };
  },
  create: async (input) => {
    const tokenPlain = randomBytes(24).toString('hex');
    const r = await query(
      `INSERT INTO crm.mcp_identity (token_hash, actor, person_id, role_tag, scopes, expires_at)
       VALUES (crypt($1, gen_salt('bf')), $2, $3, $4, $5::jsonb, $6)
       RETURNING id, actor, role_tag, enabled, revoked_at`,
      [tokenPlain, input.actor, input.person_id || null, input.role_tag, JSON.stringify(input.scopes || {}), input.expires_at || null]);
    return { row: r.rows[0], token_plaintext: tokenPlain };
  },
  put: async (id, patch) => {
    const r = await query(
      `UPDATE crm.mcp_identity SET actor=$2, role_tag=$3, scopes=$4::jsonb, enabled=$5, expires_at=$6, revoked_at=$7
       WHERE id=$1 RETURNING id, actor, role_tag, enabled, revoked_at`,
      [id, patch.actor, patch.role_tag, JSON.stringify(patch.scopes || {}),
       patch.enabled !== false, patch.expires_at || null, patch.revoked_at || null]);
    return r.rows[0] || null;
  },
  produceDecision: async (ctx) => {
    try {
      const r = await requireDecision('config-change', ctx || {});
      return { decisionId: r.decision_id || null, ok: !!r.decision_id };
    } catch {
      await recordDecisionEvent('config_change', { trigger_context: ctx });
      return { decisionId: null, ok: true };
    }
  },
};

export function createMcpIdentityRouter(deps = {}) {
  const D = { ...defaultDeps, ...deps };
  const router = Router();
  const handlers = {
    list: async (req, res) => {
      try {
        const { rows, roles } = await D.list();
        const safe = (rows || []).map(({ token_hash, ...rest }) => rest);
        res.json({ rows: safe, roles });
      } catch (e) { res.status(500).json({ error: e.message }); }
    },
    create: async (req, res) => {
      try {
        const { actor, person_id, role_tag, scopes, expires_at } = req.body || {};
        if (!actor || !role_tag) return res.status(400).json({ error: 'actor 与 role_tag 必填' });
        const created = await D.create({ actor, person_id, role_tag, scopes, expires_at });
        const decision = await D.produceDecision({ key: 'mcp-identity', id: created.row.id });
        res.json({ id: created.row.id, token_plaintext: created.token_plaintext, decision: decision?.decisionId || null });
      } catch (e) { res.status(400).json({ error: e.message }); }
    },
    put: async (req, res) => {
      try {
        const { id } = req.params;
        const { actor, role_tag, scopes, enabled, expires_at, revoked_at } = req.body || {};
        const patch = {};
        if (actor !== undefined) patch.actor = actor;
        if (role_tag !== undefined) patch.role_tag = role_tag;
        if (scopes !== undefined) patch.scopes = scopes;
        if (enabled !== undefined) patch.enabled = enabled;
        if (expires_at !== undefined) patch.expires_at = expires_at;
        if (revoked_at !== undefined) patch.revoked_at = revoked_at;
        const updated = await D.put(id, patch);
        if (!updated) return res.status(404).json({ error: '身份不存在' });
        const decision = await D.produceDecision({ key: 'mcp-identity', id });
        res.json({ ok: true, row: updated, decision: decision?.decisionId || null });
      } catch (e) { res.status(400).json({ error: e.message }); }
    },
  };
  router.get('/api/mcp-identities', handlers.list);
  router.post('/api/mcp-identities', handlers.create);
  router.put('/api/mcp-identities/:id', handlers.put);
  router.handlers = handlers; // 无 delete（绝对禁删）
  return router;
}
```

> 注：`import` 语句应置于文件顶部（与渲染函数同文件），故实际写入时把本段两个 `import` 块合并到文件最上方，渲染函数紧随其后，Router 在末尾。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd /d/system/CRM-ai-native && node node_modules/vitest/vitest.mjs run test/web/mcpIdentity.test.js 2>&1 | tail -12`
Expected: PASS（13/13）

- [ ] **Step 5: 提交**

```bash
git add src/portal/mcpIdentity.js test/web/mcpIdentity.test.js
git commit -m "feat(mcp-identity): Router+list/create/put+决策闸+13测试"
```

---

## Task 3: routes.js 挂载 + 页路由 + 模块挂载

**Files:**
- Modify: `src/http/routes.js`（import + `app.use` + 页路由 + portal 模块）

- [ ] **Step 1: import 追加**

`src/http/routes.js:34` 后追加一行：
```js
import { createMcpIdentityRouter } from '../portal/mcpIdentity.js';
```

- [ ] **Step 2: mount Router**

`src/http/routes.js:71`（`app.use(createAlertRuleConfigRouter({}));` 之后）追加：
```js
  app.use(createMcpIdentityRouter({}));
```

- [ ] **Step 3: 页路由 + portal 模块挂载**

`src/http/routes.js:995`（`/portal/approvalFlow.js` 模块挂载之后）追加：
```js
  app.get('/mcp-identities', (req, res) => res.redirect('/mcp-identities.html'));
  app.get('/mcp-identities.html', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../web/mcp-identities.html', import.meta.url))));
  app.get('/portal/mcpIdentity.js', (req, res) =>
    res.sendFile(fileURLToPath(new URL('../portal/mcpIdentity.js', import.meta.url)), { headers: { 'Content-Type': 'text/javascript' } }));
```

- [ ] **Step 4: 语法冒烟（routes 可加载）**

Run: `cd /d/system/CRM-ai-native && node --input-type=module -e "import('./src/http/routes.js').then(()=>console.log('routes OK')).catch(e=>{console.error(e.message);process.exit(1)})" 2>&1 | tail -15`
Expected: `routes OK`

- [ ] **Step 5: 提交**

```bash
git add src/http/routes.js
git commit -m "feat(mcp-identity): 路由挂载+页路由+模块"
```

---

## Task 4: mcp-identities.html 管理页

**Files:**
- Create: `src/web/mcp-identities.html`

- [ ] **Step 1: 写管理页**

新建 `src/web/mcp-identities.html`（纯前端，无轮询）：
```html
<!doctype html>
<html lang="zh">
<head><meta charset="utf-8" /><title>连接器 / MCP 身份配置</title>
<style>
  body { font-family: system-ui, "Microsoft YaHei", sans-serif; margin: 0; background: #0f1115; color: #e6e6e6; }
  header { padding: 14px 20px; border-bottom: 1px solid #2a2d34; display:flex; justify-content:space-between; align-items:center; }
  header .sub { color:#9aa0a6; font-size:12px; }
  main { padding: 16px 20px; }
  .summary { color:#9aa0a6; margin-bottom:12px; }
  table.mcp-table { width:100%; border-collapse:collapse; }
  .mcp-table th,.mcp-table td { border:1px solid #2a2d34; padding:8px; text-align:left; }
  .badge { padding:2px 8px; border-radius:10px; font-size:12px; }
  .badge.enabled { background:#14361f; color:#5fd38a; }
  .badge.revoked { background:#3a1414; color:#f08a8a; }
  .badge.expired { background:#3a2e14; color:#e0b45a; }
  .badge.disabled { background:#2a2d34; color:#9aa0a6; }
  button { background:#1f6feb; color:#fff; border:0; padding:6px 12px; border-radius:6px; cursor:pointer; margin-right:6px; }
  button.revoke-row { background:#7a2e2e; }
  button:disabled { opacity:.4; cursor:not-allowed; }
  .f-actor { background:#1a1d23; color:#e6e6e6; border:1px solid #2a2d34; padding:4px 6px; border-radius:4px; }
  .toolbar { margin-bottom:12px; }
  .token-modal { position:fixed; inset:0; background:rgba(0,0,0,.6); display:none; align-items:center; justify-content:center; }
  .token-modal .box { background:#1a1d23; padding:24px; border-radius:8px; max-width:480px; }
  .token-modal code { display:block; background:#0f1115; padding:10px; margin:10px 0; word-break:break-all; color:#5fd38a; }
  .note { color:#e0b45a; font-size:12px; margin-top:8px; }
  .empty { color:#9aa0a6; padding:20px; }
</style></head>
<body>
<header><div><b>连接器 / MCP 身份配置</b><br><span class="sub">crm.mcp_identity · 零信任：token 仅存哈希、明文一次性、绝对禁删</span></div>
  <button id="add">+ 新增身份</button></header>
<main>
  <div class="summary" id="summary"></div>
  <div id="list"></div>
  <div class="note">已知限制：token 明文仅创建时返回一次，不可恢复；遗失须吊销旧身份后新建。初始为空（无种子，保持零信任）。</div>
</main>
<div class="token-modal" id="tokenModal"><div class="box">
  <b>身份已创建 — 请妥善保存 token</b>
  <code id="tokenText"></code>
  <div class="note">关闭后不可再查看，token 仅存哈希于数据库。</div>
  <button id="tokenClose">我已保存</button>
</div></div>
<script type="module">
import { renderMcpIdentities, mcpIdentitySummary, roleOptions } from '/portal/mcpIdentity.js';

async function load() {
  const r = await fetch('/api/mcp-identities');
  const { rows, roles } = await r.json();
  document.getElementById('list').innerHTML = renderMcpIdentities(rows, roles);
  const s = mcpIdentitySummary(rows);
  document.getElementById('summary').textContent = `共 ${s.count} 个 · 启用 ${s.enabled} · 已吊销 ${s.revoked}`;
  bindRows();
}
function bindRows() {
  document.querySelectorAll('.mcp-row').forEach((tr) => {
    const id = tr.dataset.id;
    tr.querySelector('.save-row').onclick = async () => {
      const actor = tr.querySelector('.f-actor').value;
      const role_tag = tr.querySelector('.role-tag-select').value;
      await fetch('/api/mcp-identities/' + id, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actor, role_tag }),
      });
      load();
    };
    const rev = tr.querySelector('.revoke-row');
    if (rev) rev.onclick = async () => {
      await fetch('/api/mcp-identities/' + id, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revoked_at: new Date().toISOString() }),
      });
      load();
    };
  });
}
document.getElementById('add').onclick = async () => {
  const actor = prompt('接入方 actor（如 kavak-bot）：');
  if (!actor) return;
  const role_tag = prompt('角色 role_tag（sales/manager/finance/presales/contract_admin）：');
  if (!role_tag) return;
  const r = await fetch('/api/mcp-identities', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ actor, role_tag }),
  });
  const data = await r.json();
  if (data.token_plaintext) {
    document.getElementById('tokenText').textContent = data.token_plaintext;
    document.getElementById('tokenModal').style.display = 'flex';
  } else { alert('创建失败：' + (data.error || '未知')); }
};
document.getElementById('tokenClose').onclick = () => {
  document.getElementById('tokenModal').style.display = 'none';
  load();
};
load();
</script>
</body></html>
```

- [ ] **Step 2: 提交**

```bash
git add src/web/mcp-identities.html
git commit -m "feat(mcp-identity): 管理页"
```

---

## Task 5: 配置中心第 27 项翻 ready

**Files:**
- Modify: `src/portal/configCenter.js:25`

- [ ] **Step 1: 翻 ready**

`src/portal/configCenter.js:25` 改为：
```js
  { id: 27, name: '连接器 / MCP 配置', group: '集成', status: 'ready', page: '/mcp-identities.html', endpoint: '/api/mcp-identities', note: 'crm.mcp_identity 身份绑定，零信任 token 哈希' },
```

- [ ] **Step 2: 运行 configCenter 测试确认无回归**

Run: `cd /d/system/CRM-ai-native && node node_modules/vitest/vitest.mjs run test/web/configCenter.test.js 2>&1 | tail -8`
Expected: PASS（无 item-27 pending 断言需同步）

- [ ] **Step 3: 提交**

```bash
git add src/portal/configCenter.js
git commit -m "feat(config-center): 第27项翻ready"
```

---

## Task 6: 全量 web 测试 + 冒烟 + 日志

**Files:**
- Modify: `.workbuddy/memory/2026-08-27.md`（追加 item 27 完成日志）

- [ ] **Step 1: 运行 web 套件**

Run: `cd /d/system/CRM-ai-native && node node_modules/vitest/vitest.mjs run test/web/ 2>&1 | tail -20`
Expected: PASS（基线 80 + 13 = 93）

- [ ] **Step 2: routes 加载冒烟**

Run: `cd /d/system/CRM-ai-native && node --input-type=module -e "import('./src/http/routes.js').then(()=>console.log('routes OK')).catch(e=>{console.error(e.message);process.exit(1)})" 2>&1 | tail -5`
Expected: `routes OK`

- [ ] **Step 3: 追加工作日志**

```bash
cat >> .workbuddy/memory/2026-08-27.md <<'EOF'

## item 27 连接器/MCP 身份配置页（2026-08-27 晚，内联执行 TDD）
- 交付：src/portal/mcpIdentity.js（renderMcpIdentities/roleOptions/statusBadge/renderScopes/mcpIdentitySummary + createMcpIdentityRouter【GET/POST/PUT，决策第0闸，无 DELETE；list 剥离 token_hash】）+ src/web/mcp-identities.html + src/http/routes.js 挂载 + src/portal/configCenter.js 第27项 ready + test/web/mcpIdentity.test.js 13例。
- 验证：test/web/mcpIdentity.test.js 13/13；test/web 全量 ~93/93；routes 加载 OK。
- 范式：复用 RBAC/business-tier/approval-flow/alert-rule 同构；写经决策第0闸、绝对禁删；吊销=revoked_at 软标记。
- 零信任：token 仅存 crypt 哈希（gen_salt('bf')）、明文仅 POST 返回一次、list 响应剥离 token_hash；初始空表无 seed。
- 待提交：按 Task 分 5 笔 commit（沙箱无凭证）。
EOF
```

- [ ] **Step 4: 提交（文档）**

```bash
git add docs/superpowers/specs/2026-08-27-mcp-identity-config-design.md docs/superpowers/plans/2026-08-27-mcp-identity-config.md
git commit -m "docs(mcp-identity): item 27 spec+plan"
```

---

## 自审

1. **Spec 覆盖**：§0 约束（绝对禁删/零信任/token 哈希）→ Task 2 Router + Task 4 页 note；§1 Router（GET/POST/PUT）→ Task 2；§2 渲染+页 → Task 1/4；§3 routes 挂载 → Task 3；§4 配置中心 → Task 5；§5 测试 → Task 1/2；§6 已知限制 → Task 4 note + Task 6 日志；§7 验收 → Task 6。全覆盖。
2. **占位扫描**：无 TBD/TODO；每步含完整代码。
3. **类型一致**：`create` 返回 `{row, token_plaintext}`；`list` 返回 `{rows, roles}`；`put` 返回 row 或 null；handler/测试对称。渲染函数 `renderMcpIdentities(rows, roles)` / `mcpIdentitySummary(rows)` / `roleOptions(roles)` / `statusBadge(row)` 全程一致。
4. **token 安全三处一致**：create 落库仅哈希、POST 返回明文一次、list 剥离 token_hash —— Task 2/4 共证。
