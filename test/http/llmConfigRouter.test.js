// test/http/llmConfigRouter.test.js — 多条 LLM 配置端点（T3）
// 注入式：store 依赖与连通测试全部注入，不触真实 PG / 不发真实网络请求
// 覆盖：sysadmin 角色闸 / 列表脱敏 / 新增（name 唯一、密钥加密）/ 改（密钥未传保留）/
//       软删（禁删 default）/ 设默认 / 测试连通 / 写经第0闸
import { describe, it, expect, vi } from 'vitest';
import { createLlmConfigRouter } from '../../src/http/llmConfigRouter.js';

const ROW_A = {
  id: 'c1', name: 'sf-main', provider: 'siliconflow', model: 'mA',
  base_url: 'https://api.siliconflow.cn/v1', api_key: 'ENC:sk-a', is_default: true, tenant_id: 'system',
};
const ROW_B = {
  id: 'c2', name: 'ds-backup', provider: 'deepseek', model: 'mB',
  base_url: 'https://api.deepseek.com/v1', api_key: 'ENC:sk-b', is_default: false, tenant_id: 'system',
};

// fake 依赖：内存 store + 注入的第0闸/角色/加解密/连通测试
function makeDeps({ rows = [ROW_A, ROW_B], role = 'admin', testResult = { ok: true, status: 200, ms: 12 } } = {}) {
  const state = { rows: rows.map((r) => ({ ...r })), decisions: [], upserts: [] };
  return {
    state,
    deps: {
      listConfigs: async () => state.rows.filter((r) => !r.is_deleted),
      getByName: async (name) => state.rows.find((r) => r.name === name && !r.is_deleted) || null,
      upsertConfig: async (p) => {
        state.upserts.push(p);
        if (p.id) {
          const i = state.rows.findIndex((r) => r.id === p.id);
          if (i < 0) return null;
          state.rows[i] = { ...state.rows[i], ...p };
          return state.rows[i];
        }
        const row = { id: `c${state.rows.length + 1}`, tenant_id: 'system', ...p };
        state.rows.push(row);
        return row;
      },
      deleteConfig: async (id) => {
        const r = state.rows.find((x) => x.id === id && !x.is_deleted);
        if (!r) return { ok: false, error: 'not_found' };
        if (r.is_default) return { ok: false, error: 'cannot_delete_default' };
        r.is_deleted = true;
        return { ok: true };
      },
      setDefault: async (id) => {
        const r = state.rows.find((x) => x.id === id && !x.is_deleted);
        if (!r) return null;
        for (const x of state.rows) x.is_default = false;
        r.is_default = true;
        return r;
      },
      produceDecision: async (scene, ctx) => { state.decisions.push({ scene, ctx }); return { decisionId: 'dec-1', ok: true }; },
      resolveMe: async () => ({ ok: true, role, username: 'alice' }),
      encryptSecret: (p) => `ENC:${p}`,
      maskSecret: (c) => (String(c).startsWith('ENC:') ? `********${String(c).slice(-4)}` : '********'),
      testConnect: vi.fn(async () => testResult),
    },
  };
}

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { res.body = o; return res; };
  return res;
}

function routerWith(opts) {
  const { deps, state } = makeDeps(opts);
  return { router: createLlmConfigRouter(deps), state, deps };
}

describe('llmConfigRouter 角色闸', () => {
  it('非 sysadmin → 403', async () => {
    const { router } = routerWith({ role: 'sales' });
    const res = fakeRes();
    await router.handlers.list({}, res);
    expect(res.statusCode).toBe(403);
  });

  it('sysadmin（实际角色 admin）→ 放行', async () => {
    const { router } = routerWith({ role: 'admin' });
    const res = fakeRes();
    await router.handlers.list({}, res);
    expect(res.statusCode).toBe(200);
  });
});

describe('llmConfigRouter list', () => {
  it('返回列表且 api_key 掩码（明文不出网）', async () => {
    const { router } = routerWith();
    const res = fakeRes();
    await router.handlers.list({}, res);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0].api_key).toBe('********sk-a');
    expect(res.body.items[0].api_key).not.toContain('sk-a'.slice(-4) === '' ? 'ENC' : 'ENC:sk-a');
  });
});

describe('llmConfigRouter create', () => {
  it('新增成功 → 201 + api_key 加密落库 + 写经第0闸', async () => {
    const { router, state } = routerWith();
    const res = fakeRes();
    await router.handlers.create({
      body: { name: 'new-cfg', provider: 'openai', model: 'gpt-x', api_key: 'sk-plain', base_url: 'https://api.openai.com/v1' },
    }, res);
    expect(res.statusCode).toBe(201);
    expect(res.body.item.api_key).toBe('********lain'); // 掩码出参
    expect(state.upserts[0].api_key).toBe('ENC:sk-plain'); // 加密入库
    expect(state.decisions[0].ctx.action).toBe('create'); // 第0闸已过
  });

  it('name 重复 → 409', async () => {
    const { router } = routerWith();
    const res = fakeRes();
    await router.handlers.create({ body: { name: 'sf-main', provider: 'openai', model: 'x' } }, res);
    expect(res.statusCode).toBe(409);
  });

  it('缺 provider/model → 400', async () => {
    const { router } = routerWith();
    const res = fakeRes();
    await router.handlers.create({ body: { name: 'no-provider' } }, res);
    expect(res.statusCode).toBe(400);
  });
});

describe('llmConfigRouter update', () => {
  it('未传 api_key → 保留既有密钥（不下发 undefined 覆盖）', async () => {
    const { router, state } = routerWith();
    const res = fakeRes();
    await router.handlers.update({ params: { id: 'c1' }, body: { model: 'mA2' } }, res);
    expect(res.statusCode).toBe(200);
    expect(state.upserts[0].api_key).toBeUndefined(); // → store 层 COALESCE 保留
    expect(state.upserts[0].model).toBe('mA2');
  });

  it('改名为已存在的 name → 409（DB UNIQUE 约束在网关层拦截，不给 500）', async () => {
    const { router } = routerWith();
    const res = fakeRes();
    await router.handlers.update({ params: { id: 'c2' }, body: { name: 'sf-main' } }, res);
    expect(res.statusCode).toBe(409);
  });

  it('id 不存在 → 404', async () => {
    const { router } = routerWith();
    const res = fakeRes();
    await router.handlers.update({ params: { id: 'nope' }, body: { model: 'x' } }, res);
    expect(res.statusCode).toBe(404);
  });
});

describe('llmConfigRouter remove / set-default', () => {
  it('删除 default → 400 cannot_delete_default（软删语义，禁物理 DELETE）', async () => {
    const { router, state } = routerWith();
    const res = fakeRes();
    await router.handlers.remove({ params: { id: 'c1' } }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('cannot_delete_default');
    expect(state.rows.find((r) => r.id === 'c1').is_deleted).toBeFalsy();
  });

  it('删除非 default → 软删成功', async () => {
    const { router, state } = routerWith();
    const res = fakeRes();
    await router.handlers.remove({ params: { id: 'c2' } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.soft).toBe(true);
    expect(state.rows.find((r) => r.id === 'c2').is_deleted).toBe(true);
  });

  it('set-default → 目标置默认，且旧默认被清（唯一性）', async () => {
    const { router, state } = routerWith();
    const res = fakeRes();
    await router.handlers.setDefault({ params: { id: 'c2' } }, res);
    expect(res.statusCode).toBe(200);
    expect(state.rows.find((r) => r.id === 'c2').is_default).toBe(true);
    expect(state.rows.filter((r) => r.is_default)).toHaveLength(1);
  });

  it('set-default 不存在的 id → 404', async () => {
    const { router } = routerWith();
    const res = fakeRes();
    await router.handlers.setDefault({ params: { id: 'nope' } }, res);
    expect(res.statusCode).toBe(404);
  });
});

describe('llmConfigRouter test 连通', () => {
  it('测试连通 → 返回 ok/ms', async () => {
    const { router, deps } = routerWith();
    const res = fakeRes();
    await router.handlers.test({ params: { id: 'c1' } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(deps.testConnect).toHaveBeenCalledTimes(1);
  });

  it('id 不存在 → 404 且不发起连通测试', async () => {
    const { router, deps } = routerWith();
    const res = fakeRes();
    await router.handlers.test({ params: { id: 'nope' } }, res);
    expect(res.statusCode).toBe(404);
    expect(deps.testConnect).not.toHaveBeenCalled();
  });
});
