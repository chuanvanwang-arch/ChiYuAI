import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSignalStore } from 'file:///D:/system/CRM-ai-native/src/signal/store.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

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

  // ===== 2026-09-16 补：以下三条对应 S1 实测塌陷，缺一条即真断链 =====

  it('list tenant_id=\'*\' 为全量视界（admin 通配），普通值仍精确过滤', async () => {
    const store = createSignalStore(pool);
    await store.create({ tenant_id: 't1', source: 'rule-scan', kind: 'deal_stuck', severity: 'high', target_role: 'sales' });
    await store.create({ tenant_id: 't2', source: 'rule-scan', kind: 'deal_stuck', severity: 'high', target_role: 'sales' });
    // 鉴别力：若 '*' 被当字面量拼进 WHERE tenant_id='*'，下面第一断言会得 0 → 红
    const all = await store.list({ tenant_id: '*' });
    expect(all.length).toBe(2);
    expect([...new Set(all.map((r) => r.tenant_id))].sort()).toEqual(['t1', 't2']);
    const onlyT1 = await store.list({ tenant_id: 't1' });
    expect(onlyT1.length).toBe(1);
    expect(onlyT1[0].tenant_id).toBe('t1');
  });

  it('signal_id 可显式传入（告警链路沿用 alert_id 保溯源性）', async () => {
    const store = createSignalStore(pool);
    const r = await store.create({
      signal_id: 'alert-abc-123', tenant_id: 't1', source: 'rule-scan',
      kind: 'deal_stuck', severity: 'high', target_role: 'sales',
    });
    expect(r.ok).toBe(true);
    // 鉴别力：若 create 忽略入参恒用 randomUUID，此处得随机 uuid → 红（信号与原始告警失联）
    expect(r.alert.signal_id).toBe('alert-abc-123');
  });

  it('同 signal_id 二次落库幂等（PK 冲突回落既有行，不产生重复行）', async () => {
    const store = createSignalStore(pool);
    const first = await store.create({
      signal_id: 'alert-dup-1', tenant_id: 't1', source: 'rule-scan',
      kind: 'deal_stuck', severity: 'high', target_role: 'sales',
    });
    expect(first.ok).toBe(true);
    expect(first.deduped).toBe(false);
    // 模拟第二条落库路径（createAlert persister + createAlertWithDb 同时生效）再落同一告警
    const second = await store.create({
      signal_id: 'alert-dup-1', tenant_id: 't1', source: 'rule-scan',
      kind: 'deal_stuck', severity: 'high', target_role: 'sales',
    });
    expect(second.ok).toBe(true);         // 不抛错（原实现会 PK 冲突抛异常打断告警主流程）
    expect(second.deduped).toBe(true);
    expect(second.alert.signal_id).toBe('alert-dup-1');
    const rows = await store.list({ tenant_id: 't1' });
    expect(rows.length).toBe(1);          // 行数不增（不重复落库）
  });

  it('已关闭信号的 dedup_key 不再占位（闭环后同类告警可重新产生）', async () => {
    const store = createSignalStore(pool);
    const a = await store.create({
      signal_id: 'sig-1', tenant_id: 't1', source: 'rule-scan',
      kind: 'deal_stuck', severity: 'high', target_role: 'sales', dedup_key: 'deal_stuck:d9:hour',
    });
    expect(a.ok).toBe(true);
    await store.setStatus('t1', a.alert.signal_id, 'closed');
    // 鉴别力：若 idx_signal_dedup 是全状态唯一（2026-09-16 修正前的定义），
    //   此处 findOpenByDedup 漏过 closed 行 → INSERT 撞索引抛 23505 → 本测试红。
    //   这正是「告警处理完一次后，该对象该小时永远沉默」的真实缺陷。
    const b = await store.create({
      signal_id: 'sig-2', tenant_id: 't1', source: 'rule-scan',
      kind: 'deal_stuck', severity: 'high', target_role: 'sales', dedup_key: 'deal_stuck:d9:hour',
    });
    expect(b.ok).toBe(true);
    expect(b.deduped).toBe(false);
    expect(b.alert.signal_id).toBe('sig-2');
    const rows = await store.list({ tenant_id: 't1' });
    expect(rows.length).toBe(2); // 旧 closed 行 + 新 open 行
  });

  it('谓词一致性铁律：idx_signal_dedup 的索引谓词与 findOpenByDedup 查询谓词同源', async () => {
    // 本缺陷的根因就是"同一个去重语义写在 SQL 索引与 JS 查询两处、谓词不一致"。
    // 单看任何一处都正确，只有真库索引定义 × 源码谓词对账才能发现。
    const { rows } = await pool.query(
      `SELECT indexdef FROM pg_indexes WHERE schemaname='crm' AND indexname='idx_signal_dedup'`,
    );
    const def = rows[0]?.indexdef || '';
    expect(def).toContain('UNIQUE');
    expect(def).toContain('open');
    expect(def).toContain('acked');
    const src = readFileSync(join(ROOT, 'src/signal/store.js'), 'utf8');
    expect(src).toMatch(/status IN \('open','acked'\)/);
  });
});
