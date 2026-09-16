// test/signal/scheduleScanner.test.js — T15 时间型信号（signal-schedule 配置驱动）
import { describe, it, expect } from 'vitest';
import { createScheduleScanner } from '../../src/signal/scheduleScanner.js';

function makeCtx({ rows = [], signals = [], readConfigValue } = {}) {
  const q = async () => ({ rows });
  const signalStore = {
    created: signals,
    create(o) { signals.push(o); return Promise.resolve({ ok: true, alert: { signal_id: 's' + signals.length }, deduped: false }); },
  };
  const readConfig = async () => ({ value: readConfigValue });
  return { q, signalStore, readConfig };
}

const RULE = { id: 'quote-timeout', kind: 'quote_approval_timeout', entity_type: 'CRM_DEAL',
  condition: { field: 'quote_status', op: 'eq', value: 'pending_approval' },
  threshold_days: 3, ts_field: 'approval_requested_at', severity: 'high', target_role: 'sales', enabled: true, bucket: 'day' };

describe('T15 时间型信号', () => {
  it('阈值配置化：threshold_days 改变命中集合', async () => {
    const deal = { id: 'd1', tenant_id: 't1', payload: { quote_status: 'pending_approval', approval_requested_at: new Date(Date.now() - 5 * 86400000).toISOString() } };
    const { q, signalStore, readConfig } = makeCtx({ rows: [deal], readConfigValue: { enabled: true, rules: [RULE] } });
    const sc = createScheduleScanner({ query: q, signalStore, readConfig });
    const r = await sc.scanOnce({ tenantId: 't1' });
    expect(r.signals).toBe(1);
    expect(signalStore.created[0].kind).toBe('quote_approval_timeout');
  });
  it('阈值调大后同数据不再命中（可证配置生效）', async () => {
    const deal = { id: 'd1', tenant_id: 't1', payload: { quote_status: 'pending_approval', approval_requested_at: new Date(Date.now() - 5 * 86400000).toISOString() } };
    const bigRule = { ...RULE, threshold_days: 10 };
    const { q, signalStore, readConfig } = makeCtx({ rows: [deal], readConfigValue: { enabled: true, rules: [bigRule] } });
    const sc = createScheduleScanner({ query: q, signalStore, readConfig });
    const r = await sc.scanOnce({ tenantId: 't1' });
    expect(r.signals).toBe(0);
  });
  it('hitsRule 纯函数：op=eq 不匹配 / 未超阈值 不命中', async () => {
    const { q, signalStore, readConfig } = makeCtx({ readConfigValue: { enabled: true, rules: [RULE] } });
    const sc = createScheduleScanner({ query: q, signalStore, readConfig });
    expect(sc.hitsRule(RULE, { payload: { quote_status: 'approved' } })).toBe(false); // op=eq 不匹配
    expect(sc.hitsRule(RULE, { payload: { quote_status: 'pending_approval', approval_requested_at: new Date().toISOString() } })).toBe(false); // 未超阈值
  });
  it('disabled 配置 → 不扫描', async () => {
    const { q, signalStore, readConfig } = makeCtx({ rows: [{ id: 'd', tenant_id: 't1', payload: { quote_status: 'pending_approval', approval_requested_at: new Date(Date.now() - 9 * 86400000).toISOString() } }], readConfigValue: { enabled: false, rules: [RULE] } });
    const sc = createScheduleScanner({ query: q, signalStore, readConfig });
    const r = await sc.scanOnce({ tenantId: 't1' });
    expect(r.signals).toBe(0);
  });
});
