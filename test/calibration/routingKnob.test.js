// test/calibration/routingKnob.test.js — 场景路由旋钮策略（2026-09-05 P1-5，设计 §8）
//
// 契约（红线 §0）：这三个旋钮是**唯一**能把自适应回路的结论写进 context-routing 的通道，
//   且只在人工批准处方时被调用（approvePatch 事务内）。故护栏必须锁死：
//   ① 落点正确（scene_matrix[场景].tracks / dims[].weight / thresholds.{graph,story}）
//   ② 护栏有效（轨道白名单 / 权重单步 ≤0.05 + 归一化 / 阈值最小间隔 / 冷却期）
//   ③ 回滚豁免步进与冷却（回滚是恢复已知安全态，不是"再调一次"）
//   ④ 未知键透传，禁整键覆盖
// 零真实 DB：db.js / configStore mock；client 用假对象捕获事务内写。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({ query: vi.fn() }));
const cfgMock = vi.hoisted(() => ({ readConfig: vi.fn() }));

vi.mock('../../src/db.js', () => ({ query: (...a) => dbMock.query(...a), queryWrite: vi.fn() }));
vi.mock('../../src/config/configStore.js', () => ({ readConfig: (...a) => cfgMock.readConfig(...a) }));

const { getStrategy } = await import('../../src/calibration/knobs/index.js');
const { normalizeDims, diffModes, DEFAULT_CALIB_CFG } = await import('../../src/calibration/knobs/routingStrategy.js');
const { DEFAULT_DIMS, DEFAULT_THRESHOLDS, DEFAULT_SCENE_MATRIX } = await import('../../src/context/routing.js');

let routingValue = null;      // config_store['context-routing'] 当前值（null = 未配置，走出厂兜底）
let cooldownRows = [];        // 冷却查询返回（非空 = 冷却中）

function fakeClient() {
  const calls = [];
  const client = {
    query: vi.fn(async (sql, params) => {
      calls.push({ sql: String(sql), params });
      if (/FROM crm.calibration_patch/.test(String(sql))) return { rows: cooldownRows };
      return { rows: [] };
    }),
    calls,
    // 取出本次事务写回的 routing 配置（INSERT ... config_store 的 $3）
    written() {
      const ins = calls.filter((c) => c.sql.includes('INSERT INTO crm.config_store'));
      if (!ins.length) return null;
      const a = ins[ins.length - 1].params;
      return { tenantId: a[0], key: a[1], value: JSON.parse(a[2]), decisionId: a[3] };
    },
  };
  return client;
}

beforeEach(() => {
  dbMock.query.mockReset();
  cfgMock.readConfig.mockReset();
  routingValue = null;
  cooldownRows = [];
  dbMock.query.mockImplementation(async () => ({ rows: [] }));
  cfgMock.readConfig.mockImplementation(async (key) => {
    if (key === 'context-routing') return { value: routingValue };
    return { value: null }; // routing-calibration 未配置 → 出厂兜底
  });
});

// ─────────────────── 注册 ───────────────────
describe('路由旋钮策略注册', () => {
  it('三个 knob 均可解析且接口完整', () => {
    for (const k of ['routing_tracks', 'routing_weight', 'routing_threshold']) {
      const s = getStrategy(k);
      expect(s, `getStrategy('${k}') 不应为 null`).toBeTruthy();
      for (const m of ['readCurrent', 'apply', 'replayImpact', 'riskLevel']) expect(typeof s[m]).toBe('function');
    }
  });

  it('风险分级：轨道 MEDIUM，权重/阈值 HIGH', () => {
    expect(getStrategy('routing_tracks').riskLevel()).toBe('MEDIUM');
    expect(getStrategy('routing_weight').riskLevel()).toBe('HIGH');
    expect(getStrategy('routing_threshold').riskLevel()).toBe('HIGH');
  });
});

// ─────────────────── 纯函数：权重归一化 ───────────────────
describe('normalizeDims — 改一个维，其余按比例缩放，总和恒为 1', () => {
  it('goal 0.4→0.45，其余按原比例分担 0.55', () => {
    const out = normalizeDims(DEFAULT_DIMS, 'goal', 0.45);
    const sum = out.reduce((s, d) => s + d.weight, 0);
    expect(out.find((d) => d.id === 'goal').weight).toBe(0.45);
    expect(out.find((d) => d.id === 'event_mix').weight).toBeCloseTo(0.275, 6);
    expect(out.find((d) => d.id === 'time_sensitivity').weight).toBeCloseTo(0.275, 6);
    expect(sum).toBeCloseTo(1, 6);
  });

  it('其余维全为 0 → 均分，不产生除零/权重回不来的死局', () => {
    const dims = DEFAULT_DIMS.map((d) => ({ ...d, weight: 0 }));
    const out = normalizeDims(dims, 'goal', 0.4);
    expect(out.find((d) => d.id === 'goal').weight).toBe(0.4);
    expect(out.find((d) => d.id === 'event_mix').weight).toBeCloseTo(0.3, 6);
    expect(out.reduce((s, d) => s + d.weight, 0)).toBeCloseTo(1, 6);
  });

  it('未知道路维度 → 抛错（新增维度属元模型变更，走 ATTR_SCHEMA_CHANGE）', () => {
    expect(() => normalizeDims(DEFAULT_DIMS, 'nope', 0.5)).toThrow(/未知道路维度/);
  });

  it('越界值被夹到 [0,1]（0/1 边界不产生负权重）', () => {
    const out = normalizeDims(DEFAULT_DIMS, 'goal', 5);
    expect(out.find((d) => d.id === 'goal').weight).toBe(1);
    expect(out.reduce((s, d) => s + d.weight, 0)).toBeCloseTo(1, 6);
  });
});

// ─────────────────── 纯函数：影子重放（分型迁移） ───────────────────
describe('diffModes — 批准前确定性影响面', () => {
  const cfg = (thresholds) => ({ dims: DEFAULT_DIMS, scene_matrix: DEFAULT_SCENE_MATRIX, thresholds });

  it('配置不变 → 零翻转', () => {
    expect(diffModes(cfg(DEFAULT_THRESHOLDS), cfg(DEFAULT_THRESHOLDS)).changed).toHaveLength(0);
  });

  it('阈值收紧到 {graph:0,story:0} → 所有场景落 GRAPH_PRIMARY，changed 全为该方向', () => {
    const d = diffModes(cfg(DEFAULT_THRESHOLDS), cfg({ graph: 0, story: 0 }));
    expect(d.total).toBe(Object.keys(DEFAULT_SCENE_MATRIX).length);
    expect(d.changed.length).toBeGreaterThan(0);
    for (const c of d.changed) expect(c.to).toBe('GRAPH_PRIMARY');
  });
});

// ─────────────────── routing_tracks ───────────────────
describe('RoutingTracksStrategy', () => {
  const s = () => getStrategy('routing_tracks');

  it('readCurrent 读该场景当前 tracks', async () => {
    routingValue = { scene_matrix: { LEAD_FOLLOW_UP: { tracks: ['narrative'] } } };
    await expect(s().readCurrent({ target: 'LEAD_FOLLOW_UP', tenantId: 'system' }))
      .resolves.toMatchObject({ tracks: ['narrative'] });
  });

  it('apply 落 scene_matrix[场景].tracks，且第0闸 decision_id 随行', async () => {
    const c = fakeClient();
    await s().apply(c, { tracks: ['narrative', 'structured', 'graph_decision'] }, {
      target: 'LEAD_FOLLOW_UP', tenantId: 'system', decisionId: 9001, patchId: 1,
    });
    const w = c.written();
    expect(w.key).toBe('context-routing');
    expect(w.decisionId).toBe(9001);
    expect(w.value.scene_matrix.LEAD_FOLLOW_UP.tracks).toEqual(['narrative', 'structured', 'graph_decision']);
  });

  it('护栏：未知轨道 → 拒绝（防写坏装配面）', async () => {
    const c = fakeClient();
    await expect(s().apply(c, { tracks: ['narrative', 'hallucinated'] }, { target: 'X', tenantId: 'system' }))
      .rejects.toThrow(/未知轨道/);
    expect(c.written()).toBe(null);
  });

  it('护栏：空数组 / 缺 target → 拒绝', async () => {
    const c = fakeClient();
    await expect(s().apply(c, { tracks: [] }, { target: 'X', tenantId: 'system' })).rejects.toThrow(/非空数组/);
    await expect(s().apply(c, { tracks: ['structured'] }, { tenantId: 'system' })).rejects.toThrow(/target/);
  });

  it('④ 未知键透传（禁整键覆盖）', async () => {
    routingValue = { scene_matrix: {}, thresholds: { graph: 0.6, story: 0.4 }, custom_flag: 'keep-me' };
    const c = fakeClient();
    await s().apply(c, { tracks: ['structured'] }, { target: 'LEAD_FOLLOW_UP', tenantId: 'system' });
    expect(c.written().value.custom_flag).toBe('keep-me');
  });

  it('replayImpact 给出 added/removed 差异', async () => {
    const r = await s().replayImpact({ target: 'LEAD_FOLLOW_UP', tenantId: 'system' }, { tracks: ['structured'] });
    expect(r.removed).toContain('narrative'); // 出厂 LEAD_FOLLOW_UP = ['narrative','structured']
    expect(r.added).toEqual([]);
  });
});

// ─────────────────── routing_weight ───────────────────
describe('RoutingWeightStrategy', () => {
  const s = () => getStrategy('routing_weight');

  it('readCurrent 读该维权重', async () => {
    await expect(s().readCurrent({ target: 'goal', tenantId: 'system' })).resolves.toMatchObject({ weight: 0.4 });
  });

  it('apply 单步 ≤0.05 通过，且写回后整体归一化为 1', async () => {
    const c = fakeClient();
    await s().apply(c, { weight: 0.45 }, { target: 'goal', tenantId: 'system', decisionId: 1, patchId: 1 });
    const dims = c.written().value.dims;
    expect(dims.find((d) => d.id === 'goal').weight).toBe(0.45);
    expect(dims.reduce((x, d) => x + d.weight, 0)).toBeCloseTo(1, 6);
  });

  it('护栏：单步 >0.05 拒绝（分多次小步走，每步都要有证据）', async () => {
    const c = fakeClient();
    await expect(s().apply(c, { weight: 0.6 }, { target: 'goal', tenantId: 'system', patchId: 1 }))
      .rejects.toThrow(new RegExp(`超过上限 ${DEFAULT_CALIB_CFG.weight_step_max}`));
    expect(c.written()).toBe(null);
  });

  it('护栏：冷却期内已有生效处方 → 拒绝', async () => {
    cooldownRows = [{ patch_id: 3, resolved_at: '2026-09-01' }];
    const c = fakeClient();
    await expect(s().apply(c, { weight: 0.45 }, { target: 'goal', tenantId: 'system', patchId: 9 }))
      .rejects.toThrow(/冷却期内/);
    expect(c.written()).toBe(null);
  });

  it('③ 回滚豁免步进与冷却（恢复已知安全态不该被小步规则卡住）', async () => {
    cooldownRows = [{ patch_id: 3 }];
    routingValue = { dims: DEFAULT_DIMS.map((d) => (d.id === 'goal' ? { ...d, weight: 0.6 } : d)) };
    const c = fakeClient();
    await s().apply(c, { weight: 0.4 }, { target: 'goal', tenantId: 'system', patchId: 9, rollback: true });
    expect(c.written().value.dims.find((d) => d.id === 'goal').weight).toBe(0.4);
  });

  it('护栏：未知道路维度 → 拒绝（属元模型变更）', async () => {
    const c = fakeClient();
    await expect(s().apply(c, { weight: 0.4 }, { target: 'new_dim', tenantId: 'system' })).rejects.toThrow(/未知道路维度/);
  });

  it('replayImpact 输出归一化后全维 + 分型翻转面', async () => {
    const r = await s().replayImpact({ target: 'goal', tenantId: 'system' }, { weight: 0.45 });
    expect(r.normalized_dims).toHaveLength(DEFAULT_DIMS.length);
    expect(typeof r.total).toBe('number');
    expect(Array.isArray(r.changed)).toBe(true);
  });
});

// ─────────────────── routing_threshold ───────────────────
describe('RoutingThresholdStrategy', () => {
  const s = () => getStrategy('routing_threshold');

  it('readCurrent 读双阈值', async () => {
    await expect(s().readCurrent({ tenantId: 'system' })).resolves.toEqual({ thresholds: { graph: 0.6, story: 0.4 } });
  });

  it('apply 落 thresholds[target]', async () => {
    const c = fakeClient();
    await s().apply(c, { graph: 0.55 }, { target: 'graph', tenantId: 'system', decisionId: 2, patchId: 1 });
    expect(c.written().value.thresholds).toEqual({ graph: 0.55, story: 0.4 });
  });

  it('护栏：graph - story < 最小间隔 → 拒绝（双阈值交叉会导致分型塌陷）', async () => {
    const c = fakeClient();
    await expect(s().apply(c, { graph: 0.42 }, { target: 'graph', tenantId: 'system', patchId: 1 }))
      .rejects.toThrow(/最小间隔/);
    expect(c.written()).toBe(null);
  });

  it('护栏：target 非 graph|story / 值越界 → 拒绝', async () => {
    const c = fakeClient();
    await expect(s().apply(c, 0.5, { target: 'middle', tenantId: 'system' })).rejects.toThrow(/graph\|story/);
    await expect(s().apply(c, 1.5, { target: 'graph', tenantId: 'system' })).rejects.toThrow(/\[0,1\]/);
  });

  it('冷却期内 → 拒绝', async () => {
    cooldownRows = [{ patch_id: 4 }];
    const c = fakeClient();
    await expect(s().apply(c, { graph: 0.55 }, { target: 'graph', tenantId: 'system', patchId: 9 })).rejects.toThrow(/冷却期内/);
  });
});
