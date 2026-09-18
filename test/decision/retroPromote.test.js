// test/decision/retroPromote.test.js — D7 M→K 升格（retro 收盘自动升格为 tenant_precedent）
// 隔离：全 mock（不触真实 PG / 不触真实 memoryLog / promote）
// 覆盖：可信教训升格 / NEED_DIM_ORDER·degraded·system 跳过 / 幂等去重(同轮+跨轮) / 失败不阻断 / 计数可见
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ memSeq: 0, precedents: [], promoted: [] }));

vi.mock('../../src/events/bus.js', () => ({ emit: vi.fn() }));

// mock memoryLog.appendMemory 与 promote：完全隔离，仅计数/记录 payload
vi.mock('../../src/memory/memoryLog.js', () => ({
  appendMemory: vi.fn(async ({ topic, kind, payload, layer, actor, explicit, tenantId }) => {
    const row = { id: 'mem-' + (++h.memSeq), topic, kind, payload, layer, actor, tenant_id: tenantId };
    h.promoted.push({ memory_id: row.id, tenant_id: tenantId, topic, kind, payload, explicit });
    return { ok: true, row, tenant_id: tenantId };
  }),
}));

vi.mock('../../src/memory/promote.js', () => ({
  promoteMemoryToTenant: vi.fn(async (pool, { memoryId, tenantId, by, decisionId, title }) => {
    h.promoted.push({ promo: true, memory_id: memoryId, tenant_id: tenantId, by, decisionId, title });
    return { ok: true, row: { id: 'tp-' + memoryId, tenant_id: tenantId } };
  }),
  listTenantPrecedents: vi.fn(async (pool, tenantId) => h.precedents.filter((r) => r.tenant_id === tenantId)),
}));

import { promoteLessonsFromRetro, buildLessonPayload, PROMOTE_SKIP_CLASSES } from '../../src/decision/retroPromote.js';

const fakePool = { query: vi.fn() };

function mkAnalyzed({ klass = 'DIM_MISSING', degraded = false, tenantId = 't1', scenarioId = 'OPP_QUALIFY', count = 25, decisionIds = ['d1'] } = {}) {
  return [{ root_cause_class: klass, degraded, tenant_id: tenantId, scenario_id: scenarioId, count, sample_decision_ids: decisionIds, root_cause_explanation: '身份维度缺失' }];
}

beforeEach(() => {
  h.memSeq = 0;
  h.precedents = [];
  h.promoted = [];
  fakePool.query.mockClear();
});

describe('retroPromote · 升格语义', () => {
  it('可信教训（非 degraded、非占位类、租户非 system）→ 落 memory_log(explicit) + tenant_precedent，计数=1', async () => {
    const r = await promoteLessonsFromRetro({ analyzed: mkAnalyzed(), pool: fakePool, nowISO: '2026-09-18T12:00:00Z', by: 'system' });
    expect(r.promoted).toBe(1);
    expect(r.skipped).toBe(0);
    expect(r.failed).toBe(0);
    expect(h.promoted.filter((p) => p.promo)).toHaveLength(1);
    // memory_log 落点：explicit=true（破 worthiness 闸）
    expect(h.promoted[0].explicit).toBe(true);
    // lesson payload 携带教训摘要（可审计）
    expect(h.promoted[0].payload.root_cause_class).toBe('DIM_MISSING');
    // tenant_precedent 落点：溯源 memory_id
    expect(h.promoted[1]).toMatchObject({ promo: true, memory_id: 'mem-1', tenant_id: 't1', by: 'system', decisionId: null });
  });

  it('NEED_DIM_ORDER（样本不足占位）→ 跳过（不灌垃圾先例，防假绿）', async () => {
    const r = await promoteLessonsFromRetro({ analyzed: mkAnalyzed({ klass: 'NEED_DIM_ORDER' }), pool: fakePool, nowISO: 'x' });
    expect(r.promoted).toBe(0);
    expect(r.skipped).toBe(1);
    expect(h.promoted).toHaveLength(0);
  });

  it('degraded（LLM 不可信/启发式降级）→ 跳过', async () => {
    const r = await promoteLessonsFromRetro({ analyzed: mkAnalyzed({ degraded: true }), pool: fakePool, nowISO: 'x' });
    expect(r.promoted).toBe(0);
    expect(r.skipped).toBe(1);
  });

  it('system 租户 → 跳过（平台级教训不升格到具体租户）', async () => {
    const r = await promoteLessonsFromRetro({ analyzed: mkAnalyzed({ tenantId: 'system' }), pool: fakePool, nowISO: 'x' });
    expect(r.promoted).toBe(0);
    expect(r.skipped).toBe(1);
  });

  it('跨租户各自升格（每租户独立计数）', async () => {
    const r = await promoteLessonsFromRetro({
      analyzed: [...mkAnalyzed({ tenantId: 't1', klass: 'DIM_MISSING' }), ...mkAnalyzed({ tenantId: 't2', klass: 'INFO_INCOMPLETE' })],
      pool: fakePool, nowISO: 'x',
    });
    expect(r.promoted).toBe(2);
    expect(r.skipped).toBe(0);
  });
});

describe('retroPromote · 幂等去重（防夜批重复灌）', () => {
  it('同轮多簇同类同租户 → 只升格一次', async () => {
    const analyzed = [
      ...mkAnalyzed({ klass: 'DIM_MISSING', scenarioId: 'OPP_QUALIFY' }),
      ...mkAnalyzed({ klass: 'DIM_MISSING', scenarioId: 'LEAD_FOLLOW_UP' }),
    ];
    const r = await promoteLessonsFromRetro({ analyzed, pool: fakePool, nowISO: 'x' });
    expect(r.promoted).toBe(1); // 同租户同根因类只升格一次
    expect(h.promoted.filter((p) => p.promo)).toHaveLength(1);
  });

  it('已有同 (租户, 根因类) 先例 → 跳过（跨轮幂等）', async () => {
    h.precedents = [{ tenant_id: 't1', payload: { root_cause_class: 'DIM_MISSING' } }];
    const r = await promoteLessonsFromRetro({ analyzed: mkAnalyzed(), pool: fakePool, nowISO: 'x' });
    expect(r.promoted).toBe(0);
    expect(r.skipped).toBe(1);
  });
});

describe('retroPromote · 韧性（不阻断复盘）', () => {
  it('appendMemory 失败 → failed 计数，不抛（复盘主流程不受影响）', async () => {
    // 让 mock 的 appendMemory 抛错
    vi.mocked(await import('../../src/memory/memoryLog.js')).appendMemory.mockRejectedValueOnce(new Error('db down'));
    const r = await promoteLessonsFromRetro({ analyzed: mkAnalyzed(), pool: fakePool, nowISO: 'x' });
    expect(r.promoted).toBe(0);
    expect(r.failed).toBe(1);
  });

  it('promoteMemoryToTenant 失败 → failed 计数，不抛', async () => {
    vi.mocked(await import('../../src/memory/promote.js')).promoteMemoryToTenant.mockRejectedValueOnce(new Error('promote failed'));
    const r = await promoteLessonsFromRetro({ analyzed: mkAnalyzed(), pool: fakePool, nowISO: 'x' });
    expect(r.promoted).toBe(0);
    expect(r.failed).toBe(1);
  });

  it('analyzed 为空 / 无 pool → 直接返回零（guard）', async () => {
    expect((await promoteLessonsFromRetro({ analyzed: [], pool: fakePool, nowISO: 'x' })).promoted).toBe(0);
    expect((await promoteLessonsFromRetro({ analyzed: mkAnalyzed(), pool: null, nowISO: 'x' })).promoted).toBe(0);
  });
});

describe('retroPromote · payload 契约', () => {
  it('buildLessonPayload 携带教训摘要字段', () => {
    const p = buildLessonPayload({ scenarioId: 'OPP_QUALIFY', rootCauseClass: 'DIM_MISSING', explanation: 'x', decisionIds: ['d1', 'd2', 'd3', 'd4'], count: 30 });
    expect(p).toMatchObject({
      scenario_id: 'OPP_QUALIFY',
      root_cause_class: 'DIM_MISSING',
      root_cause_explanation: 'x',
      sample_size: 30,
    });
    expect(p.sample_decision_ids).toHaveLength(3); // 防 payload 膨胀
  });

  it('PROMOTE_SKIP_CLASSES 含 NEED_DIM_ORDER（占位不升格）', () => {
    expect(PROMOTE_SKIP_CLASSES.has('NEED_DIM_ORDER')).toBe(true);
  });
});
