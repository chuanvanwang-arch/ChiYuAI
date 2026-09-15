import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { createSignalStore } from 'file:///D:/system/CRM-ai-native/src/signal/store.js';

// 连 crm_native_test 真库（项目测试惯例；TRUNCATE 隔离）
// ⚠ 共享库并发纪律：只清 crm.signal 表（本测试域），不动其他表
let pool;
beforeAll(async () => {
  pool = new pg.Pool({
    database: process.env.PGDATABASE || 'crm_native_test',
    host: 'localhost',
    port: 5433,
    user: 'agent2b',
    password: 'agent2b',
  });
  await pool.query('SET search_path TO crm,public');
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await pool.query('TRUNCATE crm.signal CASCADE');
});

describe('signal store（真库 crm_native_test）', () => {
  it('create 落 DB 并返回 signal（必填缺失拒绝）', async () => {
    const store = createSignalStore(pool);
    const bad = await store.create({ kind: 'deal_stuck' }); // 缺 source/severity/target_role
    expect(bad.ok).toBe(false);
    expect(bad.error).toBe('required_fields_missing');

    const good = await store.create({
      tenant_id: 't1', source: 'rule-scan', kind: 'deal_stuck', severity: 'high',
      target_role: 'sales', particle_id: 'd1', payload: { subject: 'x' }, dedup_key: 'deal_stuck:d1:hour',
    });
    expect(good.ok).toBe(true);
    expect(good.deduped).toBe(false);
    expect(good.alert.signal_id).toBeTruthy();
    expect(good.alert.status).toBe('open');
  });

  it('dedup 幂等：同 dedup_key 未关闭复用既有', async () => {
    const store = createSignalStore(pool);
    const first = await store.create({
      tenant_id: 't1', source: 'rule-scan', kind: 'deal_stuck', severity: 'high',
      target_role: 'sales', dedup_key: 'deal_stuck:d1:hour',
    });
    const second = await store.create({
      tenant_id: 't1', source: 'rule-scan', kind: 'deal_stuck', severity: 'high',
      target_role: 'sales', dedup_key: 'deal_stuck:d1:hour',
    });
    expect(second.ok).toBe(true);
    expect(second.deduped).toBe(true);
    expect(second.alert.signal_id).toBe(first.alert.signal_id);
  });

  it('list 按 tenant+状态+kind+严重度过滤', async () => {
    const store = createSignalStore(pool);
    await store.create({ tenant_id: 't1', source: 'rule-scan', kind: 'deal_stuck', severity: 'high', target_role: 'sales' });
    await store.create({ tenant_id: 't1', source: 'rule-scan', kind: 'lead_overdue', severity: 'low', target_role: 'ops' });
    const all = await store.list({ tenant_id: 't1' });
    expect(all.length).toBe(2);
    const high = await store.list({ tenant_id: 't1', severity: 'high' });
    expect(high.length).toBe(1);
    expect(high[0].kind).toBe('deal_stuck');
    const open = await store.list({ tenant_id: 't1', status: 'open' });
    expect(open.length).toBe(2);
  });

  it('setStatus 状态机：open→acked→closed（closed_at 落时间戳）', async () => {
    const store = createSignalStore(pool);
    const { alert } = await store.create({ tenant_id: 't1', source: 'rule-scan', kind: 'deal_stuck', severity: 'high', target_role: 'sales' });
    const a = await store.setStatus('t1', alert.signal_id, 'acked');
    expect(a.ok).toBe(true);
    expect(a.alert.status).toBe('acked');
    expect(a.alert.acked_at).toBeTruthy();
    const c = await store.setStatus('t1', alert.signal_id, 'closed');
    expect(c.ok).toBe(true);
    expect(c.alert.status).toBe('closed');
    expect(c.alert.closed_at).toBeTruthy();
    const miss = await store.setStatus('t1', 'nope', 'closed');
    expect(miss.ok).toBe(false);
    expect(miss.error).toBe('signal_not_found');
  });

  it('stats 聚合 open/acked/closed/acted 计数', async () => {
    const store = createSignalStore(pool);
    const { alert } = await store.create({ tenant_id: 't1', source: 'rule-scan', kind: 'deal_stuck', severity: 'high', target_role: 'sales' });
    await store.create({ tenant_id: 't1', source: 'event-trigger', kind: 'lead_overdue', severity: 'low', target_role: 'ops' });
    await store.setStatus('t1', alert.signal_id, 'acted');
    const s = await store.stats({ tenant_id: 't1' });
    expect(Number(s.open_count)).toBe(1);
    expect(Number(s.acted_count)).toBe(1);
    expect(Number(s.source_count)).toBe(2);
  });
});
