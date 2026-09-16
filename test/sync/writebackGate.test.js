// test/sync/writebackGate.test.js — S4 T04 回写入网关（L3 回写分支 + 首 N 批人工确认）
// 契约：trust L3 允许回写且首 N 批需人工确认；engine runOnce 在 L3 下执行回写（callWriteback 注入）
//   回写失败（CAS 拒绝）计入 conflicted 不静默
import { describe, it, expect, vi } from 'vitest';
import { createTrustManager } from '../../src/sync/trust.js';
import { createSyncEngine } from '../../src/sync/engine.js';

describe('writeback gate（T04 回写入网关）', () => {
  it('L3 允许回写且首 N 批需人工确认（first_n_batches_require_human）', async () => {
    const t = createTrustManager({
      readConfig: async () => ({ value: { default_level: 'L3', levels: { L3: { allow_writeback: true, first_n_batches_require_human: 3 } } } }),
    });
    expect(await t.canWriteBack('t1')).toBe(true);
    expect(await t.firstNBatchesHuman('t1')).toBe(3);
  });

  it('engine L3 下回执行回写（callWriteback 被调用 + writeback 计数）', async () => {
    const provider = {
      kind: 'mock',
      verifyAuth: async () => ({ ok: true }),
      readIncremental: async () => ({ rows: [{ id: 'acc-1', name: '客户A' }], cursor: 'c2' }),
    };
    const callWriteback = vi.fn(async () => ({ ok: true }));
    const engine = createSyncEngine({
      provider,
      mapping: { apply: () => ({ ok: true, particle_type: 'CRM_ACCOUNT', payload: { name: 'x' }, skippedFields: [] }) },
      resolver: { upsert: async () => ({ created: true, particle_id: 'p1' }) },
      cursor: { get: async () => null, set: async () => {} },
      trust: { level: async () => 'L3', canWriteBack: async () => true }, // L3 允许回写
      callWriteback,
    });
    const r = await engine.runOnce({ object: 'AccountObj', tenantId: 't1' });
    expect(callWriteback).toHaveBeenCalled(); // L3 回写执行
    expect(r.writeback).toBe(1); // 回写计数
    expect(r.readOnly).toBe(false);
  });

  it('回写失败（CAS 拒绝）计入 conflicted 不静默', async () => {
    const provider = {
      kind: 'mock',
      verifyAuth: async () => ({ ok: true }),
      readIncremental: async () => ({ rows: [{ id: 'acc-1', name: '客户A' }], cursor: 'c2' }),
    };
    const callWriteback = vi.fn(async () => ({ ok: false })); // 模拟 CAS 拒绝
    const engine = createSyncEngine({
      provider,
      mapping: { apply: () => ({ ok: true, particle_type: 'CRM_ACCOUNT', payload: { name: 'x' }, skippedFields: [] }) },
      resolver: { upsert: async () => ({ created: true, particle_id: 'p1' }) },
      cursor: { get: async () => null, set: async () => {} },
      trust: { level: async () => 'L3', canWriteBack: async () => true },
      callWriteback,
    });
    const r = await engine.runOnce({ object: 'AccountObj', tenantId: 't1' });
    expect(r.writeback).toBe(0); // 回写未成功
    expect(r.conflicted).toBe(1); // 计入冲突（不静默）
  });
});
