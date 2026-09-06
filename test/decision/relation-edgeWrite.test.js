// T2(BG-06) — relation.linkDecisions 接线验证
// ① AGE 不可用时镜像降级必须留痕（原 `if (isAvailable()) addEdge().catch(()=>{})` 完全静默）
// ② PG 权威表写失败同样留痕（边是真丢了，不是降级）
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  available: true,
  emits: [],
  fails: {},
  memWrites: [],
  pgWrites: [],
  pgFail: false,
}));

vi.mock('../../src/decision/ageGraph.js', () => ({
  isAvailable: () => state.available,
  addEdge: async () => ({ ok: true }),
}));
vi.mock('../../src/events/bus.js', () => ({
  emit: (domain, type, payload) => { state.emits.push({ domain, type, payload }); return true; },
}));
vi.mock('../../src/monitor/monitorStore.js', () => ({
  recordFailure: (kind) => { state.fails[kind] = (state.fails[kind] || 0) + 1; return { kind }; },
}));
vi.mock('../../src/memory/memoryLog.js', () => ({
  appendMemory: (args) => { state.memWrites.push(args); return Promise.resolve({ ok: true, row: {} }); },
}));
vi.mock('../../src/db.js', () => ({
  queryWrite: async (sql, params) => {
    state.pgWrites.push({ sql, params });
    if (state.pgFail) throw new Error('fk violated');
    return { rows: [] };
  },
  query: async () => ({ rows: [] }),
  pool: {},
}));

const { linkDecisions } = await import('../../src/decision/relation.js');
const { recentEdgeDegradations, resetEdgeDegradations } = await import('../../src/decision/edgeWrite.js');

beforeEach(() => {
  state.available = true;
  state.emits = [];
  state.fails = {};
  state.memWrites = [];
  state.pgWrites = [];
  state.pgFail = false;
  resetEdgeDegradations();
});

describe('T2/BG-06 — linkDecisions 边镜像降级留痕', () => {
  it('AGE 不可用时：权威表照写成功，但镜像降级必须留痕（原静默缺陷）', async () => {
    state.available = false;
    const r = await linkDecisions('d1', 'd2', 'CAUSED', { source: 'engine' });
    expect(r.fromId).toBe('d1');
    expect(state.pgWrites).toHaveLength(1);            // PG 权威写发生
    expect(r.mirror.degraded).toBe(true);              // 镜像降级
    expect(r.mirror.reason).toBe('age-unavailable');
    expect(recentEdgeDegradations(10)).toHaveLength(1); // 关键：留痕存在
  });

  it('AGE 可用时：镜像成功，零留痕', async () => {
    state.available = true;
    const r = await linkDecisions('d1', 'd2', 'CAUSED', { source: 'engine' });
    expect(r.mirror.degraded).toBe(false);
    expect(recentEdgeDegradations(10)).toHaveLength(0);
  });

  it('四边类型（CAUSED/INFLUENCED/ESTABLISHES_FRAME/REFERENCED_PRECEDENT）均走留痕入口', async () => {
    state.available = false;
    for (const t of ['CAUSED', 'INFLUENCED', 'ESTABLISHES_FRAME', 'REFERENCED_PRECEDENT']) {
      await linkDecisions('d1', 'd2', t, { source: 'engine' });
    }
    const ring = recentEdgeDegradations(10);
    expect(ring).toHaveLength(4);
    expect(new Set(ring.map((r) => r.rel_type))).toEqual(
      new Set(['CAUSED', 'INFLUENCED', 'ESTABLISHES_FRAME', 'REFERENCED_PRECEDENT'])
    );
  });
});

describe('T2/BG-06 — 权威表写失败留痕（边真丢，非降级）', () => {
  it('PG 写失败 → emit decision-relation-write-failed + recordFailure，并向上抛出', async () => {
    state.pgFail = true;
    await expect(linkDecisions('d1', 'd2', 'CAUSED')).rejects.toThrow('fk violated');
    const ev = state.emits.find((e) => e.type === 'decision-relation-write-failed');
    expect(ev).toBeTruthy();
    expect(ev.payload).toMatchObject({ from_id: 'd1', to_id: 'd2', rel_type: 'CAUSED' });
    expect(state.fails['decision-relation-write-failed']).toBe(1);
  });

  it('非法边类型直接拒绝（不改现有契约）', async () => {
    await expect(linkDecisions('d1', 'd2', 'NOT_AN_EDGE')).rejects.toThrow('非法 rel_type');
  });
});
