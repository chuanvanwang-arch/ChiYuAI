import { describe, it, expect } from 'vitest';
import { createSyncEngine } from '../../src/sync/engine.js';

const mockProvider = {
  kind: 'mock',
  verifyAuth: async () => ({ ok: true }),
  discoverObjects: async () => ({ objects: [{ name: 'AccountObj' }] }),
  readIncremental: async ({ cursor }) => ({
    rows: [
      { id: 'acc-1', name: '客户A' },
      { id: 'acc-2', name: '客户B' },
    ],
    cursor: 'cursor-2',
  }),
};

describe('sync engine（同步内核）', () => {
  it('runOnce 返回 {read,created,updated,skipped} 四计数', async () => {
    const engine = createSyncEngine({
      provider: mockProvider,
      mapping: {
        apply: () => ({ ok: true, particle_type: 'CRM_ACCOUNT', payload: { name: 'x' }, skippedFields: [] }),
      },
      resolver: {
        upsert: async () => ({ created: true, particle_id: 'p1' }),
      },
      cursor: { get: async () => null, set: async () => {} },
      trust: { level: async () => 'L2' }, // 信任分级：L2 允许写
    });
    const r = await engine.runOnce({ object: 'AccountObj', tenantId: 't1' });
    expect(r.read).toBe(2);
    expect(r.created).toBe(2);
    expect(r.updated).toBe(0);
    expect(r.skipped).toBe(0);
  });

  it('同批重复执行 created=0（幂等：external_id 已对齐）', async () => {
    // 幂等语义模拟：externalId 首见 → created；已见 → 非 created（对齐后不新建）
    const seen = new Set();
    const engine = createSyncEngine({
      provider: mockProvider,
      mapping: { apply: () => ({ ok: true, particle_type: 'CRM_ACCOUNT', payload: { name: 'x' }, skippedFields: [] }) },
      resolver: {
        upsert: async ({ externalId }) => {
          const created = !seen.has(externalId);
          seen.add(externalId);
          return { created, particle_id: 'p1' };
        },
      },
      cursor: { get: async () => 'cursor-1', set: async () => {} },
      trust: { level: async () => 'L2' }, // 信任分级：L2 允许写
    });
    const r1 = await engine.runOnce({ object: 'AccountObj', tenantId: 't1' });
    const r2 = await engine.runOnce({ object: 'AccountObj', tenantId: 't1' });
    expect(r1.created).toBe(2);
    expect(r2.created).toBe(0);
  });

  // 第 0 闸留痕（设计 §15「批量入库：一次 run mint 一个决策」）：
  // 挂载层铸的决策经 runOnce 透传到 sync_cursor.decision_id（L2/L3 写路径与 L1 只读路径都要落）
  it('decisionId 透传 → cursor.set 收到该值（L2 写路径）', async () => {
    const sets = [];
    const engine = createSyncEngine({
      provider: mockProvider,
      mapping: { apply: () => ({ ok: true, particle_type: 'CRM_ACCOUNT', payload: { name: 'x' }, skippedFields: [] }) },
      resolver: { upsert: async () => ({ created: true, particle_id: 'p1' }) },
      cursor: { get: async () => null, set: async (a) => { sets.push(a); } },
      trust: { level: async () => 'L2' },
    });
    await engine.runOnce({ object: 'AccountObj', tenantId: 't1', decisionId: 'dec-9' });
    expect(sets[0].decisionId).toBe('dec-9');
  });

  it('不传 decisionId → null（零回归：既有调用方语义不变）', async () => {
    const sets = [];
    const engine = createSyncEngine({
      provider: mockProvider,
      mapping: { apply: () => ({ ok: true, particle_type: 'CRM_ACCOUNT', payload: { name: 'x' }, skippedFields: [] }) },
      resolver: { upsert: async () => ({ created: true, particle_id: 'p1' }) },
      cursor: { get: async () => null, set: async (a) => { sets.push(a); } },
      trust: { level: async () => 'L2' },
    });
    await engine.runOnce({ object: 'AccountObj', tenantId: 't1' });
    expect(sets[0].decisionId).toBeNull();
  });

  it('L1 只读路径亦透传 decisionId（cursor 留痕不因只读而丢）', async () => {
    const sets = [];
    const engine = createSyncEngine({
      provider: mockProvider,
      mapping: { apply: () => ({ ok: true, particle_type: 'CRM_ACCOUNT', payload: {}, skippedFields: [] }) },
      resolver: { upsert: async () => { throw new Error('L1 不应 upsert'); } },
      cursor: { get: async () => null, set: async (a) => { sets.push(a); } },
      trust: { level: async () => 'L1' },
    });
    const r = await engine.runOnce({ object: 'AccountObj', tenantId: 't1', decisionId: 'dec-1' });
    expect(r.readOnly).toBe(true);
    expect(sets[0].decisionId).toBe('dec-1');
  });

  // 描述符按对象声明（设计 §9.3 objects[]）：provider 必须收到 object 才能定位查询目标
  // （实坑：不传 object → 按对象拉取的 provider 收到 undefined → 永远 read=0 的静默空转）
  it('readIncremental 收到 object 参数（不传即按对象拉取失效）', async () => {
    const seen = [];
    const engine = createSyncEngine({
      provider: {
        kind: 'mock',
        verifyAuth: async () => ({ ok: true }),
        readIncremental: async (a) => { seen.push(a); return { ok: true, rows: [], cursor: null }; },
      },
      mapping: { apply: () => ({ ok: true, particle_type: 'CRM_ACCOUNT', payload: {}, skippedFields: [] }) },
      resolver: { upsert: async () => ({ created: false }) },
      cursor: { get: async () => ({ cursor_value: 'c-0' }), set: async () => {} },
      trust: { level: async () => 'L1' },
    });
    await engine.runOnce({ object: 'ContactObj', tenantId: 't1' });
    expect(seen[0]).toEqual({ object: 'ContactObj', cursor: 'c-0' });
  });
});
