// test/http/named-account-assign-router.test.js — 指名客户分配写通道 Router（注入式）
// 契约（docs/2026-08-30-named-account-manage-design.md §2）：
//   GET  /api/named-account-assign/options       → { accounts(未分配), users(销售) }（admin/manager 闸）
//   POST /api/named-account-assign               → 决策第0闸 → updateParticle(named_owner/tier/state) + 审计边 named_assignment
//   POST /api/named-account-assign/:id/deactivate → 软停用 named_state=inactive（禁删铁律，零 DELETE）
// 范式对齐：namedAccountTargetsRouter.js（scenarioDeps.produceDecision）+ particleRepo 写通道
import { describe, it, expect, beforeEach } from 'vitest';
import { createNamedAccountAssignRouter } from '../../src/http/namedAccountAssignRouter.js';

function mockDeps() {
  const calls = [];
  const deps = {
    listAccounts: async ({ owner } = {}) => [
      { id: 'A-1', title: '甲客户', payload: { name: '甲客户' } },
      ...(owner ? [] : [{ id: 'A-2', title: '已分配', payload: { named_owner: owner || 'alice' } }]),
    ],
    listUsers: async () => [
      { username: 'alice', display_name: '爱丽丝' },
      { username: 'bob', display_name: '鲍勃' },
    ],
    readAccount: async (id) => ({ id, title: '甲客户', payload: { name: '甲客户' } }),
    updateAccount: async (id, patch) => { calls.push(['update', id, patch]); return { id, payload: { ...patch } }; },
    createNamedEdge: async (args) => { calls.push(['edge', args]); return { id: 'E-1' }; },
    requireDecision: async () => { calls.push(['decision']); return { decision_id: 'DEC-1' }; },
    checkRole: async (me) => me?.role === 'admin' || me?.role === 'sysadmin' || me?.role === 'manager'
      ? { ok: true, role: me.role, username: me.username, tenantId: me.tenantId }
      : { ok: false, reason: 'role_not_allowed' },
  };
  return { deps, calls };
}

// handlerOf 按 express 注册的模式（含 :id 模式）查找——invoke 传注册模式，
// req.url 才是真实路径（params.id 替换 :id）
function handlerOf(router, method, routePattern) {
  const layer = router.stack.find((l) => l.route && l.route.methods[method.toLowerCase()] && l.route.path === routePattern);
  if (!layer) throw new Error(`route not found: ${method} ${routePattern}`);
  return layer.route.stack[0].handle;
}

async function invoke(router, method, routePattern, { body = {}, params = {}, me = { role: 'admin', username: 'boss' } } = {}) {
  const req = {
    method,
    url: routePattern.replace(':id', String(params.id ?? 'X')),
    path: routePattern, // express 匹配用：保留模式（测试直呼 handler 不走 express 匹配）
    body, params, query: {},
  };
  const res = { statusCode: 200, data: null };
  res.status = function (s) { this.statusCode = s; return this; };
  res.json = function (d) { this.data = d; return this; };
  // 注入 me 到 req.resolveMe（同步返回，对齐 auth.js 契约）
  req.resolveMe = () => me;
  await handlerOf(router, method, routePattern)(req, res, () => {});
  return res;
}

describe('namedAccountAssignRouter', () => {
  beforeEach(() => {});
  let router, deps, calls;
  beforeEach(() => {
    ({ deps, calls } = mockDeps());
    router = createNamedAccountAssignRouter(deps);
  });

  it('GET options：未分配客户 + 销售名单（admin 闸）', async () => {
    const r = await invoke(router, 'GET', '/api/named-account-assign/options', { me: { role: 'admin', username: 'boss' } });
    expect(r.statusCode).toBe(200);
    expect(r.data.accounts.some((a) => a.id === 'A-1')).toBe(true);
    expect(r.data.accounts.some((a) => a.id === 'A-2')).toBe(false); // 已分配客户不进候选项
    expect(r.data.users.map((u) => u.username)).toContain('alice');
  });

  it('POST 分配：决策第0闸 → updateParticle(named_owner/tier/active) + 审计边 named_assignment', async () => {
    const r = await invoke(router, 'POST', '/api/named-account-assign', {
      body: { account_id: 'A-1', owner: 'alice', tier: '重点' },
      me: { role: 'admin', username: 'boss' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.data.ok).toBe(true);
    const upd = calls.find((c) => c[0] === 'update');
    expect(upd[1]).toBe('A-1');
    expect(upd[2]).toMatchObject({ named_owner: 'alice', named_tier: '重点', named_state: 'active' });
    const edge = calls.find((c) => c[0] === 'edge');
    expect(edge[1]).toMatchObject({ sourceType: 'CRM_ACCOUNT', sourceId: 'A-1', edgeType: 'named_assignment', targetType: 'CRM_ACCOUNT', targetId: 'A-1' });
    expect(calls.some((c) => c[0] === 'decision')).toBe(true); // 决策第0闸已过
  });

  it('POST deactivate：软停用 named_state=inactive，不删除', async () => {
    const r = await invoke(router, 'POST', '/api/named-account-assign/:id/deactivate', {
      params: { id: 'A-1' },
      me: { role: 'manager', username: 'mgr' },
    });
    expect(r.statusCode).toBe(200);
    const upd = calls.find((c) => c[0] === 'update');
    expect(upd[1]).toBe('A-1');
    expect(upd[2].named_state).toBe('inactive');
    expect(calls.some((c) => c[0] === 'delete')).toBe(false); // 禁删铁律
  });

  it('参数缺失 → 400（account_id/owner/tier 必填）', async () => {
    const r = await invoke(router, 'POST', '/api/named-account-assign', {
      body: { account_id: 'A-1' }, // 缺 owner/tier
      me: { role: 'admin', username: 'boss' },
    });
    expect(r.statusCode).toBe(400);
  });

  it('客户不存在 → 404', async () => {
    deps.readAccount = async () => null;
    const r = await invoke(router, 'POST', '/api/named-account-assign', {
      body: { account_id: 'NOPE', owner: 'alice', tier: '重点' },
      me: { role: 'admin', username: 'boss' },
    });
    expect(r.statusCode).toBe(404);
  });

  it('角色非 admin/manager → 403（写闸前置）', async () => {
    const r = await invoke(router, 'POST', '/api/named-account-assign', {
      body: { account_id: 'A-1', owner: 'alice', tier: '重点' },
      me: { role: 'sales', username: 'alice' },
    });
    expect(r.statusCode).toBe(403);
    expect(calls.some((c) => c[0] === 'update')).toBe(false); // 未达写通道
  });

  it('GET options：manager 身份须透传 tenantId 到 listAccounts（防错读 system 租户）', async () => {
    deps.listAccounts = async (actor) => [{ id: 'A-T1', title: '租户客户', payload: { name: '租户客户', _tenantId: actor.tenantId } }];
    const r = await invoke(router, 'GET', '/api/named-account-assign/options', { me: { role: 'manager', username: 'mgr', tenantId: 'acme-demo' } });
    expect(r.statusCode).toBe(200);
    expect(r.data.accounts[0].payload._tenantId).toBe('acme-demo');
  });
});