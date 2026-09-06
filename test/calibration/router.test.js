// test/calibration/router.test.js — 校准端点测试（注入式，不启动真实 server）
// 设计依据：docs/2026-08-28-decision-quality-calibration-design.md §7/§8
import { describe, it, expect } from 'vitest';
import { createCalibrationRouter } from '../../src/http/calibrationRouter.js';

// 构造注入 deps 的 router 实例（mock 数据层 + 角色解析），用 express 直接消费
import express from 'express';

function makeApp({ role = 'sysadmin', patches = [], decisions = [], approve = null, reject = null, rollback = null } = {}) {
  const app = express();
  app.use(express.json());
  const router = createCalibrationRouter({
    resolveMe: async () => ({ ok: true, role, username: 'tester' }),
    loadDecisions: async () => decisions,
    readConf: async () => ({ threshold: 0.8, weights: { similarity: 0.4, coverage: 0.3, method: 0.2, allMet: 0.1 } }),
    computeMetrics: (rows) => ({ sample_size: rows.length }),
    attribute: () => ({ patches: [], guards: [], reason: 'mock' }),
    replayScenario: (rows, cfg) => ({ autonomy: 1, escalated: 1, delta: 0 }),
    listPatches: async ({ status }) => patches.filter((p) => !status || p.status === status),
    getPatch: async (id) => patches.find((p) => p.patch_id === id) || null,
    approvePatch: async (id, opt) => approve ? approve(id, opt) : ({ patch: { status: 'APPLIED' }, config: {}, decision: 'dec-1' }),
    rejectPatch: async (id, opt) => reject ? reject(id, opt) : ({ status: 'REJECTED' }),
    rollbackPatch: async (id, opt) => rollback ? rollback(id, opt) : ({ patch: { status: 'ROLLED_BACK' }, config: {}, decision: 'dec-2' }),
  });
  app.use(router);
  return app;
}

async function call(app, method, path, body = undefined) {
  const res = await new Promise((resolve) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const opts = { method, headers: {} };
      if (body !== undefined) { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body); }
      fetch(`http://127.0.0.1:${port}${path}`, opts)
        .then(async (r) => resolve({ status: r.status, json: await r.json().catch(() => null) }))
        .finally(() => server.close());
    });
  });
  return res;
}

describe('calibration endpoints — 权限闸', () => {
  it('非 sysadmin → 403', async () => {
    const app = makeApp({ role: 'sales' });
    for (const p of ['/api/calibration/metrics', '/api/calibration/attribution', '/api/calibration/patches', '/api/calibration/replay']) {
      const r = await call(app, 'GET', p);
      expect(r.status).toBe(403);
    }
    const r2 = await call(app, 'POST', '/api/calibration/patches/1/approve');
    expect(r2.status).toBe(403);
  });

  it('sysadmin 可读 metrics/patches/replay', async () => {
    const app = makeApp();
    const m = await call(app, 'GET', '/api/calibration/metrics');
    expect(m.status).toBe(200);
    expect(m.json.metrics.sample_size).toBe(0);
    const p = await call(app, 'GET', '/api/calibration/patches');
    expect(p.status).toBe(200);
    expect(Array.isArray(p.json.patches)).toBe(true);
    const rp = await call(app, 'GET', '/api/calibration/replay');
    expect(rp.status).toBe(200);
    expect(rp.json.replay.autonomy).toBe(1);
  });
});

describe('calibration endpoints — 处方动作', () => {
  it('approve 调起 store.approvePatch（第0闸决策）', async () => {
    let called = null;
    const app = makeApp({ approve: (id, opt) => { called = { id, opt }; return { patch: { status: 'APPLIED' }, config: { threshold: 0.85 }, decision: 'dec-1' }; } });
    const r = await call(app, 'POST', '/api/calibration/patches/abc/approve');
    expect(r.status).toBe(200);
    expect(called).toEqual({ id: 'abc', opt: { resolved_by: 'tester' } });
    expect(r.json.decision).toBe('dec-1');
  });

  it('reject 调起 store.rejectPatch', async () => {
    let called = null;
    const app = makeApp({ reject: (id, opt) => { called = { id, opt }; return { status: 'REJECTED' }; } });
    const r = await call(app, 'POST', '/api/calibration/patches/abc/reject');
    expect(r.status).toBe(200);
    expect(called.id).toBe('abc');
    expect(r.json.patch.status).toBe('REJECTED');
  });

  it('rollback 调起 store.rollbackPatch（恢复原值 + 第0闸）', async () => {
    let called = null;
    const app = makeApp({ rollback: (id, opt) => { called = { id, opt }; return { patch: { status: 'ROLLED_BACK' }, config: { threshold: 0.8 }, decision: 'dec-2' }; } });
    const r = await call(app, 'POST', '/api/calibration/patches/abc/rollback');
    expect(r.status).toBe(200);
    expect(called.id).toBe('abc');
    expect(r.json.config.threshold).toBe(0.8);
  });
});