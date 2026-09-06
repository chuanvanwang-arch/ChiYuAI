// test/http/sevenDimRouter-root-thresholds.test.js — T32 归因阈值配置端点扩展
// 契约：PUT /api/config/seven-dim 支持 { root_cause_thresholds }（default_input_stale_ms + 三开关）；
//   经 validateRootCauseThresholds 校验（未知键忽略、类型校验）；落 config_store['seven-dim'].root_cause_thresholds；
//   GET 返回 root_cause_thresholds（有配置合并返回，无则默认）。全程第0闸（produceDecision）。
import { describe, it, expect } from 'vitest';
import { createSevenDimRouter, DEFAULT_ROOT_CAUSE_THRESHOLDS, validateRootCauseThresholds } from '../../src/http/sevenDimRouter.js';

function makeDeps({ role = 'admin' } = {}) {
  let thresholds = null; // null = 未配置 → 返回默认
  return {
    listScenarios: async () => [{ scenario_id: 'QUOTE_PRICING', stage: '四、商务报价', default_tier: 'HIGH', autonomous_allowed: false, required_dims: [] }],
    readStrictness: async () => 'warn',
    writeStrictness: async () => {},
    readEdgeBindings: async () => null,
    writeEdgeBindings: async () => {},
    readRootCauseThresholds: async () =>
      thresholds ? { ...DEFAULT_ROOT_CAUSE_THRESHOLDS, ...thresholds } : { ...DEFAULT_ROOT_CAUSE_THRESHOLDS },
    writeRootCauseThresholds: async (t) => { thresholds = t; },
    updateScenario: async (id, patch) => ({ ...{ scenario_id: id }, ...patch }),
    produceDecision: async () => ({ decisionId: 'dec-1' }),
    resolveMe: async () => ({ ok: true, role }),
  };
}
function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { res.body = o; return res; };
  return res;
}
const DEFAULTS = DEFAULT_ROOT_CAUSE_THRESHOLDS;

describe('PUT /api/config/seven-dim { root_cause_thresholds }', () => {
  it('合法阈值 → 200 + 落库 + decision + 归一化补缺省', async () => {
    const deps = makeDeps();
    const router = createSevenDimRouter(deps);
    const res = fakeRes();
    await router.handlers.put(
      { headers: {}, body: { root_cause_thresholds: { default_input_stale_ms: 60 * 60 * 1000 } } },
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.root_cause_thresholds.default_input_stale_ms).toBe(3600_000);
    expect(res.body.root_cause_thresholds.field_mismatch_enabled).toBe(true); // 缺省字段补默认
    expect(res.body.decision).toBe('dec-1');
    expect((await deps.readRootCauseThresholds()).default_input_stale_ms).toBe(3600_000);
  });

  it('非法类型（字符串 ms）→ 400', async () => {
    const deps = makeDeps();
    const router = createSevenDimRouter(deps);
    const res = fakeRes();
    await router.handlers.put(
      { headers: {}, body: { root_cause_thresholds: { default_input_stale_ms: '24h' } } },
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/须为 number/);
  });

  it('未知键 → 忽略（归一化仅白名单键），仍 200', async () => {
    const deps = makeDeps();
    const router = createSevenDimRouter(deps);
    const res = fakeRes();
    await router.handlers.put(
      { headers: {}, body: { root_cause_thresholds: { some_unknown: 2, default_input_stale_ms: 1000 } } },
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.root_cause_thresholds).not.toHaveProperty('some_unknown');
    expect(res.body.root_cause_thresholds.default_input_stale_ms).toBe(1000);
  });

  it('非对象 → 400', async () => {
    const deps = makeDeps();
    const router = createSevenDimRouter(deps);
    const res = fakeRes();
    await router.handlers.put({ headers: {}, body: { root_cause_thresholds: 'oops' } }, res);
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/config/seven-dim 含 root_cause_thresholds', () => {
  it('无配置 → 返回默认阈值', async () => {
    const deps = makeDeps();
    const router = createSevenDimRouter(deps);
    const res = fakeRes();
    await router.handlers.get({ headers: {} }, res);
    expect(res.body.root_cause_thresholds.default_input_stale_ms).toBe(24 * 3600 * 1000);
  });

  it('有配置 → 合并返回（保留用户值）', async () => {
    const deps = makeDeps();
    await deps.writeRootCauseThresholds({ default_input_stale_ms: 60_000 });
    const router = createSevenDimRouter(deps);
    const res = fakeRes();
    await router.handlers.get({ headers: {} }, res);
    expect(res.body.root_cause_thresholds.default_input_stale_ms).toBe(60_000);
  });

  it('非 sysadmin → 403', async () => {
    const deps = makeDeps({ role: 'sales' });
    const router = createSevenDimRouter(deps);
    const res = fakeRes();
    await router.handlers.get({ headers: {} }, res);
    expect(res.statusCode).toBe(403);
  });
});

describe('validateRootCauseThresholds 单元', () => {
  it('白名单键归一化 + 缺省补默认', () => {
    const r = validateRootCauseThresholds({ default_input_stale_ms: 1000, input_stale_enabled: false });
    expect(r.ok).toBe(true);
    expect(r.normalized.default_input_stale_ms).toBe(1000);
    expect(r.normalized.input_stale_enabled).toBe(false);
    expect(r.normalized.field_mismatch_enabled).toBe(true);
  });

  it('负数 ms → 不合法', () => {
    const r = validateRootCauseThresholds({ default_input_stale_ms: -1 });
    expect(r.ok).toBe(false);
  });

  it('空对象 → 合法（全默认）', () => {
    const r = validateRootCauseThresholds({});
    expect(r.ok).toBe(true);
    expect(r.normalized.default_input_stale_ms).toBe(DEFAULTS.default_input_stale_ms);
  });
});