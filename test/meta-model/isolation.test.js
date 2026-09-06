// test/meta-model/isolation.test.js
// Phase 0 (P0) DDL 隔离断言：meta_attr / memory_log / memory_snapshot / memory_note 加 tenant_id；edges 加 cardinality。
// 运行前这些列不存在 → 测试 FAIL（红）；执行 db/schema.sql + 迁移后 → PASS（绿）。
import { describe, it, expect } from 'vitest';
import { query } from '../../src/db.js';

async function hasColumn(table, column) {
  const r = await query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='crm' AND table_name=$1 AND column_name=$2`,
    [table, column]
  );
  return r.rows.length === 1;
}

describe('P0 meta-model tenant isolation (DDL)', () => {
  it('meta_attr has tenant_id column', async () => {
    expect(await hasColumn('meta_attr', 'tenant_id')).toBe(true);
  });

  for (const t of ['memory_log', 'memory_snapshot', 'memory_note']) {
    it(`${t} has tenant_id column`, async () => {
      expect(await hasColumn(t, 'tenant_id')).toBe(true);
    });
  }

  it('edges has cardinality column', async () => {
    expect(await hasColumn('edges', 'cardinality')).toBe(true);
  });
});
