import { describe, it, expect, vi, beforeEach } from 'vitest';

// 仅 mock db.js（snapshotStore 只读 query）；edgeSource 常量用真实值
vi.mock('../../src/db.js', () => ({
  query: vi.fn(),
}));

import { query } from '../../src/db.js';
import {
  getDecisionContextSnapshot,
  getPlatformSupplyHealth,
  getSnapshotSuppliedMap,
} from '../../src/context/snapshotStore.js';
import { createHash } from 'node:crypto';

function hashOf(s) { return createHash('sha256').update(s).digest('hex').slice(0, 32); }

describe('snapshotStore.getDecisionContextSnapshot', () => {
  beforeEach(() => { query.mockReset(); });

  it('无 decisionId → null', async () => {
    expect(await getDecisionContextSnapshot(null)).toBeNull();
  });

  it('读最新快照并校验 hash（一致→OK）', async () => {
    const block = '【上下文 · 快照 x】银通包装 ← particles';
    query.mockResolvedValue({ rows: [{ snapshot_id: 's1', decision_id: 'd1', ops: [{ op: 'S1', status: 'hit' }], dim_coverage: { identity: { supplied: true } }, supplied_dims: 1, degraded: false, prompt_block: block, prompt_hash: hashOf(block), token_est: 12, cost_ms: 148, created_at: new Date().toISOString() }] });
    const r = await getDecisionContextSnapshot('d1');
    expect(r.snapshot_id).toBe('s1');
    expect(r.tamper).toBe('OK');
  });

  it('hash 不一致 → TAMPERED（篡改检测）', async () => {
    const block = '原始块';
    query.mockResolvedValue({ rows: [{ snapshot_id: 's2', decision_id: 'd2', ops: [], dim_coverage: {}, supplied_dims: 0, degraded: false, prompt_block: block, prompt_hash: 'deadbeef', created_at: new Date().toISOString() }] });
    const r = await getDecisionContextSnapshot('d2');
    expect(r.tamper).toBe('TAMPERED');
  });

  it('无快照 → null', async () => {
    query.mockResolvedValue({ rows: [] });
    expect(await getDecisionContextSnapshot('dX')).toBeNull();
  });
});

describe('snapshotStore.getPlatformSupplyHealth', () => {
  beforeEach(() => { query.mockReset(); });

  it('聚合 N/7 + 边双口径（演示不计入供给分母）', async () => {
    // 两次 query：第一次快照聚合，第二次边双口径
    query
      .mockResolvedValueOnce({ rows: [
        { decision_id: 'd1', supplied_dims: 7, dim_coverage: { identity: { supplied: true }, structure: { supplied: true }, semantics: { supplied: true }, time_config: { supplied: true }, decision_history: { supplied: true }, operational_state: { supplied: true }, governance: { supplied: true } }, degraded: false },
        { decision_id: 'd2', supplied_dims: 3, dim_coverage: { identity: { supplied: true }, structure: { supplied: true }, semantics: { supplied: true } }, degraded: true },
      ] })
      .mockResolvedValueOnce({ rows: [{ runtime: 2, demo: 7 }] });
    const h = await getPlatformSupplyHealth();
    // 2 个决策，供给维合计 7+3=10，分母 2*7=14 → 71.4%
    expect(h.decisions_with_snapshot).toBe(2);
    expect(h.supply_n7_pct).toBe(71.4);
    expect(h.supplied_dims_total).toBe(10);
    expect(h.degraded_count).toBe(1);
    // identity 被 2 个决策都供给
    expect(h.dim_coverage.identity).toEqual({ supplied: 2, total: 2 });
    // 边双口径：运行时 2 / 演示 7，演示不混入 runtime
    expect(h.edge_caliber).toEqual({ runtime: 2, demo: 7, total: 9 });
  });

  it('无快照 → N/7 = 0，不抛', async () => {
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ runtime: 0, demo: 7 }] });
    const h = await getPlatformSupplyHealth();
    expect(h.supply_n7_pct).toBe(0);
    expect(h.decisions_with_snapshot).toBe(0);
    expect(h.edge_caliber.demo).toBe(7);
  });
});

describe('snapshotStore.getSnapshotSuppliedMap', () => {
  beforeEach(() => { query.mockReset(); });
  it('批量映射 decision_id → supplied_dims', async () => {
    query.mockResolvedValue({ rows: [
      { decision_id: 'd1', supplied_dims: 7 },
      { decision_id: 'd2', supplied_dims: 4 },
    ] });
    const m = await getSnapshotSuppliedMap(['d1', 'd2']);
    expect(m.get('d1')).toBe(7);
    expect(m.get('d2')).toBe(4);
  });
  it('空数组 → 空 Map', async () => {
    expect((await getSnapshotSuppliedMap([])).size).toBe(0);
  });
});
