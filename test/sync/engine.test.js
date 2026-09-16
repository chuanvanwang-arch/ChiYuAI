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
});
