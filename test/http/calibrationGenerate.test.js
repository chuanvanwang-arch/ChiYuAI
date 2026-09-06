// test/http/calibrationGenerate.test.js — 处方生成端点（P2 T1）
// 设计依据：docs/2026-08-28-decision-quality-calibration-design.md §7/§8
// 注入式：mock metrics/attribute/replayScenario/savePatches，不连真实 DB
import { describe, it, expect } from 'vitest';
import { createCalibrationRouter } from '../../src/http/calibrationRouter.js';
import express from 'express';

function makeApp({ role = 'sysadmin', decisions = [], metrics = null, att = null } = {}) {
  const app = express();
  app.use(express.json());
  const saved = [];
  const router = createCalibrationRouter({
    resolveMe: async () => ({ ok: true, role, username: 'tester' }),
    loadDecisions: async () => decisions,
    readConf: async () => ({ threshold: 0.8, weights: { similarity: 0.4, coverage: 0.3, method: 0.2, allMet: 0.1 } }),
    computeMetrics: () => metrics || { sample_size: decisions.length, sufficient_sample: decisions.length >= 20 },
    attribute: () => att || { patches: [], guards: [], reason: 'none' },
    replayScenario: (rows, cfg) => ({ autonomy: 0, escalated: rows.length, delta: 0, estimated_override_rate: null, base_autonomy: 0 }),
    listPatches: async ({ status }) => (status ? [] : []),
    savePatches: async (scenario_id, patches) => {
      saved.push({ scenario_id, patches });
      return { created: patches.length, skipped: [] };
    },
    _saved: saved,
  });
  app.use(router);
  return { app, saved };
}

async function call(app, method, path, body = undefined, role = 'sysadmin') {
  // 重新构造：role 通过 makeApp 决定，此处仅透传
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

describe('POST /api/calibration/patches/generate — 权限闸', () => {
  it('非 sysadmin → 403', async () => {
    const { app } = makeApp({ role: 'sales' });
    const r = await call(app, 'POST', '/api/calibration/patches/generate', { scenario_id: 'QUOTE_PRICING' });
    expect(r.status).toBe(403);
  });
});

describe('POST /api/calibration/patches/generate — 守卫出方', () => {
  it('R6 守卫命中 → created=0 + blocked_by=[R6]', async () => {
    const att = {
      patches: [], guards: [{ id: 'R6', reason: '样本不足（3 < 20），不产生处方', evidence: { sample_size: 3 } }],
      reason: '守卫命中（R6）：不出处方。样本不足（3 < 20），不产生处方',
    };
    const { app, saved } = makeApp({ decisions: [{ decision_id: 'd1' }], metrics: { sample_size: 3, sufficient_sample: false }, att });
    const r = await call(app, 'POST', '/api/calibration/patches/generate', { scenario_id: 'QUOTE_PRICING' });
    expect(r.status).toBe(200);
    expect(r.json.created).toBe(0);
    expect(r.json.blocked_by?.[0]?.rule_id).toBe('R6');
    expect(saved.length).toBe(0);
  });

  it('无规则命中 → created=0 + blocked_by=[]（无处方可生成）', async () => {
    const { app, saved } = makeApp({ decisions: Array.from({ length: 25 }, () => ({ decision_id: 'd' })), att: { patches: [], guards: [], reason: 'no hit' } });
    const r = await call(app, 'POST', '/api/calibration/patches/generate', { scenario_id: 'QUOTE_PRICING' });
    expect(r.status).toBe(200);
    expect(r.json.created).toBe(0);
    expect(r.json.blocked_by).toEqual([]);
    expect(saved.length).toBe(0);
  });
});

describe('POST /api/calibration/patches/generate — 出方落库', () => {
  const decisions = Array.from({ length: 25 }, (_, i) => ({ decision_id: `d${i}`, decider_type: 'HUMAN', created_at: new Date().toISOString() }));
  const att = {
    patches: [{
      id: 'R1', knob: 'threshold', delta: { threshold: +0.05 }, risk: 'LOW',
      label: '自主覆写率高且置信度贴阈值 → 阈值上调 0.05', evidence: { autonomy_override_rate: 0.3 },
    }],
    guards: [], reason: '命中规则 R1',
  };

  it('生成阈值处方：from/to 按当前配置推导', async () => {
    const { app, saved } = makeApp({ decisions, att });
    const r = await call(app, 'POST', '/api/calibration/patches/generate', { scenario_id: 'QUOTE_PRICING', window_days: 30 });
    expect(r.status).toBe(200);
    expect(r.json.created).toBe(1);
    expect(saved.length).toBe(1);
    expect(saved[0].scenario_id).toBe('QUOTE_PRICING');
    const p = saved[0].patches[0];
    expect(p.knob).toBe('threshold');
    expect(p.from_value).toEqual({ threshold: 0.8 });
    expect(p.to_value.threshold).toBeCloseTo(0.85, 10);
    expect(p.evidence.rule_id).toBe('R1');
    expect(p.expected_impact.sample_size).toBe(25);
  });

  it('weight 处方：target=method + from/to 定向推导', async () => {
    const attW = {
      patches: [{
        id: 'R4', knob: 'weight', delta: { weights: { method: +0.05 } }, risk: 'MEDIUM',
        label: 'methodScore 敏感性显著 → method 权重 +0.05', evidence: { weight_sensitivity_method: 0.4 },
      }],
      guards: [], reason: '命中规则 R4',
    };
    const { app, saved } = makeApp({ decisions, att: attW });
    const r = await call(app, 'POST', '/api/calibration/patches/generate', { scenario_id: 'QUOTE_PRICING' });
    expect(r.status).toBe(200);
    const p = saved[0].patches[0];
    expect(p.knob).toBe('weight');
    expect(p.target).toBe('method');
    expect(p.from_value).toEqual({ weights: { method: 0.2 } });
    expect(p.to_value).toEqual({ weights: { method: 0.25 } });
  });
});