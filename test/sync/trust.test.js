import { describe, it, expect } from 'vitest';
import { createTrustManager } from '../../src/sync/trust.js';

describe('sync trust（信任分级）', () => {
  it('L1 只读：allow_writeback=false, allow_upsert=false', async () => {
    const t = createTrustManager({ readConfig: async () => ({ value: { default_level: 'L1' } }) });
    const l = await t.level('t1');
    expect(l).toBe('L1');
    const c = await t.canUpsert('t1');
    expect(c).toBe(false);
    const w = await t.canWriteBack('t1');
    expect(w).toBe(false);
  });

  it('L2 批量入库：allow_upsert=true 且整批仅 1 决策（decision_granularity=per_run）', async () => {
    const t = createTrustManager({ readConfig: async () => ({ value: { default_level: 'L2', levels: { L2: { allow_upsert: true, decision_granularity: 'per_run' } } } }) });
    expect(await t.canUpsert('t1')).toBe(true);
    expect(await t.decisionGranularity('t1')).toBe('per_run');
  });

  it('L3 提升需人工（无自动提升路径）', async () => {
    const t = createTrustManager({ readConfig: async () => ({ value: { default_level: 'L3', levels: { L3: { allow_writeback: true, first_n_batches_require_human: 3 } } } }) });
    expect(await t.canWriteBack('t1')).toBe(true);
    expect(await t.firstNBatchesHuman('t1')).toBe(3);
    // 无 elevate() 方法 = 无自动提升路径
    expect(typeof t.elevate).toBe('undefined');
  });
});
