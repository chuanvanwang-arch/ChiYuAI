// test/sync/engineReadFailure.test.js — P0-2：provider 失败必须留痕，不得记 ok（去假健康）
import { describe, it, expect } from 'vitest';
import { createSyncEngine } from '../../src/sync/engine.js';

function mkEngine(provider, sets) {
  return createSyncEngine({
    provider,
    mapping: { apply: () => ({ ok: true, particle_type: 'CRM_ACCOUNT', payload: {}, skippedFields: [] }) },
    resolver: { upsert: async () => ({ created: true, particle_id: 'p1' }) },
    cursor: { get: async () => null, set: async (a) => { sets.push(a); } },
    trust: { level: async () => 'L2' },
  });
}

describe('engine 读入失败留痕（P0-2）', () => {
  it('provider 返 ok:false → runOnce ok:false 且 cursor.status=failed + last_error（不记 ok）', async () => {
    const sets = [];
    const r = await mkEngine({
      kind: 'fxiaoke',
      verifyAuth: async () => ({ ok: true }),
      readIncremental: async () => ({ ok: false, error: 'fxiaoke_credentials_incomplete', rows: [], cursor: null }),
    }, sets).runOnce({ object: 'AccountObj', tenantId: 't1' });
    expect(r.ok).toBe(false);
    expect(r.read).toBe(0);
    expect(sets).toHaveLength(1);
    expect(sets[0].status).toBe('failed');
    expect(sets[0].error).toContain('credentials_incomplete');
  });

  it('provider 抛异常 → 同样 status=failed（旧实现 .catch 吞错记 ok 已修）', async () => {
    const sets = [];
    const r = await mkEngine({
      kind: 'mock',
      verifyAuth: async () => ({ ok: true }),
      readIncremental: async () => { throw new Error('socket hang up'); },
    }, sets).runOnce({ object: 'AccountObj', tenantId: 't1' });
    expect(r.ok).toBe(false);
    expect(sets[0].status).toBe('failed');
    expect(sets[0].error).toContain('socket hang up');
  });

  it('provider 返回无 ok 字段（旧契约/替身）→ 走原路径零回归', async () => {
    const sets = [];
    const r = await mkEngine({
      kind: 'mock',
      verifyAuth: async () => ({ ok: true }),
      readIncremental: async () => ({ rows: [{ id: 'a1', name: 'X' }], cursor: 'c2' }),
    }, sets).runOnce({ object: 'AccountObj', tenantId: 't1' });
    expect(r.ok).toBe(true);
    expect(r.read).toBe(1);
    expect(r.created).toBe(1);
    expect(sets[0].status).toBe('ok');
  });

  it('L1 只读路径遇 ok:false → 同样落 failed（只读不等于可假健康）', async () => {
    const sets = [];
    const engine = createSyncEngine({
      provider: { kind: 'mock', verifyAuth: async () => ({ ok: true }), readIncremental: async () => ({ ok: false, error: 'http_500' }) },
      mapping: { apply: () => ({ ok: false }) },
      resolver: { upsert: async () => { throw new Error('不应 upsert'); } },
      cursor: { get: async () => null, set: async (a) => { sets.push(a); } },
      trust: { level: async () => 'L1' },
    });
    const r = await engine.runOnce({ object: 'AccountObj', tenantId: 't1' });
    expect(r.ok).toBe(false);
    expect(sets[0].status).toBe('failed');
  });

  it('成功路径游标与 decisionId 不受影响（零回归）', async () => {
    const sets = [];
    const r = await mkEngine({
      kind: 'mock',
      verifyAuth: async () => ({ ok: true }),
      readIncremental: async () => ({ ok: true, rows: [], cursor: 'c-9' }),
    }, sets).runOnce({ object: 'AccountObj', tenantId: 't1', decisionId: 'dec-1' });
    expect(r.ok).toBe(true);
    expect(sets[0].cursor).toBe('c-9');
    expect(sets[0].decisionId).toBe('dec-1');
    expect(sets[0].status).toBe('ok');
  });
});
