// T2(BG-06) 边写降级留痕测试
// 缺陷背景：ageGraph.addEdge 在 AGE 不可用时静默 return，decisionRepo 7 处调用又 .catch(()=>{})
// → 边写失败零痕迹，监控台恒显「边齐备」（与 BG-04 seed 假绿叠加成双重假绿）。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  available: true,
  addEdgeImpl: null,
  emits: [],
  fails: {},
  memWrites: [],
}));

vi.mock('../../src/decision/ageGraph.js', () => ({
  isAvailable: () => state.available,
  addEdge: (...args) => (state.addEdgeImpl ? state.addEdgeImpl(...args) : Promise.resolve({ ok: true })),
}));
vi.mock('../../src/events/bus.js', () => ({
  // 注意：bus.emit 是三参 (domain, type, payload)，mock 签名必须一致
  emit: (domain, type, payload) => { state.emits.push({ domain, type, payload }); return true; },
}));
vi.mock('../../src/monitor/monitorStore.js', () => ({
  recordFailure: (kind) => { state.fails[kind] = (state.fails[kind] || 0) + 1; return { kind }; },
}));
vi.mock('../../src/memory/memoryLog.js', () => ({
  appendMemory: (args) => { state.memWrites.push(args); return Promise.resolve({ ok: true, row: {} }); },
}));

const { mirrorEdge, recentEdgeDegradations, resetEdgeDegradations } = await import('../../src/decision/edgeWrite.js');

beforeEach(() => {
  state.available = true;
  state.addEdgeImpl = null;
  state.emits = [];
  state.fails = {};
  state.memWrites = [];
  resetEdgeDegradations();
});

describe('T2/BG-06 — AGE 不可用时留痕（原静默缺陷）', () => {
  it('返回 degraded=true 且 reason=age-unavailable，不抛错', async () => {
    state.available = false;
    const r = await mirrorEdge('CAUSED', 'd1', 'd2', {}, { decision_id: 'd1' });
    expect(r.ok).toBe(false);
    expect(r.degraded).toBe(true);
    expect(r.reason).toBe('age-unavailable');
  });

  it('三重留痕：环形缓冲 + emit trace + recordFailure + 持久 memory_log', async () => {
    state.available = false;
    await mirrorEdge('CAUSED', 'd1', 'd2', { w: 1 }, { decision_id: 'd1', actor: 'alice' });
    // ① 环形缓冲（即时可查）
    const ring = recentEdgeDegradations(10);
    expect(ring).toHaveLength(1);
    expect(ring[0]).toMatchObject({ rel_type: 'CAUSED', from_id: 'd1', to_id: 'd2', decision_id: 'd1', actor: 'alice', reason: 'age-unavailable' });
    // ② 事件总线
    const ev = state.emits.find((e) => e.type === 'decision-edge-mirror-degraded');
    expect(ev).toBeTruthy();
    expect(ev.domain).toBe('trace');
    expect(ev.payload.rel_type).toBe('CAUSED');
    // ③ 失败计数
    expect(state.fails['decision-edge-mirror-degraded']).toBe(1);
    // ④ 持久化（explicit=true 绕过价值闸门，审计证据不被拒收）
    expect(state.memWrites).toHaveLength(1);
    expect(state.memWrites[0].explicit).toBe(true);
    expect(state.memWrites[0].payload.text).toContain('CAUSED');
  });
});

describe('T2/BG-06 — 写边失败留痕', () => {
  it('addEdge 抛异常 → reason=exception，捕获后不向上抛（fail-open 不阻断决策主链路）', async () => {
    state.addEdgeImpl = async () => { throw new Error('cypher down'); };
    const r = await mirrorEdge('INFLUENCED', 'd1', 'd2');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('exception');
    expect(r.error).toContain('cypher down');
    expect(recentEdgeDegradations(10)[0].error).toContain('cypher down');
  });

  it('addEdge 返回 skipped → 沿用其 reason 并留痕', async () => {
    state.addEdgeImpl = async () => ({ ok: false, skipped: 'age-unavailable' });
    const r = await mirrorEdge('OVERRIDES', 'd1', 'd2');
    expect(r.reason).toBe('age-unavailable');
    expect(recentEdgeDegradations(10)).toHaveLength(1);
  });

  it('addEdge 返回 {ok:false} 无 skipped → reason=write-failed', async () => {
    state.addEdgeImpl = async () => ({ ok: false, error: 'fk violated' });
    const r = await mirrorEdge('OVERRIDES', 'd1', 'd2');
    expect(r.reason).toBe('write-failed');
    expect(r.error).toBe('fk violated');
  });
});

describe('T2/BG-06 — 成功路径零噪声', () => {
  it('写边成功 → {ok:true, degraded:false} 且不留痕', async () => {
    state.addEdgeImpl = async () => ({ ok: true });
    const r = await mirrorEdge('CAUSED', 'd1', 'd2');
    expect(r).toEqual({ ok: true, degraded: false });
    expect(recentEdgeDegradations(10)).toHaveLength(0);
    expect(state.emits).toHaveLength(0);
    expect(state.memWrites).toHaveLength(0);
  });
});

describe('T2/BG-06 — 端点归一与缓冲行为', () => {
  it('对象端点（粒子/异常顶点）归一为 id 入留痕', async () => {
    state.available = false;
    await mirrorEdge('DECIDED_ON', 'd1', { id: 'p-9', label: 'CRM_ACCOUNT' });
    expect(recentEdgeDegradations(1)[0].to_id).toBe('p-9');
  });

  it('recentEdgeDegradations 倒序（最新在前）且受 limit 限制', async () => {
    state.available = false;
    await mirrorEdge('CAUSED', 'd1', 'd2');
    await mirrorEdge('INFLUENCED', 'd3', 'd4');
    const all = recentEdgeDegradations(10);
    expect(all).toHaveLength(2);
    expect(all[0].rel_type).toBe('INFLUENCED'); // 最新
    expect(recentEdgeDegradations(1)).toHaveLength(1);
  });

  it('环形缓冲上限 100，超出丢弃最旧（防无界增长）', async () => {
    state.available = false;
    for (let i = 0; i < 105; i++) await mirrorEdge('CAUSED', `d${i}`, 'dx');
    const all = recentEdgeDegradations(200);
    expect(all).toHaveLength(100);
    expect(all[0].from_id).toBe('d104'); // 最新保留
  });

  it('resetEdgeDegradations 清空缓冲（测试隔离）', async () => {
    state.available = false;
    await mirrorEdge('CAUSED', 'd1', 'd2');
    resetEdgeDegradations();
    expect(recentEdgeDegradations(10)).toHaveLength(0);
  });
});
