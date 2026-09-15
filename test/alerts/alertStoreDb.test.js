import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { resetAlertStore } from 'file:///D:/system/CRM-ai-native/src/alerts/alertStore.js';
import { createAlertWithDb } from 'file:///D:/system/CRM-ai-native/src/alerts/alertStore.js';

// 真库验证（crm_native_test）：内存 Map 双写 DB crm.signal（防假绿核心：createAlert ok ≠ 已落库）
let pool;
beforeAll(async () => {
  pool = new pg.Pool({
    database: process.env.PGDATABASE || 'crm_native_test',
    host: 'localhost', port: 5433, user: 'agent2b', password: 'agent2b',
  });
  await pool.query('SET search_path TO crm,public');
});
afterAll(async () => { await pool.end(); });

describe('alertStore 内存→DB 双写（B-B3）', () => {
  beforeEach(async () => {
    resetAlertStore();
    await pool.query('TRUNCATE crm.signal CASCADE');
  });

  it('createAlertWithDb 同时写内存与 DB（db 行非空）', async () => {
    const r = await createAlertWithDb(pool, {
      kind: 'deal_stuck', severity: 'high', target_role: 'sales',
      tenant_id: 't1', particle_id: 'd1', payload: { metric: 1 },
    });
    expect(r.ok).toBe(true);
    expect(r.alert.alert_id).toBeTruthy();
    expect(r.db).toBeTruthy();
    expect(r.db.kind).toBe('deal_stuck');
    expect(r.db.tenant_id).toBe('t1');
  });

  it('既有 API 签名不变（createAlert/listAlerts/ackAlert/closeAlert）', async () => {
    const mod = await import('file:///D:/system/CRM-ai-native/src/alerts/alertStore.js');
    expect(typeof mod.createAlert).toBe('function');
    expect(typeof mod.listAlerts).toBe('function');
    expect(typeof mod.ackAlert).toBe('function');
    expect(typeof mod.closeAlert).toBe('function');
    expect(typeof mod.createAlertWithDb).toBe('function');
  });

  it('同 dedup_key 重复双写 DB 幂等（唯一索引 idx_signal_dedup → 第二次 db=null）', async () => {
    const r1 = await createAlertWithDb(pool, {
      kind: 'lead_overdue', severity: 'medium', target_role: 'sales', tenant_id: 't1', particle_id: 'p1',
    });
    const r2 = await createAlertWithDb(pool, {
      kind: 'lead_overdue', severity: 'medium', target_role: 'sales', tenant_id: 't1', particle_id: 'p1',
    });
    // 同 particle+kind → 同 dedup_key → 唯一索引冲突 → 第二次 DB 落 null（已存在不叠加）
    expect(r1.db).toBeTruthy();
    expect(r2.db).toBeFalsy();
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM crm.signal WHERE tenant_id='t1' AND dedup_key=$1`,
      [`lead_overdue:p1:hour`],
    );
    expect(rows[0].n).toBe(1);
  });
});
