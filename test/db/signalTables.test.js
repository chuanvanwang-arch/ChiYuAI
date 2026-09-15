import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

// 直连 crm_native_test，先 SET search_path（对齐项目测试惯例）
// ⚠ 共享库并发纪律：本测试只读 information_schema，不做 TRUNCATE，不干扰并行会话
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

describe('signal 运行态表', () => {
  it('crm.signal 与 crm.signal_delivery 已建（information_schema 对照）', async () => {
    const { rows } = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='crm' AND table_name IN ('signal','signal_delivery')`,
    );
    const names = rows.map(r => r.table_name);
    expect(names).toContain('signal');
    expect(names).toContain('signal_delivery');
  });

  it('crm.signal 含关键投递语义列（dedup_key/status/severity）', async () => {
    const { rows } = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='crm' AND table_name='signal'
         AND column_name IN ('dedup_key','status','severity','target_role','payload','evidence','suggestion')`,
    );
    const cols = rows.map(r => r.column_name);
    for (const c of ['dedup_key', 'status', 'severity', 'target_role', 'payload', 'evidence', 'suggestion']) {
      expect(cols).toContain(c);
    }
  });
});
