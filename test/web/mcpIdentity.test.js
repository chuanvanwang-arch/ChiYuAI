import { test, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import {
  renderMcpIdentities, mcpIdentitySummary, roleOptions, statusBadge,
} from '../../src/portal/mcpIdentity.js';
import { createMcpIdentityRouter } from '../../src/portal/mcpIdentity.js';

function makeDeps(over = {}) {
  const store = [{ id: 'id-1', actor: 'a', role_tag: 'sales', enabled: true, revoked_at: null, scopes: {} }];
  let decisionCount = 0;
  const base = {
    // T1 起 list/create/put 加 requireAdmin 闸：默认以 ADMIN 通过（旧用例不变）
    resolveMe: async () => ({ ok: true, username: 'admin', tenantId: 'system', role: 'admin', level: 'ADMIN' }),
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
      if (!row) return { notFound: true };
      Object.assign(row, patch);
      return { row };
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

test('put 已吊销行 → 409 且 revoked_at 未清空', async () => {
  const deps = makeDeps({ put: async () => ({ revoked: true }) });
  const router = createMcpIdentityRouter(deps);
  const res = mockRes();
  await router.handlers.put({ params: { id: 'id-1' }, body: { actor: 'x' } }, res);
  expect(res._code).toBe(409);
});

test('router.handlers 无 delete 键（绝对禁删）', async () => {
  const router = createMcpIdentityRouter(makeDeps());
  expect(router.handlers.delete).toBeUndefined();
  expect(typeof router.handlers.list).toBe('function');
  expect(typeof router.handlers.create).toBe('function');
  expect(typeof router.handlers.put).toBe('function');
  expect(typeof router.handlers.me).toBe('function'); // 方案 A：个人「我的 API Key」
});

test('生产接线守卫：routes.js 构造 router 必须注入 resolveMe', async () => {
  // 回归根因：routes.js 曾用 createMcpIdentityRouter({}) 空依赖构造，
  // 线上 me/mine 端点 500 "D.resolveMe is not a function"（测试替身掩盖了接线缺口）。
  const routesSrc = readFileSync(
    fileURLToPath(new URL('../../src/http/routes.js', import.meta.url)), 'utf8');
  expect(routesSrc).toMatch(/createMcpIdentityRouter\(\{\s*resolveMe\s*\}\)/);
  expect(routesSrc).not.toMatch(/createMcpIdentityRouter\(\{\s*\}\)/);
});

// ─── me 端点（个人「我的 API Key」，方案 A docs/2026-09-05-my-api-keys-design.md）───

test('me 未登录 → 401', async () => {
  const router = createMcpIdentityRouter(makeDeps({
    resolveMe: async () => ({ ok: false, status: 401, error: 'missing token' }),
  }));
  const res = mockRes();
  await router.handlers.me({}, res);
  expect(res._code).toBe(401);
});

test('me 只返回本人身份且不含 token_hash', async () => {
  const seen = {};
  const router = createMcpIdentityRouter(makeDeps({
    listMine: async (username, tenantId) => {
      seen.username = username; seen.tenantId = tenantId;
      return [{ id: 'm-1', actor: username, role_tag: 'sales', enabled: true, revoked_at: null, scopes: {}, token_hash: 'HIDDEN' }];
    },
    resolveMe: async () => ({ ok: true, username: 'alice', tenantId: 'system', role: 'sales' }),
  }));
  const res = mockRes();
  await router.handlers.me({}, res);
  expect(seen.username).toBe('alice');
  expect(seen.tenantId).toBe('system');
  expect(res._body.rows).toHaveLength(1);
  expect(res._body.rows[0].actor).toBe('alice');
  expect(JSON.stringify(res._body)).not.toContain('token_hash');
  expect(JSON.stringify(res._body)).not.toContain('HIDDEN');
});

// ─── 方案 B：自助创建 / 自助吊销（docs/2026-09-05-my-api-keys-self-service-design.md）───

test('meCreate 成功：决策留痕 + 返回一次性明文', async () => {
  const router = createMcpIdentityRouter(makeDeps({
    createMine: async (me) => ({ row: { id: 'm-new', actor: me.username, role_tag: me.role, enabled: true, revoked_at: null, scopes: {} }, token_plaintext: 'tok-new' }),
    resolveMe: async () => ({ ok: true, username: 'alice', tenantId: 'system', role: 'sales' }),
  }));
  const res = mockRes();
  await router.handlers.meCreate({}, res);
  expect(res._body.row.actor).toBe('alice');
  expect(res._body.token_plaintext).toBe('tok-new');
  expect(res._body.decision).toBe('d-1');
});

test('meCreate 平台级角色 → 403 引导管理页', async () => {
  for (const role of ['admin', 'sysadmin', 'ten_admin']) {
    const router = createMcpIdentityRouter(makeDeps({
      resolveMe: async () => ({ ok: true, username: 'boss', tenantId: 'system', role }),
    }));
    const res = mockRes();
    await router.handlers.meCreate({}, res);
    expect(res._code).toBe(403);
  }
});

test('meCreate 超上限 → 400', async () => {
  const router = createMcpIdentityRouter(makeDeps({
    createMine: async () => ({ error: '启用中的 API Key 已达上限（5 个），请先吊销不用的身份' }),
    resolveMe: async () => ({ ok: true, username: 'alice', tenantId: 'system', role: 'sales' }),
  }));
  const res = mockRes();
  await router.handlers.meCreate({}, res);
  expect(res._code).toBe(400);
  expect(res._body.error).toContain('上限');
});

test('meRevoke 成功 + 他人身份 404', async () => {
  const router = createMcpIdentityRouter(makeDeps({
    revokeMine: async (me, id) => (id === 'mine-1'
      ? { id, actor: me.username, role_tag: 'sales', enabled: false, revoked_at: '2026-09-05T00:00:00Z' }
      : null),
    resolveMe: async () => ({ ok: true, username: 'alice', tenantId: 'system', role: 'sales' }),
  }));
  const ok = mockRes();
  await router.handlers.meRevoke({ params: { id: 'mine-1' } }, ok);
  expect(ok._body.ok).toBe(true);
  expect(ok._body.row.enabled).toBe(false);
  const nf = mockRes();
  await router.handlers.meRevoke({ params: { id: 'someone-elses' } }, nf);
  expect(nf._code).toBe(404);
});

test('meRevoke 未登录 → 401；缺 id → 400', async () => {
  const noAuth = createMcpIdentityRouter(makeDeps({
    resolveMe: async () => ({ ok: false, status: 401, error: 'missing token' }),
  }));
  const r1 = mockRes();
  await noAuth.handlers.meRevoke({ params: {} }, r1);
  expect(r1._code).toBe(401);
  const authed = createMcpIdentityRouter(makeDeps({
    resolveMe: async () => ({ ok: true, username: 'alice', tenantId: 'system', role: 'sales' }),
  }));
  const r2 = mockRes();
  await authed.handlers.meRevoke({ params: {} }, r2);
  expect(r2._code).toBe(400);
});

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
