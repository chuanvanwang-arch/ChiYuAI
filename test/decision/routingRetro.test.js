// test/decision/routingRetro.test.js — 路由实验收口判据（2026-09-05 P1，设计 §6/§7/§10）
//
// 本文件锁三件事：
//   ① 三取二判据（ΔQ/ΔO/ΔR）至少两项显著**且符号一致**才出结论；否则 insufficient（不硬凑）
//   ② 样本不足 → insufficient_evidence，并排**反向臂**补对照（append-only，禁删原行）
//   ③ 结论只出 PENDING 处方（createPatch），**绝不自动写** config_store['context-routing']（红线 §0）
// 零真实 DB：db.js / configStore / routingExperiment / calibration.store / routing 全 mock。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({ query: vi.fn(), queryWrite: vi.fn() }));
const cfgMock = vi.hoisted(() => ({ readConfig: vi.fn() }));
const expMock = vi.hoisted(() => ({ createExperiment: vi.fn() }));
const patchMock = vi.hoisted(() => ({ createPatch: vi.fn() }));
const routingMock = vi.hoisted(() => ({ resolveTracks: vi.fn() }));

vi.mock('../../src/db.js', () => ({
  query: (...a) => dbMock.query(...a),
  queryWrite: (...a) => dbMock.queryWrite(...a),
}));
vi.mock('../../src/config/configStore.js', () => ({ readConfig: (...a) => cfgMock.readConfig(...a) }));
vi.mock('../../src/context/routingExperiment.js', () => ({ createExperiment: (...a) => expMock.createExperiment(...a) }));
vi.mock('../../src/calibration/store.js', () => ({ createPatch: (...a) => patchMock.createPatch(...a) }));
vi.mock('../../src/context/routing.js', async (imp) => {
  const real = await imp();
  return { ...real, resolveTracks: (...a) => routingMock.resolveTracks(...a) };
});

const { judgeArms, aggregateArms, routingReview, DEFAULT_JUDGE_CFG } = await import('../../src/decision/routingReview.js');

const arm = (n, qbar, success_rate, override_rate) => ({ n, qbar, success_rate, override_rate });

beforeEach(() => {
  dbMock.query.mockReset();
  dbMock.queryWrite.mockReset();
  cfgMock.readConfig.mockReset();
  expMock.createExperiment.mockReset();
  patchMock.createPatch.mockReset();
  routingMock.resolveTracks.mockReset();

  cfgMock.readConfig.mockImplementation(async () => ({ value: null })); // 出厂判据
  dbMock.query.mockImplementation(async () => ({ rows: [] }));
  dbMock.queryWrite.mockImplementation(async () => ({ rowCount: 1 }));
  routingMock.resolveTracks.mockImplementation(async () => ({ tracks: ['structured', 'graph_decision'] }));
  expMock.createExperiment.mockImplementation(async () => ({ ok: true, experiment: { experiment_id: 42 } }));
  patchMock.createPatch.mockImplementation(async () => ({ patch_id: 555 }));
});

// ─────────────────── ① 三取二判据 ───────────────────
describe('judgeArms — 三取二，且符号必须一致', () => {
  it('ΔQ↑ + ΔO↑ + 覆写率↓ → prefer_on（三项全中）', () => {
    const j = judgeArms(arm(30, 0.80, 0.60, 0.10), arm(30, 0.70, 0.45, 0.20));
    expect(j.verdict).toBe('prefer_on');
    expect(j.reason).toBe('significant');
    expect(j.hits).toBe(3);
    expect(j.delta.dq).toBeCloseTo(0.10, 6);
  });

  it('ΔQ↓ + ΔO↓ → prefer_off（覆写率未改善也算两项成立）', () => {
    const j = judgeArms(arm(30, 0.70, 0.45, 0.25), arm(30, 0.80, 0.60, 0.20));
    expect(j.verdict).toBe('prefer_off');
    expect(j.hits).toBe(2);
  });

  it('不显著（ΔQ 未过线）→ insufficient/not-significant，不硬凑结论', () => {
    const j = judgeArms(arm(30, 0.71, 0.46, 0.20), arm(30, 0.70, 0.45, 0.20));
    expect(j.verdict).toBe('insufficient');
    expect(j.reason).toBe('not-significant');
    expect(j.hits).toBe(0);
  });

  it('符号打架（ΔQ↑ 但 ΔO↓）→ 判不成立（只认同号证据）', () => {
    const j = judgeArms(arm(30, 0.80, 0.30, 0.30), arm(30, 0.70, 0.45, 0.20));
    expect(j.verdict).toBe('insufficient');
    expect(j.significant.outcome).toBe(false);
    expect(j.hits).toBeLessThan(2);
  });

  it('样本不足（任一组 < min_arm_sample）→ insufficient_evidence', () => {
    const j = judgeArms(arm(30, 0.80, 0.60, 0.10), arm(5, 0.70, 0.45, 0.20));
    expect(j.verdict).toBe('insufficient');
    expect(j.reason).toBe('insufficient_evidence');
    expect(j.samples).toEqual({ on: 30, off: 5, need: DEFAULT_JUDGE_CFG.min_arm_sample });
  });

  it('缺臂 / 无数据 → insufficient（missing-arm / no-data）', () => {
    expect(judgeArms(null, arm(30, 0.7, 0.4, 0.2)).reason).toBe('missing-arm');
    expect(judgeArms(arm(30, 0.7, 0.4, 0.2), null).reason).toBe('missing-arm');
  });

  it('阈值可配（q_eps/o_eps 走 config_store 语义，入参可覆盖）', () => {
    const pair = [arm(30, 0.74, 0.50, 0.20), arm(30, 0.70, 0.45, 0.20)];
    expect(judgeArms(...pair).verdict).toBe('insufficient');        // ΔQ=0.04 < 0.05
    expect(judgeArms(...pair, { q_eps: 0.03, o_eps: 0.04 }).verdict).toBe('prefer_on');
  });
});

// ─────────────────── 聚合（Join 快照 exp_arm 分组） ───────────────────
describe('aggregateArms — 按 exp_arm 分组聚合', () => {
  it('双臂都命中 → 返回 on/off 两组数值', async () => {
    dbMock.query.mockImplementation(async () => ({
      rows: [
        { arm: 'on', n: 30, qbar: '0.80', success_rate: '0.60', override_rate: '0.10' },
        { arm: 'off', n: 28, qbar: '0.70', success_rate: '0.45', override_rate: '0.20' },
      ],
    }));
    const r = await aggregateArms('LEAD_FOLLOW_UP', 'narrative', { tenantId: 'system' });
    expect(r.on).toMatchObject({ n: 30, qbar: 0.8, success_rate: 0.6, override_rate: 0.1 });
    expect(r.off).toMatchObject({ n: 28, qbar: 0.7 });
    const sql = String(dbMock.query.mock.calls[0][0]);
    expect(sql).toContain("s.routing->>'exp_arm'"); // 分组维度来自快照落库的实验臂
  });

  it('查库抛错 → fail-open 返回空双臂（复盘继续，不阻断）', async () => {
    dbMock.query.mockImplementation(async () => { throw new Error('boom'); });
    await expect(aggregateArms('X', 'narrative', {})).resolves.toEqual({ on: null, off: null });
  });
});

// ─────────────────── ② 每日收口 ───────────────────
describe('routingReview — 收口只出处方，绝不自动改配置', () => {
  const dueExp = (over = {}) => ({
    experiment_id: 7, scenario_id: 'LEAD_FOLLOW_UP', track: 'narrative',
    arm: 'on', baseline: 'off', window_start: '2026-09-01', window_end: '2026-09-15', status: 'running', ...over,
  });

  function mockDueAndArms(exp, arms) {
    dbMock.query.mockImplementation(async (sql) => {
      if (/FROM crm.routing_experiment/.test(String(sql))) return { rows: [exp] };
      return { rows: arms };
    });
  }

  it('三取二成立且偏好臂≠配置原值 → 出 routing_tracks PENDING 处方，to_value 是完整 tracks 数组', async () => {
    mockDueAndArms(dueExp(), [
      { arm: 'on', n: 30, qbar: '0.80', success_rate: '0.60', override_rate: '0.10' },
      { arm: 'off', n: 28, qbar: '0.70', success_rate: '0.45', override_rate: '0.20' },
    ]);
    const out = await routingReview({ tenantId: 'system' });

    expect(out.closed).toBe(1);
    expect(patchMock.createPatch).toHaveBeenCalledTimes(1);
    const p = patchMock.createPatch.mock.calls[0][0];
    expect(p.knob).toBe('routing_tracks');
    expect(p.target).toBe('LEAD_FOLLOW_UP');               // 场景键（旋钮策略按 target 定位）
    expect(p.to_value.tracks).toContain('narrative');      // 完整 tracks，不是 {narrative:'on'}
    expect(p.from_value.tracks).toEqual(['structured', 'graph_decision']); // 回滚目标=配置原值
    expect(p.status).toBeUndefined();                      // createPatch 内部固定 PENDING
    // 收口：改 status，不删行
    const upd = String(dbMock.queryWrite.mock.calls[0][0]);
    expect(upd).toContain('UPDATE crm.routing_experiment');
    expect(upd).not.toMatch(/DELETE/i);
  });

  it('偏好臂 == 配置原值 → 不出处方（配置已经是对的，avoid 噪声）', async () => {
    mockDueAndArms(dueExp({ baseline: 'on' }), [
      { arm: 'on', n: 30, qbar: '0.80', success_rate: '0.60', override_rate: '0.10' },
      { arm: 'off', n: 28, qbar: '0.70', success_rate: '0.45', override_rate: '0.20' },
    ]);
    const out = await routingReview({ tenantId: 'system' });
    expect(patchMock.createPatch).not.toHaveBeenCalled();
    expect(out.patches[0]).toMatchObject({ skipped: 'already-aligned' });
  });

  it('证据不足 → 排**反向臂**补对照（append-only 新开一期，不删原行）', async () => {
    mockDueAndArms(dueExp(), [
      { arm: 'on', n: 30, qbar: '0.80', success_rate: '0.60', override_rate: '0.10' },
      { arm: 'off', n: 3, qbar: '0.70', success_rate: '0.45', override_rate: '0.20' },
    ]);
    const out = await routingReview({ tenantId: 'system' });
    expect(patchMock.createPatch).not.toHaveBeenCalled();
    expect(out.insufficient[0].reason).toBe('insufficient_evidence');
    expect(expMock.createExperiment).toHaveBeenCalledTimes(1);
    expect(expMock.createExperiment.mock.calls[0][0]).toMatchObject({ scenarioId: 'LEAD_FOLLOW_UP', arm: 'off', track: 'narrative' });
    expect(out.nextArms[0]).toMatchObject({ arm: 'off', experiment_id: 42 });
  });

  it('dryRun → 零写（不建处方、不排臂、不改 status）', async () => {
    mockDueAndArms(dueExp(), [
      { arm: 'on', n: 30, qbar: '0.80', success_rate: '0.60', override_rate: '0.10' },
      { arm: 'off', n: 28, qbar: '0.70', success_rate: '0.45', override_rate: '0.20' },
    ]);
    const out = await routingReview({ tenantId: 'system', dryRun: true });
    expect(out.patches).toHaveLength(1);
    expect(out.patches[0].dryRun).toBe(true);
    expect(patchMock.createPatch).not.toHaveBeenCalled();
    expect(expMock.createExperiment).not.toHaveBeenCalled();
    expect(dbMock.queryWrite).not.toHaveBeenCalled();
  });

  it('扫库失败 → 返回 errors，不抛（复盘主流程不被拖垮）', async () => {
    dbMock.query.mockImplementation(async () => { throw new Error('table missing'); });
    const out = await routingReview({ tenantId: 'system' });
    expect(out.errors.length).toBe(1);
    expect(out.closed).toBe(0);
  });

  it('③ 红线：全程不存在任何写 context-routing 的调用', async () => {
    mockDueAndArms(dueExp(), [
      { arm: 'on', n: 30, qbar: '0.80', success_rate: '0.60', override_rate: '0.10' },
      { arm: 'off', n: 28, qbar: '0.70', success_rate: '0.45', override_rate: '0.20' },
    ]);
    await routingReview({ tenantId: 'system' });
    const allSql = [...dbMock.query.mock.calls, ...dbMock.queryWrite.mock.calls].map((c) => String(c[0])).join('\n');
    expect(allSql).not.toContain('context-routing');
  });
});
