// test/context/routingExperiment.test.js — 场景路由时间片 A/B 实验（2026-09-05 P1，设计 §5）
//
// 存在理由（设计 §1 缺口 C）：routing 是确定性配置 —— 场景 tracks 不含 narrative 就**永远**不注入，
//   「注入 vs 不注入」的对照组恒空 → 反推在数学上不可能。时间片轮换是唯一能产生反事实样本的方案。
// 本文件锁三件事：
//   ① 实验臂覆盖是纯函数且 fail-open（无实验/参数非法 → 原样）
//   ② **arm 必须反转配置原值**（arm===baseline 拒绝）—— 否则是「假实验」，跑满窗口也产不出对照
//   ③ 建实验必经第0闸 + 守卫（黑名单 / 单场景唯一 / 并发上限）
// 零真实 DB：db.js / configStore / routing / calibration.store 全 mock。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({ query: vi.fn(), queryWrite: vi.fn() }));
const cfgMock = vi.hoisted(() => ({ readConfig: vi.fn() }));
const routingMock = vi.hoisted(() => ({ resolveTracks: vi.fn() }));
const calibMock = vi.hoisted(() => ({ produceDecision: vi.fn() }));

vi.mock('../../src/db.js', () => ({
  query: (...a) => dbMock.query(...a),
  queryWrite: (...a) => dbMock.queryWrite(...a),
}));
vi.mock('../../src/config/configStore.js', () => ({ readConfig: (...a) => cfgMock.readConfig(...a) }));
vi.mock('../../src/context/routing.js', async (imp) => {
  const real = await imp();
  return { ...real, resolveTracks: (...a) => routingMock.resolveTracks(...a) };
});
vi.mock('../../src/calibration/store.js', () => ({ produceDecision: (...a) => calibMock.produceDecision(...a) }));

const {
  applyExperimentArm, resolveActiveArm, createExperiment, closeExperiment,
  readExploreConfig, DEFAULT_EXPLORE_CFG,
} = await import('../../src/context/routingExperiment.js');

beforeEach(() => {
  dbMock.query.mockReset();
  dbMock.queryWrite.mockReset();
  cfgMock.readConfig.mockReset();
  routingMock.resolveTracks.mockReset();
  calibMock.produceDecision.mockReset();

  cfgMock.readConfig.mockImplementation(async () => ({ value: null }));
  dbMock.query.mockImplementation(async (sql) => (/COUNT\(\*\)/.test(String(sql)) ? { rows: [{ n: 0 }] } : { rows: [] }));
  dbMock.queryWrite.mockImplementation(async () => ({ rows: [{ experiment_id: 1 }] }));
  routingMock.resolveTracks.mockImplementation(async () => ({ tracks: ['structured', 'graph_decision'] }));
  calibMock.produceDecision.mockImplementation(async () => ({ decisionId: 9001 }));
});

// ─────────────────── ① 实验臂覆盖（纯函数 + fail-open） ───────────────────
describe('applyExperimentArm — 运行时覆盖，绝不写配置', () => {
  it("arm='on' → 并集（给原本没有叙事的场景补上叙事）", () => {
    expect(applyExperimentArm(['structured'], { track: 'narrative', arm: 'on' }))
      .toEqual(['structured', 'narrative']);
  });

  it("arm='off' → 差集（给原本有叙事的场景摘掉叙事，造对照臂）", () => {
    expect(applyExperimentArm(['narrative', 'structured'], { track: 'narrative', arm: 'off' }))
      .toEqual(['structured']);
  });

  it('幂等：on 已有该 track / off 无该 track → 集合不变', () => {
    expect(applyExperimentArm(['narrative'], { track: 'narrative', arm: 'on' })).toEqual(['narrative']);
    expect(applyExperimentArm(['structured'], { track: 'narrative', arm: 'off' })).toEqual(['structured']);
  });

  it('fail-open：无实验 / 参数非法 → 原样返回（绝不阻断装配）', () => {
    expect(applyExperimentArm(['narrative'], null)).toEqual(['narrative']);
    expect(applyExperimentArm(['narrative'], { track: null, arm: 'on' })).toEqual(['narrative']);
    expect(applyExperimentArm(['narrative'], { track: 'narrative', arm: 'weird' })).toEqual(['narrative']);
  });

  it('tracks 非数组 → 退化空集再按臂处理（不抛错，装配不因脏数据中断）', () => {
    expect(applyExperimentArm(null, { track: 'narrative', arm: 'on' })).toEqual(['narrative']);
    expect(applyExperimentArm(undefined, { track: 'narrative', arm: 'off' })).toEqual([]);
  });
});

// ─────────────────── resolveActiveArm：读失败 fail-open ───────────────────
describe('resolveActiveArm — 读失败按配置原样（fail-open）', () => {
  it('命中窗口内 running 实验 → 返回该行', async () => {
    dbMock.query.mockImplementation(async () => ({ rows: [{ experiment_id: 7, arm: 'on', track: 'narrative' }] }));
    const r = await resolveActiveArm('LEAD_FOLLOW_UP', { tenantId: 'system' });
    expect(r?.experiment_id).toBe(7);
  });

  it('场景为空 → 直接 null（不查库）', async () => {
    expect(await resolveActiveArm(null, {})).toBe(null);
    expect(dbMock.query).not.toHaveBeenCalled();
  });

  it('查库抛错 → null（装配继续，不阻断）；留痕由 emit 承担', async () => {
    dbMock.query.mockImplementation(async () => { throw new Error('relation missing'); });
    await expect(resolveActiveArm('LEAD_FOLLOW_UP', {})).resolves.toBe(null);
  });
});

// ─────────────────── ② 建实验：guard + 第0闸 ───────────────────
describe('createExperiment — 守卫与第0闸', () => {
  it('正常路径：baseline=off + arm=on → 落库 running，带 decision_id', async () => {
    routingMock.resolveTracks.mockImplementation(async () => ({ tracks: ['structured'] }));
    const r = await createExperiment({ scenarioId: 'LEAD_FOLLOW_UP', arm: 'on', createdBy: 'admin' });
    expect(r.ok).toBe(true);
    const sql = String(dbMock.queryWrite.mock.calls[0][0]);
    const args = dbMock.queryWrite.mock.calls[0][1];
    expect(sql).toContain('INSERT INTO crm.routing_experiment');
    expect(args).toMatchObject({ 0: 'system', 1: 'LEAD_FOLLOW_UP', 2: 'narrative', 3: 'on', 4: 'off' });
    expect(args[6]).toBe(9001); // 第0闸决策凭证
    expect(args[7]).toBe('admin');
  });

  it('② 核心守卫：arm 与配置原值相同 → 拒绝（无对照价值的假实验）', async () => {
    routingMock.resolveTracks.mockImplementation(async () => ({ tracks: ['narrative'] }));
    const r = await createExperiment({ scenarioId: 'LEAD_FOLLOW_UP', arm: 'on' });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('无对照价值');
    expect(dbMock.queryWrite).not.toHaveBeenCalled();
  });

  it('守卫 1：黑名单场景（QUOTE_PRICING/SIGN_RISK）默认不实验', async () => {
    const r = await createExperiment({ scenarioId: 'QUOTE_PRICING', arm: 'on' });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('黑名单');
    expect(dbMock.queryWrite).not.toHaveBeenCalled();
  });

  it('守卫 2：同场景已有进行中实验 → 拒绝（防多臂互相污染）', async () => {
    dbMock.query.mockImplementation(async (sql) => {
      if (/COUNT\(\*\)/.test(String(sql))) return { rows: [{ n: 0 }] };
      return { rows: [{ experiment_id: 3 }] }; // dup 命中
    });
    const r = await createExperiment({ scenarioId: 'LEAD_FOLLOW_UP', arm: 'on' });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('已有进行中实验');
  });

  it('守卫 3：全局 running 达上限 → 拒绝', async () => {
    dbMock.query.mockImplementation(async (sql) => (/COUNT\(\*\)/.test(String(sql)) ? { rows: [{ n: 2 }] } : { rows: [] }));
    const r = await createExperiment({ scenarioId: 'LEAD_FOLLOW_UP', arm: 'on' });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('上限');
  });

  it('第0闸：produceDecision 失败 → 拒绝建实验（无决策产证不许做实验）', async () => {
    routingMock.resolveTracks.mockImplementation(async () => ({ tracks: ['structured'] }));
    calibMock.produceDecision.mockImplementation(async () => { throw new Error('decision-fail'); });
    const r = await createExperiment({ scenarioId: 'LEAD_FOLLOW_UP', arm: 'on' });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('第0闸');
    expect(dbMock.queryWrite).not.toHaveBeenCalled();
  });

  it('参数校验：缺 scenario_id / 非法 arm → 拒绝', async () => {
    expect((await createExperiment({ arm: 'on' })).reason).toContain('scenario_id');
    expect((await createExperiment({ scenarioId: 'X', arm: 'maybe' })).reason).toContain('arm');
  });
});

// ─────────────────── 收口：禁 DELETE，只改 status ───────────────────
describe('closeExperiment — append-only 收口', () => {
  it("status='done' → UPDATE（不删行）", async () => {
    const r = await closeExperiment(11, 'done');
    expect(r.ok).toBe(true);
    const sql = String(dbMock.queryWrite.mock.calls[0][0]);
    expect(sql).toContain('UPDATE crm.routing_experiment');
    expect(sql).not.toMatch(/DELETE/i);
  });

  it('非法 status → 拒绝', async () => {
    expect((await closeExperiment(11, 'deleted')).ok).toBe(false);
    expect(dbMock.queryWrite).not.toHaveBeenCalled();
  });
});

// ─────────────────── 阈值配置化 ───────────────────
describe('readExploreConfig — 出厂兜底 + 可覆盖', () => {
  it('无配置 → 出厂兜底', async () => {
    const c = await readExploreConfig({ tenantId: 'system' });
    expect(c).toEqual(DEFAULT_EXPLORE_CFG);
  });

  it('配置可覆盖且非法值回落兜底', async () => {
    cfgMock.readConfig.mockImplementation(async () => ({ value: { window_days: 7, max_running: -1 } }));
    const c = await readExploreConfig({ tenantId: 'system' });
    expect(c.window_days).toBe(7);
    expect(c.max_running).toBe(DEFAULT_EXPLORE_CFG.max_running); // -1 非法 → 兜底
  });
});
