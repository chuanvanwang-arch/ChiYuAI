// test/http/sevenDimRouter-edge-bindings.test.js — T32 边绑定配置端点扩展
// 契约：PUT /api/config/seven-dim 支持 { edge_bindings }（E1-E7 × 维度 × direction）；
//   经 validateEdgeDimensionSpec 校验；落 config_store['seven-dim'].edge_bindings；
//   GET 返回 edge_bindings（有配置则配置，无则默认 spec）。全程第0闸（produceDecision）。
import { describe, it, expect, beforeEach } from 'vitest';
import { createSevenDimRouter } from '../../src/http/sevenDimRouter.js';
import { DEFAULT_EDGE_DIMENSION_SPEC, validateEdgeDimensionSpec } from '../../src/decision/edgeDimensionSpec.js';

function makeDeps({ role = 'admin' } = {}) {
  let bindings = null; // null = 未配置 → 返回默认 spec
  let strict = 'warn';
  return {
    listScenarios: async () => [{ scenario_id: 'QUOTE_PRICING', stage: '四、商务报价', default_tier: 'HIGH', autonomous_allowed: false, required_dims: [] }],
    readStrictness: async () => strict,
    writeStrictness: async (v) => { strict = v; },
    readEdgeBindings: async () => bindings,
    writeEdgeBindings: async (b) => { bindings = b; },
    updateScenario: async (id, patch) => ({ ...{ scenario_id: id }, ...patch }),
    produceDecision: async () => ({ decisionId: 'dec-7' }),
    resolveMe: async () => ({ ok: true, role }),
  };
}
function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { res.body = o; return res; };
  return res;
}
const FULL_SPEC = DEFAULT_EDGE_DIMENSION_SPEC;

beforeEach(() => {});

describe('PUT /api/config/seven-dim { edge_bindings }', () => {
  it('合法完整 spec → 200 + 落库 + decision', async () => {
    const deps = makeDeps();
    const router = createSevenDimRouter(deps);
    const res = fakeRes();
    await router.handlers.put(
      { headers: {}, body: { edge_bindings: FULL_SPEC } },
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.edge_bindings).toHaveLength(7);
    expect(res.body.decision).toBe('dec-7');
    expect(await deps.readEdgeBindings()).toEqual(FULL_SPEC);
  });

  it('缺少 7 边之一 → 400（validateEdgeDimensionSpec 拦截）', async () => {
    const deps = makeDeps();
    const router = createSevenDimRouter(deps);
    const res = fakeRes();
    const bad = FULL_SPEC.filter((r) => r.edge_type !== 'INFLUENCED'); // 缺 1 边
    await router.handlers.put({ headers: {}, body: { edge_bindings: bad } }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/INFLUENCED|边缺失/);
  });

  it('非法 edge_type → 400', async () => {
    const deps = makeDeps();
    const router = createSevenDimRouter(deps);
    const res = fakeRes();
    const bad = [...FULL_SPEC.slice(0, 6), { edge_type: 'NOT_A_REAL_EDGE', serves_dimension: ['identity'], direction: 'x' }];
    await router.handlers.put({ headers: {}, body: { edge_bindings: bad } }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/悬空边|NOT_A_REAL_EDGE/);
  });

  it('与 default_strictness 同批提交（兼容既有形态）', async () => {
    const deps = makeDeps();
    const router = createSevenDimRouter(deps);
    const res = fakeRes();
    await router.handlers.put(
      { headers: {}, body: { edge_bindings: FULL_SPEC, default_strictness: 'block' } },
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.edge_bindings).toHaveLength(7);
  });
});

describe('GET /api/config/seven-dim 含 edge_bindings', () => {
  it('无配置 → 默认 spec', async () => {
    const deps = makeDeps();
    const router = createSevenDimRouter(deps);
    const res = fakeRes();
    await router.handlers.get({ headers: {} }, res);
    expect(res.body.edge_bindings).toHaveLength(7);
    expect(res.body.edge_bindings[0].edge_type).toBe('DECIDED_ON');
  });

  it('有配置 → 返回配置', async () => {
    const deps = makeDeps();
    await deps.writeEdgeBindings(FULL_SPEC);
    const router = createSevenDimRouter(deps);
    const res = fakeRes();
    await router.handlers.get({ headers: {} }, res);
    expect(res.body.edge_bindings).toHaveLength(7);
  });

  it('非 sysadmin → 403', async () => {
    const deps = makeDeps({ role: 'sales' });
    const router = createSevenDimRouter(deps);
    const res = fakeRes();
    await router.handlers.get({ headers: {} }, res);
    expect(res.statusCode).toBe(403);
  });
});