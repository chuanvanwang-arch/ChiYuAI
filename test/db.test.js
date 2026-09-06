// test/db.test.js — Task1 失败测试：单库可连接
import { describe, it, expect } from 'vitest';
import { query } from '../src/db.js';

describe('db', () => {
  it('单库可连接且 pgcrypto 可用', async () => {
    const r = await query(`SELECT gen_random_uuid() AS id, version()`);
    expect(r.rows[0].id).toBeTruthy();
    expect(r.rows[0].version).toContain('PostgreSQL');
  });

  it('G4-T3 token_accounting 表存在（幂等建表契约）', async () => {
    const r = await query(`SELECT to_regclass('crm.token_accounting') AS t`);
    expect(r.rows[0].t).toBe('token_accounting');
    // 列契约（append-only 纪律：无 updated_at）
    const cols = (await query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='crm' AND table_name='token_accounting'
       ORDER BY ordinal_position`)).rows.map((c) => c.column_name);
    expect(cols).toContain('tokens_in');
    expect(cols).toContain('tokens_out');
    expect(cols).toContain('actor');
    expect(cols).not.toContain('updated_at');  // append-only：禁 update/delete 语义
  });
});