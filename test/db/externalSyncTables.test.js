import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

let pool;
beforeAll(async () => {
  pool = new pg.Pool({
    database: process.env.PGDATABASE || 'crm_native_test',
    host: 'localhost', port: 5433, user: 'agent2b', password: 'agent2b',
  });
  await pool.query('SET search_path TO crm,public');
});
afterAll(async () => { await pool.end(); });

describe('external sync 运行态表', () => {
  it('crm.external_ref 与 crm.sync_cursor 已建', async () => {
    const { rows } = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='crm' AND table_name IN ('external_ref','sync_cursor')`,
    );
    const names = rows.map(r => r.table_name);
    expect(names).toContain('external_ref');
    expect(names).toContain('sync_cursor');
  });

  it('external_ref 含对齐/软删/去重关键列', async () => {
    const { rows } = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='crm' AND table_name='external_ref'
         AND column_name IN ('particle_id','external_id','external_deleted_at','last_hash','last_direction')`,
    );
    const cols = rows.map(r => r.column_name);
    for (const c of ['particle_id', 'external_id', 'external_deleted_at', 'last_hash', 'last_direction']) {
      expect(cols).toContain(c);
    }
  });

  it('sync_cursor 含运行留痕关键列', async () => {
    const { rows } = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='crm' AND table_name='sync_cursor'
         AND column_name IN ('cursor_value','last_counts','last_status','decision_id')`,
    );
    const cols = rows.map(r => r.column_name);
    for (const c of ['cursor_value', 'last_counts', 'last_status', 'decision_id']) {
      expect(cols).toContain(c);
    }
  });
});
