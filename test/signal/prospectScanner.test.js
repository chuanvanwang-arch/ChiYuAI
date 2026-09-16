// test/signal/prospectScanner.test.js — T16 拓客信号（lead-pool-config 驱动）
import { describe, it, expect } from 'vitest';
import { createProspectScanner } from '../../src/signal/prospectScanner.js';
import { POOL_CONFIG_KEY } from '../../src/sales/pool.js';

function makeCtx(rows = []) {
  const SQL = `SELECT id, tenant_id, payload FROM crm.particles WHERE type='CRM_DEAL' AND tenant_id=$1`;
  const q = async (sql) => ({ rows: sql === SQL || sql.startsWith('SELECT id, tenant_id, payload FROM crm.particles WHERE type=\'CRM_DEAL\'') ? rows : [] });
  const signals = [];
  const signalStore = { create(o) { signals.push(o); return Promise.resolve({ ok: true }); } };
  const readConfig = async () => ({ value: { pools: [{ id: 'pool-new', recycle_rule: { recycle_days: 30, recycle_target: 'self' } }] } });
  return { q, signalStore, readConfig, signals, POOL_CONFIG_KEY };
}

describe('T16 拓客信号', () => {
  it('S0 超期未认领 / S0P 回收前 T-3 / 候选池触达窗口 各一条', async () => {
    const now = Date.now();
    const rows = [
      { id: 's0-1', tenant_id: 't1', payload: { stage: 'S0', owner_id: null, pooled_at: new Date(now - 40 * 86400000).toISOString() } },
      { id: 's0p-1', tenant_id: 't1', payload: { stage: 'S0P', owner_id: 'u1', last_follow_up_at: new Date(now - 27 * 86400000).toISOString() } },
      { id: 'cand-1', tenant_id: 't1', payload: { stage: 'S0', owner_id: null, candidate: true, pooled_at: new Date(now - 6 * 86400000).toISOString() } },
    ];
    const { q, signalStore, readConfig, signals } = makeCtx(rows);
    const sc = createProspectScanner({ query: q, signalStore, readConfig });
    const r = await sc.scanOnce({ tenantId: 't1' });
    expect(r.signals).toBe(3);
    const kinds = signals.map((s) => s.kind).sort();
    expect(kinds).toEqual(['candidate_touch_window', 's0_stale', 's0p_recycle_warn'].sort());
    // 写入为零：扫描器只 create signal，不调用任何写粒子 SQL
    expect(signals.every((s) => s.source === 'rule-scan')).toBe(true);
    // T21 个人隔离：S0P 预警属该负责人的私人事务 → 必须带 owner_id；
    //   公海/候选池类无主信号 → owner_id 显式 null（按 target_role 广播）。
    //   鉴别力：实现里丢掉 emitSignal 的 ownerId 实参 → 此断言红（原实现正是如此，204 行全 NULL）。
    const byKind = Object.fromEntries(signals.map((s) => [s.kind, s]));
    expect(byKind.s0p_recycle_warn.owner_id).toBe('u1');
    expect(byKind.s0_stale.owner_id).toBeNull();
    expect(byKind.candidate_touch_window.owner_id).toBeNull();
  });
  it('dedup_key 用 prospect: 前缀，不与 lead-pool-recycle 撞键', async () => {
    const now = Date.now();
    const rows = [{ id: 's0-1', tenant_id: 't1', payload: { stage: 'S0', owner_id: null, pooled_at: new Date(now - 40 * 86400000).toISOString() } }];
    const { q, signalStore, readConfig, signals } = makeCtx(rows);
    const sc = createProspectScanner({ query: q, signalStore, readConfig });
    await sc.scanOnce({ tenantId: 't1' });
    expect(signals[0].dedup_key.startsWith('prospect:')).toBe(true);
  });
  it('S0 已认领（有 owner）不产 s0_stale', async () => {
    const now = Date.now();
    const rows = [{ id: 's0-2', tenant_id: 't1', payload: { stage: 'S0', owner_id: 'u2', pooled_at: new Date(now - 40 * 86400000).toISOString() } }];
    const { q, signalStore, readConfig, signals } = makeCtx(rows);
    const sc = createProspectScanner({ query: q, signalStore, readConfig });
    const r = await sc.scanOnce({ tenantId: 't1' });
    expect(r.signals).toBe(0);
    expect(signals.length).toBe(0);
  });
});
