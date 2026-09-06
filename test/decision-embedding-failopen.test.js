// test/decision-embedding-failopen.test.js — 方案 B 健壮性：DB 列未迁移时写真向量维度错 fail-open 降级
// 无 DB 单测：直接覆盖 insertDecisionFailOpen 重试分支与 isDimensionMismatchError 判定（决策不丢 = 核心铁律）。
import { describe, it, expect } from 'vitest';
import { isDimensionMismatchError, insertDecisionFailOpen } from '../src/decision/decisionRepo.js';

const SQL = 'INSERT INTO decision (...) VALUES (...) RETURNING *';

describe('isDimensionMismatchError（维度错判定）', () => {
  it('pgvector 维度不符 → true；仅当带 embedding 值时', () => {
    expect(isDimensionMismatchError(new Error('expected 384 dimensions, not 1024'), [1, 2])).toBe(true);
    // 不带 embedding（hash 路径 NULL）→ 永不命中，避免把维度错误判套到 NULL 写
    expect(isDimensionMismatchError(new Error('expected 384 dimensions, not 1024'), null)).toBe(false);
    expect(isDimensionMismatchError(new Error('expected 384 dimensions, not 1024'), undefined)).toBe(false);
  });
  it('非维度错（FK/连接）→ false，须原样抛出', () => {
    expect(isDimensionMismatchError(new Error('insert or update on table violates foreign key'), [1, 2])).toBe(false);
    expect(isDimensionMismatchError(new Error('ECONNRESET'), [1, 2])).toBe(false);
    expect(isDimensionMismatchError(null, [1, 2])).toBe(false);
  });
});

describe('insertDecisionFailOpen（降级重试）', () => {
  it('首写维度错 → 降级 embedding=NULL 重试成功，决策不丢', async () => {
    let calls = 0;
    const writer = async (_s, p) => {
      calls++;
      if (calls === 1) throw new Error('expected 384 dimensions, not 1024');
      expect(p[1]).toBeNull(); // 重试时 embedding 已降级
      return { rows: [{ decision_id: 'd1', embedding: p[1] }] };
    };
    const onTrace = [];
    const onRec = [];
    const r = await insertDecisionFailOpen(SQL, ['a', [1, 2, 3], 'b'], 1, writer, (...a) => onTrace.push(a), (k, e) => onRec.push([k, e]));
    expect(r.rows[0].decision_id).toBe('d1');
    expect(calls).toBe(2); // 仅重试一次
    expect(onTrace[0][1]).toBe('decision-embedding-dim-mismatch'); // emit(domain, kind, payload) → kind 为第 2 参
    expect(onRec[0][0]).toBe('decision-embedding-dim-mismatch');
  });
  it('非维度错 → 原样抛出（不伪装降级）', async () => {
    const writer = async () => { throw new Error('connection refused'); };
    await expect(insertDecisionFailOpen(SQL, ['a', [1, 2, 3], 'b'], 1, writer)).rejects.toThrow('connection refused');
  });
  it('首写即成功 → 不重试', async () => {
    let calls = 0;
    const writer = async () => { calls++; return { rows: [{ decision_id: 'ok' }] }; };
    const r = await insertDecisionFailOpen(SQL, ['a', [1, 2, 3], 'b'], 1, writer);
    expect(r.rows[0].decision_id).toBe('ok');
    expect(calls).toBe(1);
  });
});
