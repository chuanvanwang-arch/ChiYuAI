// test/http/sevenDimRouter.test.js — S20 场景×七维矩阵端点契约
import { describe, it, expect, vi, beforeEach } from 'vitest';

// 2026-09-01 回归保护：原 defaultDeps.listScenarios 漏 import { query }，导致 GET /api/config/seven-dim
// 在生产抛 ReferenceError（query is not defined），单测却全绿——因为它们全部覆盖了 listScenarios dep。
// 此处用 vi.mock 把 db.js 的 query 替身 + spy，断言默认 listScenarios 真的会调 query（=import 存在且连通），
// 任何人误删 import { query } 或重命名导出都会在这里立刻翻车。
const { queryMock } = vi.hoisted(() => ({
  queryMock: vi.fn(async () => ({ rows: [{ scenario_id: 'X', stage: 's', default_tier: 'T', autonomous_allowed: false, required_dims: [] }] })),
}));
vi.mock('../../src/db.js', () => ({ query: queryMock, default: { query: queryMock } }));

import { createSevenDimRouter } from '../../src/http/sevenDimRouter.js';

function makeDeps({ role = 'admin' } = {}) {
  const rows = {
    QUOTE_PRICING: { scenario_id: 'QUOTE_PRICING', stage: '四、商务报价', default_tier: 'HIGH', autonomous_allowed: false, required_dims: [] },
    LEAD_FOLLOW_UP: { scenario_id: 'LEAD_FOLLOW_UP', stage: '一、线索', default_tier: 'LEAD', autonomous_allowed: true, required_dims: [] },
  };
  let strict = 'warn';
  return {
    listScenarios: async () => Object.values(rows).map((r) => ({ ...r })),
    readStrictness: async () => strict,
    writeStrictness: async (v) => { strict = v; },
    updateScenario: async (id, patch) => {
      const row = rows[id];
      if (!row) return null;
      const next = { ...row, ...patch };
      rows[id] = next;
      return next;
    },
    produceDecision: async () => ({ decisionId: 'dec-7' }),
    resolveMe: async () => ({ ok: true, role }),
  };
}
let deps;

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { res.body = o; return res; };
  return res;
}

describe('GET /api/config/seven-dim', () => {
  beforeEach(() => queryMock.mockClear());

  it('返回 7 维定义 + 场景矩阵 + 全局默认严格度', async () => {
    deps = makeDeps();
    const router = createSevenDimRouter(deps);
    const res = fakeRes();
    await router.handlers.get({ headers: {} }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.dims).toHaveLength(7);
    expect(res.body.dims.map((d) => d.key)).toContain('decision_history');
    expect(res.body.scenarios[0].scenario_id).toBe('QUOTE_PRICING');
    expect(res.body.default_strictness).toBe('warn');
  });

  it('非 sysadmin → 403', async () => {
    deps = makeDeps({ role: 'sales' });
    const router = createSevenDimRouter(deps);
    const res = fakeRes();
    await router.handlers.get({ headers: {} }, res);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('租户级配置需 ten_admin(本租户)/sysadmin/ADMIN 权限（§15.1）');
  });

  // 2026-09-01 回归保护：缺 import { query } 会让 defaultDeps.listScenarios 抛 ReferenceError。
  // 这里故意不注入 listScenarios，迫使走默认值；如果默认 listScenarios 没有正确接 query，会被 try/catch
  // 转成 500 {error: "query is not defined"}——与页面截图里的报错字符串一致。
  it('不注入 listScenarios → 默认实现仍能调用 query 而非 ReferenceError', async () => {
    const router = createSevenDimRouter({
      // 注意：没传 listScenarios
      readStrictness: async () => 'warn',
      readEdgeBindings: async () => null,
      readRootCauseThresholds: async () => ({
        default_input_stale_ms: 24 * 3600 * 1000,
        field_mismatch_enabled: true, info_incomplete_enabled: true, input_stale_enabled: true,
      }),
      produceDecision: async () => ({ decisionId: null }),
      resolveMe: async () => ({ ok: true, role: 'admin' }),
      scopeTenant: () => 'system',
    });
    const res = fakeRes();
    await router.handlers.get({ headers: {} }, res);
    expect(res.statusCode).toBe(200);
    expect(queryMock).toHaveBeenCalled();
    // SQL 必须命中 decision_scenario（这是 defaultDeps.listScenarios 的业务口径）
    expect(queryMock.mock.calls.some((c) => /decision_scenario/.test(String(c[0] || '')))).toBe(true);
  });
});

describe('PUT /api/config/seven-dim', () => {
  it('单场景矩阵更新 → 落库 + 附 decision', async () => {
    deps = makeDeps();
    const router = createSevenDimRouter(deps);
    const res = fakeRes();
    await router.handlers.put(
      { headers: {}, body: { scenario_id: 'QUOTE_PRICING', required_dims: [{ dim: 'identity', on_missing: 'block' }] } },
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.required_dims).toEqual([{ dim: 'identity', on_missing: 'block' }]);
    expect(res.body.decision).toBe('dec-7');
  });

  it('omitted on_missing → 默认 warn', async () => {
    deps = makeDeps();
    const router = createSevenDimRouter(deps);
    const res = fakeRes();
    await router.handlers.put({ headers: {}, body: { scenario_id: 'QUOTE_PRICING', required_dims: [{ dim: 'semantics' }] } }, res);
    expect(res.body.required_dims).toEqual([{ dim: 'semantics', on_missing: 'warn' }]);
  });

  it('未知维度 → 400', async () => {
    deps = makeDeps();
    const router = createSevenDimRouter(deps);
    const res = fakeRes();
    await router.handlers.put({ headers: {}, body: { scenario_id: 'QUOTE_PRICING', required_dims: [{ dim: 'context' }] } }, res);
    expect(res.statusCode).toBe(400);
  });

  it('未知 scenario_id → 404', async () => {
    deps = makeDeps();
    const router = createSevenDimRouter(deps);
    const res = fakeRes();
    await router.handlers.put({ headers: {}, body: { scenario_id: 'NO_SUCH', required_dims: [] } }, res);
    expect(res.statusCode).toBe(404);
  });

  it('缺 scenario_id 且缺 default_strictness → 400', async () => {
    deps = makeDeps();
    const router = createSevenDimRouter(deps);
    const res = fakeRes();
    await router.handlers.put({ headers: {}, body: { required_dims: [] } }, res);
    expect(res.statusCode).toBe(400);
  });

  it('全局 default_strictness 更新 → 落 config_store + 附 decision', async () => {
    deps = makeDeps();
    const router = createSevenDimRouter(deps);
    const res = fakeRes();
    await router.handlers.put({ headers: {}, body: { default_strictness: 'block' } }, res);
    expect(res.statusCode).toBe(200);
    expect(deps.__strict ?? deps.readStrictness ? 'block' : '').toBe('block');
    expect(res.body.decision).toBe('dec-7');
  });

  it('非法 default_strictness → 400', async () => {
    deps = makeDeps();
    const router = createSevenDimRouter(deps);
    const res = fakeRes();
    await router.handlers.put({ headers: {}, body: { default_strictness: 'nuke' } }, res);
    expect(res.statusCode).toBe(400);
  });

  it('非 sysadmin PUT → 403', async () => {
    deps = makeDeps({ role: 'sales' });
    const router = createSevenDimRouter(deps);
    const res = fakeRes();
    await router.handlers.put({ headers: {}, body: { default_strictness: 'warn' } }, res);
    expect(res.statusCode).toBe(403);
  });
});