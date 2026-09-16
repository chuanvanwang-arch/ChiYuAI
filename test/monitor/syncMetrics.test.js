import { describe, it, expect } from 'vitest';
import { getSyncMetrics } from 'file:///D:/system/CRM-ai-native/src/monitor/syncMetrics.js';

function fakePool() {
  const rows = [
    { tenant_id: 't1', provider: 'fxiaoke', external_object: 'AccountObj', last_status: 'ok', last_run_at: new Date(), last_counts: { read: 10, created: 2, conflicted: 1 }, token_cost: 5 },
    { tenant_id: 't1', provider: 'fxiaoke', external_object: 'ContactObj', last_status: 'failed', last_run_at: new Date(Date.now() - 3600e3), last_counts: { read: 0, conflicted: 0 }, token_cost: 1 },
    { tenant_id: 't2', provider: 'mock', external_object: 'AccountObj', last_status: 'ok', last_run_at: new Date(), last_counts: { read: 3, created: 1 }, token_cost: 2 },
  ];
  return {
    query: async (sql, params) => {
      if (sql.includes('crm.sync_cursor')) {
        const tid = params?.[0];
        return { rows: tid && tid !== '*' ? rows.filter(r => r.tenant_id === tid) : rows };
      }
      return { rows: [] };
    },
  };
}

describe('sync metrics（同步可观测 T07）', () => {
  it('聚合 lag/success_rate/conflict/writeback 四项指标', async () => {
    const m = await getSyncMetrics({ pool: fakePool(), tenantId: 't1' });
    expect(m.lag).toBeDefined(); // lag_ms 平均存在
    expect(m.success_rate).toBe(0.5); // t1: 1 ok / 2 rows
    expect(m.conflict).toBe(1); // t1 conflicted 合计
    expect(m.writeback).toBe(0); // L3 回写未启用（S4 落地前恒 0）
  });

  it('按 tenant_id 隔离返回', async () => {
    const m1 = await getSyncMetrics({ pool: fakePool(), tenantId: 't1' });
    const m2 = await getSyncMetrics({ pool: fakePool(), tenantId: 't2' });
    expect(m1.rows.length).toBe(2);
    expect(m2.rows.length).toBe(1);
  });
});
