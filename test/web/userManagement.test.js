// test/web/userManagement.test.js — 第12项用户管理配置（TDD RED→GREEN）
// 注入式 handler + 假 deps（对齐 decisionScenario.test.js），不依赖真实库
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createUserRouter, validateUserPatch, validateCreateUser, validateBatchUsers, renderUsers } from '../../src/portal/userManagement.js';

const ROLES = ['sales', 'manager', 'presales', 'contract_admin', 'finance', 'admin', 'ten_admin', 'sysadmin'];

function makeDeps(users = [], role = 'admin') {
  const rows = users.map((u) => ({ ...u }));
  const query = vi.fn(async (sql, params) => {
    if (typeof sql === 'string' && sql.startsWith('SELECT')) {
      return { rows: rows.map(({ password_hash, ...r }) => r) };
    }
    if (typeof sql === 'string' && sql.startsWith('INSERT')) {
      const id = 'u-' + (rows.length + 1);
      rows.push({
        user_id: id,
        username: params[0],
        role: params[2],
        display_name: params[3] || params[0],
        org_id: params[4] ?? null,
        enabled: true,
        created_at: new Date(),
      });
      return { rows: [{ user_id: id }], rowCount: 1 };
    }
    if (typeof sql === 'string' && sql.startsWith('UPDATE')) {
      const id = params[0]; // WHERE user_id=$1 在首位
      const u = rows.find((r) => r.user_id === id);
      if (u && sql.includes('enabled=')) {
        const idx = params.findIndex((p) => p === false || p === true);
        if (idx >= 0) u.enabled = params[idx];
      }
      return { rows: [u || {}], rowCount: u ? 1 : 0 };
    }
    return { rows: [] };
  });
  const createUser = vi.fn(async (username, hash, roleTag, displayName, orgId) => {
    await query(
      'INSERT INTO crm.crm_users (username,password_hash,role,display_name,org_id,enabled) VALUES($1,$2,$3,$4,$5,TRUE)',
      [username, hash, roleTag, displayName, orgId]
    );
    const id = 'u-' + (rows.length + 1);
    rows.push({ user_id: id, username, role: roleTag, display_name: displayName || username, org_id: orgId ?? null, enabled: true, created_at: new Date() });
    return { user_id: id };
  });
  const updateUser = vi.fn(async (user_id, patch, hashPassword) => {
    const sets = [];
    const params = [user_id];
    let i = 2;
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'password') { sets.push(`password_hash=$${i}`); params.push(await hashPassword(v)); i++; }
      else if (k === 'enabled') { sets.push(`enabled=$${i}`); params.push(!!v); i++; }
      else { sets.push(`${k}=$${i}`); params.push(v); i++; }
    }
    await query(`UPDATE crm.crm_users SET ${sets.join(', ')} WHERE user_id=$1`, params);
    const u = rows.find((r) => r.user_id === user_id);
    if (u) { for (const [k, v] of Object.entries(patch)) { if (k === 'password') u.password_hash = 'x'; else if (k === 'enabled') u.enabled = !!v; else u[k] = v; } }
    return u ? { user_id } : null;
  });
  const listUsers = vi.fn(async () => {
    const r = await query('SELECT user_id,username,display_name,role,org_id,enabled,created_at FROM crm.crm_users ORDER BY created_at');
    return r.rows;
  });
  const recordDecisionEvent = vi.fn(async () => ({ event_id: 'ev-x' }));
  const resolveMe = vi.fn(async () => ({ ok: true, role, display_name: 'Admin', username: 'admin' }));
  const hashPassword = vi.fn(async (p) => 'HASH(' + p + ')');
  const listRoleTags = vi.fn(async () => ROLES);
  const batchUpdateUsers = vi.fn(async (action, user_ids) => user_ids.length);
  return { query, createUser, updateUser, listUsers, recordDecisionEvent, resolveMe, hashPassword, listRoleTags, batchUpdateUsers, _rows: rows };
}

function mockRes() {
  let body = null;
  let status = 200;
  return {
    _body: () => body,
    _status: () => status,
    json: (o) => { body = o; return { json: () => {} }; },
    status: (s) => { status = s; return { json: (o) => { body = o; } }; },
  };
}

describe('validateUserPatch (PUT 字段白名单)', () => {
  it('合法 patch 通过', () => {
    const r = validateUserPatch({ display_name: '王', role: 'manager', enabled: false });
    expect(r.ok).toBe(true);
    expect(r.normalized.role).toBe('manager');
    expect(r.normalized.enabled).toBe(false);
  });
  it('未知字段拒绝', () => {
    const r = validateUserPatch({ foo: 1 });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/不可编辑/);
  });
  it('role 越界拒绝', () => {
    const r = validateUserPatch({ role: 'hacker' });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/须为/);
  });
  it('display_name 非字符串拒绝', () => {
    const r = validateUserPatch({ display_name: 123 });
    expect(r.ok).toBe(false);
  });
  it('enabled 非布尔拒绝', () => {
    const r = validateUserPatch({ enabled: 'yes' });
    expect(r.ok).toBe(false);
  });
  it('password 过短拒绝', () => {
    const r = validateUserPatch({ password: '123' });
    expect(r.ok).toBe(false);
  });
});

describe('validateCreateUser (POST)', () => {
  it('缺 username 拒绝', () => {
    const r = validateCreateUser({ password: '12345678', role: 'sales' });
    expect(r.ok).toBe(false);
  });
  it('缺 password 拒绝', () => {
    const r = validateCreateUser({ username: 'a', role: 'sales' });
    expect(r.ok).toBe(false);
  });
  it('role 越界拒绝', () => {
    const r = validateCreateUser({ username: 'a', password: '12345678', role: 'x' });
    expect(r.ok).toBe(false);
  });
  it('合法返回归一化', () => {
    const r = validateCreateUser({ username: 'a', password: '12345678', role: 'sales', display_name: 'A', org_id: 'o1' });
    expect(r.ok).toBe(true);
    expect(r.normalized.username).toBe('a');
    expect(r.normalized.role).toBe('sales');
    expect(r.normalized.org_id).toBe('o1');
  });
});

describe('renderUsers', () => {
  it('按租户分组', () => {
    const html = renderUsers([
      { user_id: '1', username: 'u1', tenant_id: 'tA', role: 'sales', display_name: 'U1', enabled: true },
      { user_id: '2', username: 'u2', tenant_id: 'tB', role: 'manager', display_name: 'U2', enabled: true },
    ]);
    expect(html).toMatch(/tA/);
    expect(html).toMatch(/tB/);
    expect(html).toMatch(/user-group/); // 分组容器
    expect(html).toMatch(/tenant-all/); // 租户全选勾选框
  });
  it('空降级', () => {
    expect(renderUsers([])).toMatch(/无用户/);
  });
});

describe('validateBatchUsers', () => {
  it('合法 enable', () => {
    const r = validateBatchUsers({ action: 'enable', user_ids: ['a', 'b'] });
    expect(r.ok).toBe(true);
    expect(r.normalized.action).toBe('enable');
  });
  it('user_ids 空拒绝', () => {
    const r = validateBatchUsers({ action: 'enable', user_ids: [] });
    expect(r.ok).toBe(false);
  });
  it('action 越界拒绝', () => {
    const r = validateBatchUsers({ action: 'nuke', user_ids: ['a'] });
    expect(r.ok).toBe(false);
  });
  it('set_expiry 缺 expires_at 拒绝', () => {
    const r = validateBatchUsers({ action: 'set_expiry', user_ids: ['a'] });
    expect(r.ok).toBe(false);
  });
  it('set_expiry 合法时间 + null 清除', () => {
    expect(validateBatchUsers({ action: 'set_expiry', user_ids: ['a'], expires_at: '2030-01-01T00:00:00.000Z' }).ok).toBe(true);
    const n = validateBatchUsers({ action: 'set_expiry', user_ids: ['a'], expires_at: null });
    expect(n.ok).toBe(true);
    expect(n.normalized.expires_at).toBeNull();
  });
  it('单次上限 500', () => {
    const r = validateBatchUsers({ action: 'enable', user_ids: Array(501).fill('x') });
    expect(r.ok).toBe(false);
  });
});

describe('handler — GET /api/config/users', () => {
  it('admin 返回列表', async () => {
    const d = makeDeps([{ user_id: 'u1', username: 'u1', role: 'sales', display_name: 'U1', enabled: true }]);
    const router = createUserRouter(d);
    const res = mockRes();
    await router.handlers.get({}, res);
    expect(res._status()).toBe(200);
    expect(res._body().users.length).toBe(1);
    expect(d.query).toHaveBeenCalled();
  });
});

// 租户收敛（2026-09-04）：修复「切换销售视角」下拉经此端点泄露其它租户用户名
describe('handler — GET /api/config/users 租户收敛', () => {
  function makeScopedDeps({ role, tenantId }) {
    // 模拟真实 listUsers：scope 为具体租户只返回该租户；null/'*' 返回全部
    const all = [
      { user_id: 'u1', username: 'sysu', tenant_id: 'system', role: 'sales' },
      { user_id: 'u2', username: 'chemu', tenant_id: 'acme-chem', role: 'sales' },
      { user_id: 'u3', username: 'insu', tenant_id: 'acme-insmedi', role: 'sales' },
    ];
    const listUsers = vi.fn(async (scope) => {
      const s = scope && scope !== '*' ? scope : null;
      return s ? all.filter((u) => u.tenant_id === s) : all;
    });
    const resolveMe = vi.fn(async () => ({ ok: true, role, display_name: 'X', username: 'x', tenantId: tenantId || 'system' }));
    return {
      deps: {
        query: vi.fn(async () => ({ rows: [] })),
        createUser: vi.fn(), updateUser: vi.fn(),
        recordDecisionEvent: vi.fn(async () => ({ event_id: 'e' })),
        resolveMe, hashPassword: vi.fn(async (p) => 'H(' + p + ')'),
        listRoleTags: vi.fn(async () => []), batchUpdateUsers: vi.fn(async () => 0),
        listUsers,
      },
      listUsers,
    };
  }
  it('admin 默认（无参）= 全量（用户管理页 users.html 需要跨租户）', async () => {
    const { deps, listUsers } = makeScopedDeps({ role: 'admin', tenantId: 'system' });
    const res = mockRes();
    await createUserRouter(deps).handlers.get({ query: {} }, res);
    expect(res._status()).toBe(200);
    expect(listUsers).toHaveBeenCalledWith(null);
    expect(res._body().users.map((u) => u.username)).toEqual(['sysu', 'chemu', 'insu']);
  });
  it('admin ?tenant=me = 仅本具体租户（system），不再含 acme-chem/insmedi', async () => {
    const { deps, listUsers } = makeScopedDeps({ role: 'admin', tenantId: 'system' });
    const res = mockRes();
    await createUserRouter(deps).handlers.get({ query: { tenant: 'me' } }, res);
    expect(res._status()).toBe(200);
    expect(listUsers).toHaveBeenCalledWith('system');
    expect(res._body().users.map((u) => u.username)).toEqual(['sysu']);
  });
  it('manager ?tenant=me = 200 且仅本租户（修复此前 403 + 跨租户泄露）', async () => {
    const { deps, listUsers } = makeScopedDeps({ role: 'manager', tenantId: 'acme-chem' });
    const res = mockRes();
    await createUserRouter(deps).handlers.get({ query: { tenant: 'me' } }, res);
    expect(res._status()).toBe(200);
    expect(listUsers).toHaveBeenCalledWith('acme-chem');
    expect(res._body().users.map((u) => u.username)).toEqual(['chemu']);
  });
  it('sales 调用 = 403', async () => {
    const { deps } = makeScopedDeps({ role: 'sales', tenantId: 'acme-chem' });
    const res = mockRes();
    await createUserRouter(deps).handlers.get({ query: { tenant: 'me' } }, res);
    expect(res._status()).toBe(403);
  });
});

describe('handler — POST /api/config/users', () => {
  it('admin 新建：hashPassword+INSERT+决策事件', async () => {
    const d = makeDeps();
    const router = createUserRouter(d);
    const res = mockRes();
    await router.handlers.post({ body: { username: 'new', password: '12345678', role: 'sales' } }, res);
    expect(res._status()).toBe(200);
    expect(res._body().ok).toBe(true);
    expect(d.hashPassword).toHaveBeenCalledWith('12345678');
    expect(d.query).toHaveBeenCalledWith(expect.stringMatching(/INSERT INTO crm\.crm_users/), expect.any(Array));
    const insertCall = d.query.mock.calls.find((c) => c[0].includes('INSERT'));
    expect(insertCall[1]).toContain('HASH(12345678)'); // 入库为 hash，非明文
    expect(d.recordDecisionEvent).toHaveBeenCalledWith('config_change', expect.objectContaining({ type: 'user_create' }));
  });
  it('缺 password 400', async () => {
    const d = makeDeps();
    const router = createUserRouter(d);
    const res = mockRes();
    await router.handlers.post({ body: { username: 'new', role: 'sales' } }, res);
    expect(res._status()).toBe(400);
    expect(d.query).not.toHaveBeenCalledWith(expect.stringMatching(/INSERT/), expect.any(Array));
  });
  it('role 越界 400', async () => {
    const d = makeDeps();
    const router = createUserRouter(d);
    const res = mockRes();
    await router.handlers.post({ body: { username: 'new', password: '12345678', role: 'x' } }, res);
    expect(res._status()).toBe(400);
  });
  it('非 admin 写 403', async () => {
    const d = makeDeps([], 'sales');
    const router = createUserRouter(d);
    const res = mockRes();
    await router.handlers.post({ body: { username: 'new', password: '12345678', role: 'sales' } }, res);
    expect(res._status()).toBe(403);
  });
  it('sysadmin 新建通过', async () => {
    const d = makeDeps([], 'sysadmin');
    const router = createUserRouter(d);
    const res = mockRes();
    await router.handlers.post({ body: { username: 'sa', password: '12345678', role: 'sales' } }, res);
    expect(res._status()).toBe(200);
    expect(res._body().ok).toBe(true);
  });
  it('ten_admin 新建 ten_admin 通过', async () => {
    const d = makeDeps([], 'ten_admin');
    d.resolveMe.mockResolvedValue({ ok: true, role: 'ten_admin', display_name: 'TA', username: 'ta', tenantId: 'acme' });
    const router = createUserRouter(d);
    const res = mockRes();
    await router.handlers.post({ body: { username: 'ta2', password: '12345678', role: 'ten_admin' } }, res);
    expect(res._status()).toBe(200);
    expect(res._body().ok).toBe(true);
  });
  it('ten_admin 新建 admin 拒绝（越权）', async () => {
    const d = makeDeps([], 'ten_admin');
    d.resolveMe.mockResolvedValue({ ok: true, role: 'ten_admin', display_name: 'TA', username: 'ta', tenantId: 'acme' });
    const router = createUserRouter(d);
    const res = mockRes();
    await router.handlers.post({ body: { username: 'bad', password: '12345678', role: 'admin' } }, res);
    expect(res._status()).toBe(403);
  });
  it('ten_admin 新建 sysadmin 拒绝（越权）', async () => {
    const d = makeDeps([], 'ten_admin');
    d.resolveMe.mockResolvedValue({ ok: true, role: 'ten_admin', display_name: 'TA', username: 'ta', tenantId: 'acme' });
    const router = createUserRouter(d);
    const res = mockRes();
    await router.handlers.post({ body: { username: 'bad', password: '12345678', role: 'sysadmin' } }, res);
    expect(res._status()).toBe(403);
  });
});

describe('handler — PUT /api/config/users', () => {
  it('admin 改 role：UPDATE+决策事件', async () => {
    const d = makeDeps([{ user_id: 'u1', username: 'u1', role: 'sales', display_name: 'U1', enabled: true }]);
    const router = createUserRouter(d);
    const res = mockRes();
    await router.handlers.put({ body: { user_id: 'u1', patch: { role: 'manager' } } }, res);
    expect(res._status()).toBe(200);
    expect(res._body().ok).toBe(true);
    expect(d.query).toHaveBeenCalledWith(expect.stringMatching(/UPDATE crm\.crm_users/), expect.any(Array));
    expect(d.recordDecisionEvent).toHaveBeenCalledWith('config_change', expect.objectContaining({ type: 'user_update' }));
  });
  it('role 越界 400', async () => {
    const d = makeDeps([{ user_id: 'u1', username: 'u1', role: 'sales', display_name: 'U1', enabled: true }]);
    const router = createUserRouter(d);
    const res = mockRes();
    await router.handlers.put({ body: { user_id: 'u1', patch: { role: 'hacker' } } }, res);
    expect(res._status()).toBe(400);
  });
  it('禁用 enabled=false：UPDATE 含 enabled', async () => {
    const d = makeDeps([{ user_id: 'u1', username: 'u1', role: 'sales', display_name: 'U1', enabled: true }]);
    const router = createUserRouter(d);
    const res = mockRes();
    await router.handlers.put({ body: { user_id: 'u1', patch: { enabled: false } } }, res);
    expect(res._status()).toBe(200);
    const upd = d.query.mock.calls.find((c) => c[0].includes('UPDATE'));
    expect(upd[0]).toMatch(/enabled=/);
    expect(upd[1]).toContain(false);
  });
  it('非 admin 写 403', async () => {
    const d = makeDeps([{ user_id: 'u1', username: 'u1', role: 'sales', display_name: 'U1', enabled: true }], 'sales');
    const router = createUserRouter(d);
    const res = mockRes();
    await router.handlers.put({ body: { user_id: 'u1', patch: { role: 'manager' } } }, res);
    expect(res._status()).toBe(403);
  });
  it('sysadmin 改 role 通过', async () => {
    const d = makeDeps([{ user_id: 'u1', username: 'u1', tenant_id: 'system', role: 'sales', display_name: 'U1', enabled: true }]);
    d.resolveMe.mockResolvedValue({ ok: true, role: 'sysadmin', display_name: 'SA', username: 'sa', tenantId: 'system' });
    const router = createUserRouter(d);
    const res = mockRes();
    await router.handlers.put({ body: { user_id: 'u1', patch: { role: 'ten_admin' } } }, res);
    expect(res._status()).toBe(200);
    expect(res._body().ok).toBe(true);
  });
  it('ten_admin 改 role 到 admin 拒绝（越权）', async () => {
    const d = makeDeps([{ user_id: 'u1', username: 'u1', tenant_id: 'acme', role: 'sales', display_name: 'U1', enabled: true }]);
    d.resolveMe.mockResolvedValue({ ok: true, role: 'ten_admin', display_name: 'TA', username: 'ta', tenantId: 'acme' });
    const router = createUserRouter(d);
    const res = mockRes();
    await router.handlers.put({ body: { user_id: 'u1', patch: { role: 'admin' } } }, res);
    expect(res._status()).toBe(403);
  });
  it('ten_admin 编辑 admin 用户拒绝（越权）', async () => {
    const d = makeDeps([{ user_id: 'u1', username: 'u1', tenant_id: 'acme', role: 'admin', display_name: 'U1', enabled: true }]);
    d.resolveMe.mockResolvedValue({ ok: true, role: 'ten_admin', display_name: 'TA', username: 'ta', tenantId: 'acme' });
    const router = createUserRouter(d);
    const res = mockRes();
    await router.handlers.put({ body: { user_id: 'u1', patch: { display_name: 'X' } } }, res);
    expect(res._status()).toBe(403);
  });
  it('设有效期 expires_at：UPDATE 含 expires_at', async () => {
    const d = makeDeps([{ user_id: 'u1', username: 'u1', tenant_id: 'tA', role: 'sales', display_name: 'U1', enabled: true }]);
    const router = createUserRouter(d);
    const res = mockRes();
    await router.handlers.put({ body: { user_id: 'u1', patch: { expires_at: '2030-01-01T00:00:00.000Z' } } }, res);
    expect(res._status()).toBe(200);
    const upd = d.query.mock.calls.find((c) => c[0].includes('UPDATE'));
    expect(upd[0]).toMatch(/expires_at=/);
  });
  it('expires_at 非法值拒绝', async () => {
    const d = makeDeps([{ user_id: 'u1', username: 'u1', tenant_id: 'tA', role: 'sales', display_name: 'U1', enabled: true }]);
    const router = createUserRouter(d);
    const res = mockRes();
    await router.handlers.put({ body: { user_id: 'u1', patch: { expires_at: 'not-a-date' } } }, res);
    expect(res._status()).toBe(400);
  });
});

describe('handler — PUT /api/config/users/batch', () => {
  it('admin 成批冻结：UPDATE+决策事件', async () => {
    const d = makeDeps([
      { user_id: 'u1', tenant_id: 'tA', role: 'sales', display_name: 'U1', enabled: true },
      { user_id: 'u2', tenant_id: 'tA', role: 'sales', display_name: 'U2', enabled: true },
    ]);
    const router = createUserRouter(d);
    const res = mockRes();
    await router.handlers.batch({ body: { action: 'freeze', user_ids: ['u1', 'u2'] } }, res);
    expect(res._status()).toBe(200);
    expect(res._body().ok).toBe(true);
    expect(d.batchUpdateUsers).toHaveBeenCalledWith('freeze', ['u1', 'u2'], null);
    expect(d.recordDecisionEvent).toHaveBeenCalledWith('config_change', expect.objectContaining({ type: 'user_batch_update', action: 'freeze' }));
  });
  it('set_expiry 传 expires_at', async () => {
    const d = makeDeps([{ user_id: 'u1', tenant_id: 'tA', role: 'sales', display_name: 'U1', enabled: true }]);
    const router = createUserRouter(d);
    const res = mockRes();
    await router.handlers.batch({ body: { action: 'set_expiry', user_ids: ['u1'], expires_at: '2030-01-01T00:00:00.000Z' } }, res);
    expect(res._status()).toBe(200);
    expect(d.batchUpdateUsers).toHaveBeenCalledWith('set_expiry', ['u1'], '2030-01-01T00:00:00.000Z');
  });
  it('校验失败 400', async () => {
    const d = makeDeps();
    const router = createUserRouter(d);
    const res = mockRes();
    await router.handlers.batch({ body: { action: 'enable', user_ids: [] } }, res);
    expect(res._status()).toBe(400);
  });
  it('非 admin 403', async () => {
    const d = makeDeps([], 'sales');
    const router = createUserRouter(d);
    const res = mockRes();
    await router.handlers.batch({ body: { action: 'enable', user_ids: ['u1'] } }, res);
    expect(res._status()).toBe(403);
  });
});
