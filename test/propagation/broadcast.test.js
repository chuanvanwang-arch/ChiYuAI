// test/propagation/broadcast.test.js — broadcastConfig fill-only/override（Task 2）
import { describe, it, expect } from 'vitest';
import { broadcastConfig, listTenants } from '../../src/config/broadcast.js';

// 内存桩 pool（仅拦截 query，验证调用意图；不连真实 PG）
function fakePool() {
  const pool = {
    __exists: new Set(),
    query: async (t, a) => {
      if (t.includes('DISTINCT tenant_id')) return { rows: [{ tenant_id: 't-a' }, { tenant_id: 't-b' }] };
      // fill-only 判定用：仅查「租户自有行」是否存在
      if (t.includes('FROM crm.config_store WHERE tenant_id=$1 AND key=$2')) {
        return { rows: pool.__exists.has(a[0]) ? [{ value: {}, decision_id: 'x' }] : [] };
      }
      return { rows: [] };
    },
  };
  return pool;
}

describe('broadcast', () => {
  it('fill-only 仅写未定制租户，不覆盖已存在者', async () => {
    const pool = fakePool();
    pool.__exists = new Set(['t-a']); // t-a 已定制
    const res = await broadcastConfig(pool, {
      key: 'precedent-conf', value: { minSimilarity: 0.4 }, mode: 'fill-only', by: 'admin', decisionId: 'd1',
    });
    expect(res.written).toEqual(['t-b']);
    expect(res.skipped).toEqual(['t-a']);
  });

  it('override 写全部目标', async () => {
    const pool = fakePool();
    pool.__exists = new Set(['t-a', 't-b']);
    const res = await broadcastConfig(pool, {
      key: 'precedent-conf', value: { minSimilarity: 0.4 }, mode: 'override', by: 'admin', decisionId: 'd1',
    });
    expect(res.written.sort()).toEqual(['t-a', 't-b']);
    expect(res.skipped).toEqual([]);
  });

  it('非法 mode 抛错', async () => {
    const pool = fakePool();
    await expect(broadcastConfig(pool, { key: 'k', value: 1, mode: 'nope' })).rejects.toThrow(/mode/);
  });

  it('listTenants 排除 system', async () => {
    const pool = fakePool();
    const ts = await listTenants(pool);
    expect(ts).toEqual(['t-a', 't-b']);
  });
});
