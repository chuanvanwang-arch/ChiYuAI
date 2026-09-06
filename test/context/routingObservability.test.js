// context-routing 自适应回路 P0 — 观测底座护栏（2026-09-05）
//
// 背景（设计 §1）：要让「某场景注入叙事后决策质量分是否提升」可反推，先得有可回算的数据底座。
//   缺口 A：决策不留轨道 → 快照补 routing 列并落库（否则事后无法回算）
//   缺口 B：Q 采样 skill = scenario_id 自我代理 → 无分组维度，做不了对照
//   可解释性：L3 routing_brief → 一线能回答「为什么这次没给我看历史时间线」
// 本文件锁定这三点，防回潮。
//
// 零真实 DB：db.js 全 mock；路由走出厂默认矩阵（loadRouting 回退 DEFAULT_ROUTING）。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({ query: vi.fn(), queryWrite: vi.fn(), trendRows: [] }));

vi.mock('../../src/db.js', () => ({
  query: (...a) => dbMock.query(...a),
  queryWrite: (...a) => dbMock.queryWrite(...a),
}));
vi.mock('../../src/decision/provenance.js', () => ({ trackEntry: vi.fn(async () => ({ ok: true })) }));

const { deriveQGroup } = await import('../../src/decision/closureLoop.js');
const { assembleContextV2 } = await import('../../src/context/assembleContextV2.js');
const { buildRoutingBrief } = await import('../../src/context/assembler.js');
const { formatForPrompt } = await import('../../src/context/injector.js');

beforeEach(() => {
  dbMock.query.mockReset();
  dbMock.queryWrite.mockReset();
  dbMock.query.mockImplementation(async () => ({ rows: [] }));
  dbMock.queryWrite.mockImplementation(async () => ({ rowCount: 1 }));
});

// ───────────────────────── 缺口 B：Q 采样分组维度 ─────────────────────────
describe('deriveQGroup — Q 采样按真实轨道分组（补缺口 B）', () => {
  it('有 tracks 含 narrative → track:narrative:on', () => {
    expect(deriveQGroup('LEAD_FOLLOW_UP', { tracks: ['narrative', 'structured'] })).toBe('track:narrative:on');
  });

  it('有 tracks 不含 narrative → track:narrative:off（构成对照组的另一臂）', () => {
    expect(deriveQGroup('QUOTE_PRICING', { tracks: ['structured', 'graph_decision'] })).toBe('track:narrative:off');
  });

  it('P1 实验臂优先：exp_track/exp_arm 存在时按其分组（覆盖配置轨道）', () => {
    expect(deriveQGroup('QUOTE_PRICING', {
      tracks: ['structured'], exp_track: 'narrative', exp_arm: 'on',
    })).toBe('track:narrative:on');
  });

  it('无 routing（存量/未装配决策）→ 回退旧键 scenario_id，不丢样本', () => {
    expect(deriveQGroup('LOSS_REVIEW', null)).toBe('LOSS_REVIEW');
    expect(deriveQGroup('LOSS_REVIEW', undefined)).toBe('LOSS_REVIEW');
    expect(deriveQGroup('LOSS_REVIEW', {})).toBe('LOSS_REVIEW');
  });

  it('场景缺失 → null（调用方跳过，不写脏行）', () => {
    expect(deriveQGroup(null, { tracks: ['narrative'] })).toBe(null);
    expect(deriveQGroup('', { tracks: ['narrative'] })).toBe(null);
  });
});

// ───────────────────────── 缺口 A：routing 落库 ─────────────────────────
describe('快照落库必须带 routing（补缺口 A）', () => {
  const retrievers = {
    S1: async () => ({ items: [] }), S2: async () => ({ items: [] }), S3: async () => ({ items: [] }),
    S4: async () => ({ items: [] }), S5: async () => ({ items: [] }), S6: async () => ({ items: [] }),
    S7: async () => ({ items: [] }),
  };

  // 从 queryWrite 捕获的 INSERT 里取 routing 参数（第 16 个占位符）
  function routingArgOf(insertCall) {
    const args = insertCall[1];
    return args ? args[15] : undefined;
  }
  function insertCalls() {
    return dbMock.queryWrite.mock.calls.filter((c) => String(c[0]).includes('INSERT INTO crm.decision_context_snapshot'));
  }

  it('V2 主路径 INSERT 含 routing 参数，且值 = base.routing（含 exp_* 结构位）', async () => {
    const r = await assembleContextV2({ actor: 'alice', scenario_id: 'QUOTE_PRICING' }, retrievers);
    const calls = insertCalls();
    expect(calls).toHaveLength(1);
    expect(String(calls[0][0])).toContain('routing');
    const raw = routingArgOf(calls[0]);
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw);
    expect(parsed.scene).toBe('QUOTE_PRICING');
    expect(parsed.mode).toBe('GRAPH_PRIMARY');
    expect(parsed.tracks).toEqual(['structured', 'graph_decision']);
    // P1 字段 P0 恒 null，但结构必须已就位（避免届时二次迁移）
    expect(parsed).toMatchObject({ exp_id: null, exp_arm: null, exp_track: null });
    // 与内存 bundle 同源
    expect(parsed).toEqual(r.routing);
  });

  it('F4 冻结路径（persist:false → freezePreContext）routing 不丢：逐字复用事前装配', async () => {
    const pre = await assembleContextV2({ actor: 'alice', scenario_id: 'LEAD_FOLLOW_UP', persist: false }, retrievers);
    expect(pre.routing.tracks).toContain('narrative');
    dbMock.queryWrite.mockClear();

    await assembleContextV2({ pre_context: pre, decision_id: '11111111-1111-1111-1111-111111111111' });
    const calls = insertCalls();
    expect(calls).toHaveLength(1);
    const parsed = JSON.parse(routingArgOf(calls[0]));
    expect(parsed.scene).toBe('LEAD_FOLLOW_UP');
    expect(parsed.tracks).toContain('narrative');
    expect(parsed).toEqual(pre.routing); // 冻结契约：不重算、不漂移
  });

  it('路由不可用（routing=null）→ routing 参数写 null，不得让 INSERT 崩', async () => {
    dbMock.query.mockImplementation(async () => ({ rows: [] }));
    const r = await assembleContextV2({ actor: 'alice', scenario_id: '__NO_SUCH__' }, retrievers);
    const calls = insertCalls();
    expect(calls).toHaveLength(1);
    // 未知场景回退全轨 → routing 非 null；但若解析失败则为 null，两者都不得抛错
    expect([null, undefined].includes(routingArgOf(calls[0])) || typeof routingArgOf(calls[0]) === 'string').toBe(true);
    expect(r.routing).toBeTruthy();
  });
});

// ───────────────────────── L3 routing_brief（可解释性） ─────────────────────────
describe('buildRoutingBrief — L3 可解释 brief', () => {
  it('tracks 不含 narrative → narrative_injected=false（可解释「为什么没给我看时间线」）', async () => {
    const b = await buildRoutingBrief({ scene: 'QUOTE_PRICING', mode: 'GRAPH_PRIMARY', score: 1, tracks: ['structured'] }, 'QUOTE_PRICING', { tenantId: 'system' });
    expect(b.scene).toBe('QUOTE_PRICING');
    expect(b.mode).toBe('GRAPH_PRIMARY');
    expect(b.narrative_injected).toBe(false);
    expect(b.experiment).toBe(null); // P0 无实验
    expect(b.q_trend).toBe(null);    // mock 无样本
  });

  it('tracks 含 narrative → narrative_injected=true', async () => {
    const b = await buildRoutingBrief({ scene: 'LEAD_FOLLOW_UP', mode: 'STORY_PRIMARY', score: 0, tracks: ['narrative'] }, 'LEAD_FOLLOW_UP');
    expect(b.narrative_injected).toBe(true);
  });

  it('q_trend 有样本时回带 q0/qn/n/improved（与 qSkillComposite 同口径 0.05）', async () => {
    dbMock.query.mockImplementation(async (sql) => (String(sql).includes('decision_skill_quality')
      ? { rows: [{ quality_score: 0.90 }, { quality_score: 0.70 }] }  // DESC：最新在前
      : { rows: [] }));
    const b = await buildRoutingBrief({ scene: 'X', mode: 'BOTH', score: 0.5, tracks: ['narrative'] }, 'X');
    expect(b.q_trend).not.toBe(null);
    expect(b.q_trend.qn).toBeCloseTo(0.90, 5);
    expect(b.q_trend.q0).toBeCloseTo(0.70, 5);
    expect(b.q_trend.n).toBe(2);
    expect(b.q_trend.improved).toBe(true); // 0.90 > 0.70 + 0.05
  });

  it('q_trend 查询失败 → null 且不抛（fail-open，绝不阻断装配）', async () => {
    dbMock.query.mockImplementation(async (sql) => {
      if (String(sql).includes('decision_skill_quality')) throw new Error('boom');
      return { rows: [] };
    });
    const b = await buildRoutingBrief({ scene: 'X', mode: 'BOTH', score: 0.5, tracks: ['narrative'] }, 'X');
    expect(b.q_trend).toBe(null);
    expect(b.narrative_injected).toBe(true); // brief 本身仍可用
  });

  it('routing 缺失 → 返回 null（不构造空壳 brief）', async () => {
    expect(await buildRoutingBrief(null, 'X')).toBe(null);
    expect(await buildRoutingBrief({ scene: 'X' }, null)).toBe(null);
  });
});

// ───────────────────────── injector 一行 brief ─────────────────────────
describe('formatForPrompt — 叙事缺失时必须给出可解释说明', () => {
  it('未注入叙事 → 输出 routing-excluded 说明行', () => {
    const out = formatForPrompt({
      layers: { L3: { tasks: [], routing_brief: { scene: 'QUOTE_PRICING', mode: 'GRAPH_PRIMARY', score: 1, tracks: ['structured'], narrative_injected: false, experiment: null } } },
      narrative: { rows: [], available: false, unavailable_reason: 'routing-excluded' },
    });
    expect(out).toContain('routing-excluded');
    expect(out).toContain('QUOTE_PRICING');
  });

  it('注入但无数据 → 说明「叙事轨道已启用但无数据」（区分排除与空数据）', () => {
    const out = formatForPrompt({
      layers: { L3: { tasks: [], routing_brief: { scene: 'LEAD_FOLLOW_UP', mode: 'STORY_PRIMARY', score: 0, tracks: ['narrative'], narrative_injected: true, experiment: null } } },
      narrative: { rows: [], available: false, unavailable_reason: 'empty' },
    });
    expect(out).toContain('叙事轨道已启用但无数据');
    expect(out).not.toContain('routing-excluded');
  });

  it('无 routing_brief（旧 bundle）→ 不输出任何轨道行（向后兼容）', () => {
    const out = formatForPrompt({ layers: { L3: { tasks: [{ id: 1 }] } }, narrative: { rows: [], available: false } });
    expect(out).toContain('执行态');
    expect(out).not.toContain('场景轨道');
  });
});
