// test/db-pool.test.js — 企业级容量：读写双池导出与 env 生效
import { describe, it, expect } from 'vitest';
import { pool, poolRead, queryWrite, queryRead, withTx } from '../src/db.js';

describe('db 读写双池（企业级容量）', () => {
  it('导出写池 pool（默认 max=10，env 可覆盖）', () => {
    expect(pool.options.max).toBe(Number(process.env.PGPOOL_MAX_WRITE || 10));
  });
  it('导出读池 poolRead（默认 max=50，env 可覆盖）', () => {
    expect(poolRead.options.max).toBe(Number(process.env.PGPOOL_MAX_READ || 50));
  });
  it('queryWrite/queryRead/withTx 均为函数', () => {
    expect(typeof queryWrite).toBe('function');
    expect(typeof queryRead).toBe('function');
    expect(typeof withTx).toBe('function');
  });
});