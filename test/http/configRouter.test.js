// test/http/configRouter.test.js — Task 7: 通用配置端点（GET/PUT /api/config/:key，写经第0闸 + 七维拦截）
// 设计输入：docs/2026-08-26-frontend-config-pages-master-plan.md Task 7 + 蓝图 §3 配置面
// 注入式：db 读写与 decision 函数可注入（不依赖真实 PG / 真实决策引擎）
import { describe, it, expect } from 'vitest';
import { createConfigRouter } from '../../src/http/configRouter.js';

// fake 依赖：读写 config_store；决策 produce 注入
function makeDeps({ store = {}, blockDecision = false, role = 'admin' } = {}) {
  return {
    readConfig: async (key) => store[key] || null,
    writeConfig: async (key, value, decision) => { store[key] = { value, decision }; return { key, ok: true }; },
    produceDecision: async () => ({ decisionId: 'dec-1', ok: true }),
    sevenCheck: async () => (blockDecision
      ? { allowed: false, level: 'block', missing: [{ dim: 'structure', on_missing: 'block' }] }
      : { allowed: true, level: 'ok', missing: [] }),
    resolveMe: async () => ({ ok: true, role }),
    encryptSecret: (p) => `ENC:${p}`,
    maskSecret: (c) => (String(c).startsWith('ENC:') ? `********${String(c).slice(-4)}` : '********'),
  };
}

// 模拟 Express req/res
function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { res.body = o; return res; };
  return res;
}

describe('configRouter 通用配置端点', () => {
  it('GET 返回已存配置', async () => {
    const deps = makeDeps({ store: { 'seven-dim': { value: { required_dims: [] }, decision: 'dec-0' } } });
    const router = createConfigRouter({ key: 'seven-dim', role: 'sysadmin', decisionScene: 'scene-quote' }, deps);
    const res = fakeRes();
    await router.handlers.get({ query: {} }, res);
    expect(res.body.value.required_dims).toEqual([]);
  });

  it('GET 未配置 → 404', async () => {
    const deps = makeDeps({});
    const router = createConfigRouter({ key: 'llm', role: 'sysadmin' }, deps);
    const res = fakeRes();
    await router.handlers.get({ query: {} }, res);
    expect(res.statusCode).toBe(404);
  });

  it('PUT 正常 → 写 store + 附 decision', async () => {
    let written = null;
    const deps = makeDeps({});
    deps.writeConfig = async (key, value, decisionId) => { written = { key, value, decisionId }; return { key, ok: true }; };
    const router = createConfigRouter({ key: 'llm', role: 'sysadmin', decisionScene: 'scene-llm' }, deps);
    const res = fakeRes();
    await router.handlers.put({ body: { value: { provider: 'deepseek', model: 'v4' } }, headers: {} }, res);
    expect(res.statusCode).toBe(200);
    expect(written.key).toBe('llm');
    expect(written.value.provider).toBe('deepseek');
    expect(written.decisionId).toBe('dec-1');
  });

  it('PUT 七维拦截（block）→ 422 missing_context', async () => {
    const deps = makeDeps({ blockDecision: true });
    const router = createConfigRouter({ key: 'seven-dim', role: 'sysadmin', decisionScene: 'scene-quote' }, deps);
    const res = fakeRes();
    await router.handlers.put({ body: { value: {} }, headers: {} }, res);
    expect(res.statusCode).toBe(422);
    expect(res.body.error).toBe('missing_context');
  });

  it('PUT 无 body.value → 400', async () => {
    const deps = makeDeps({});
    const router = createConfigRouter({ key: 'llm', role: 'sysadmin' }, deps);
    const res = fakeRes();
    await router.handlers.put({ body: {}, headers: {} }, res);
    expect(res.statusCode).toBe(400);
  });

  it('无 decisionScene → 不触发七维，直写', async () => {
    let written = null;
    const deps = makeDeps({});
    deps.writeConfig = async (key, value, decisionId) => { written = { key, value, decisionId }; return { key, ok: true }; };
    const router = createConfigRouter({ key: 'system', role: 'sysadmin' }, deps); // 无 decisionScene
    const res = fakeRes();
    await router.handlers.put({ body: { value: { theme: 'light' } }, headers: {} }, res);
    expect(res.statusCode).toBe(200);
    expect(written.key).toBe('system');
    expect(written.decisionId).toBe('dec-1'); // 无场景仍产 decision（写第0闸）
  });

  it('非 admin 角色 GET → 403（§15.1 租户级三角色闸，sales 拒）', async () => {
    const deps = makeDeps({ store: { llm: { value: { provider: 'deepseek' }, decision: 'dec-0' } }, role: 'sales' });
    const router = createConfigRouter({ key: 'llm', role: 'sysadmin' }, deps);
    const res = fakeRes();
    await router.handlers.get({ query: {}, headers: { authorization: 'Bearer x' } }, res);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toContain('tan_admin/sysadmin/ADMIN');
  });

  it('非 admin 角色 PUT → 403（sysadmin 闸）', async () => {
    const deps = makeDeps({ role: 'sales' });
    const router = createConfigRouter({ key: 'llm', role: 'sysadmin' }, deps);
    const res = fakeRes();
    await router.handlers.put({ body: { value: { provider: 'deepseek' } }, headers: { authorization: 'Bearer x' } }, res);
    expect(res.statusCode).toBe(403);
  });

  it('llm 密钥字段 PUT 加密落库 / GET 掩码返回', async () => {
    const store = {};
    const deps = makeDeps({ store });
    deps.writeConfig = async (key, value, decisionId) => { store[key] = { value, decision: decisionId }; return { key, ok: true }; };
    const router = createConfigRouter({ key: 'llm', role: 'sysadmin', secretFields: ['api_key'] }, deps);
    // PUT 带 api_key
    const putRes = fakeRes();
    await router.handlers.put(
      { body: { value: { provider: 'deepseek', model: 'v4', api_key: 'sk-secret1234' } }, headers: { authorization: 'Bearer x' } },
      putRes,
    );
    expect(putRes.statusCode).toBe(200);
    expect(store.llm.value.api_key).toBe('ENC:sk-secret1234'); // 落库为密文，明文不入
    // GET 应返回掩码
    const getRes = fakeRes();
    await router.handlers.get({ query: {}, headers: { authorization: 'Bearer x' } }, getRes);
    expect(getRes.statusCode).toBe(200);
    expect(getRes.body.value.api_key).toBe('********1234'); // 仅末 4 位可见
    // 部分更新（不传 api_key）应保留既有密文
    const put2 = fakeRes();
    await router.handlers.put(
      { body: { value: { provider: 'siliconflow', model: 'deepseek-v4' } }, headers: { authorization: 'Bearer x' } },
      put2,
    );
    expect(store.llm.value.api_key).toBe('ENC:sk-secret1234'); // 既有密钥保留
  });

  it('scope=platform → GET/PUT 恒 (system,key)，无视 me 租户', async () => {
    const calls = [];
    const deps = makeDeps({});
    deps.readConfig = async (key, { tenantId }) => { calls.push(['read', key, tenantId]); return { value: { provider: 'x' }, decision: null }; };
    deps.writeConfig = async (key, value, decisionId, { tenantId }) => { calls.push(['write', key, tenantId]); return { ok: true }; };
    const router = createConfigRouter({ key: 'llm', role: 'sysadmin', scope: 'platform' }, deps);
    const res = fakeRes();
    await router.handlers.get({ headers: { authorization: 'Bearer x' } }, res);
    await router.handlers.put({ body: { value: { provider: 'y' } }, headers: { authorization: 'Bearer x' } }, res);
    expect(calls.filter((c) => c[0] === 'read').map((c) => c[2])).toEqual(['system']);
    expect(calls.filter((c) => c[0] === 'write').map((c) => c[2])).toEqual(['system']);
  });

  it('scope=tenant（默认）→ 读按 scopeTenant(me)，写按 scopeOf(me)', async () => {
    const calls = [];
    const deps = makeDeps({});
    deps.resolveMe = async () => ({ ok: true, role: 'admin', tenantId: 'acme' });
    deps.readConfig = async (key, { tenantId }) => { calls.push(['read', tenantId]); return { value: { a: 1 }, decision: null }; };
    deps.writeConfig = async (key, value, decisionId, { tenantId }) => { calls.push(['write', tenantId]); return { ok: true }; };
    const router = createConfigRouter({ key: 'sales-thresholds', role: 'sysadmin' }, deps);
    const res = fakeRes();
    await router.handlers.get({ headers: { authorization: 'Bearer x' } }, res);
    await router.handlers.put({ body: { value: { a: 2 } }, headers: { authorization: 'Bearer x' } }, res);
    expect(calls[0][1]).toBe('*');    // admin 读通配（回退 system）
    expect(calls[1][1]).toBe('acme'); // admin 写自身租户（永不通配）
  });
});

describe('configRouter 通用配置端点（seven-dim 已移交 sevenDimRouter，不再由 configRouter 承载）', () => {
  it('配置端点仍可用（占位防误删）', async () => {
    const deps = makeDeps({});
    const router = createConfigRouter({ key: 'other-key', role: 'sysadmin', decisionScene: 'scene-quote' }, deps);
    const res = fakeRes();
    await router.handlers.get({ query: {} }, res);
    expect(res.statusCode).toBe(404); // 未配置
  });
});