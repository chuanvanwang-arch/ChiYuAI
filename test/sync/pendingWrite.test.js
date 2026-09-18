// test/sync/pendingWrite.test.js — P0-2（ROX 立身之本·待写队列 + 快照对账）
// 判据（§5.3 / §9 反假绿纪律）：
//   ① 写失败入队 → 存在 pending 行（意图不丢）
//   ② drain 重放：ok → applied；stale/外部已改 → skipped_stale；其它失败 → 重试，超上限 → failed
//   ③ 对账判据：applied + skipped_stale + failed + pending(剩余) == 入队总数（防新黑洞）
import { describe, it, expect } from 'vitest';
import { createPendingWriteStore } from '../../src/sync/pendingWrite.js';

function fakePool() {
  const rows = [];
  let seq = 0;
  return {
    rows,
    query: async (sql, params) => {
      if (sql.startsWith('CREATE TABLE')) return { rows: [] };
      if (sql.startsWith('INSERT INTO crm.sync_pending_write')) {
        const row = {
          id: 'p' + (++seq), tenant_id: params[0], provider: params[1], external_object: params[2],
          external_id: params[3], particle_id: params[4], target: params[5],
          args: typeof params[6] === 'string' ? JSON.parse(params[6]) : params[6], // 模拟 Postgres JSONB 返回对象
          baseline_hash: params[7],
          status: 'pending', attempts: 0, max_attempts: 5, last_error: null,
        };
        rows.push(row);
        return { rows: [row] };
      }
      if (sql.startsWith('SELECT status, COUNT')) {
        const out = {};
        for (const r of rows) out[r.status] = (out[r.status] || 0) + 1;
        return { rows: Object.entries(out).map(([status, n]) => ({ status, n })) };
      }
      if (sql.startsWith('SELECT * FROM crm.sync_pending_write')) {
        return { rows: rows.filter((r) => r.status === 'pending') };
      }
      if (sql.startsWith('UPDATE crm.sync_pending_write')) {
        const id = params[0];
        const hit = rows.find((r) => r.id === id);
        if (!hit) return { rows: [] };
        if (sql.includes("status='applied'")) { hit.status = 'applied'; hit.applied_at = new Date(); }
        else if (sql.includes("status='skipped_stale'")) { hit.status = 'skipped_stale'; hit.last_error = params[1]; }
        else if (sql.includes("status='failed'")) { hit.status = 'failed'; hit.attempts = params[1]; hit.last_error = params[2]; }
        else { hit.attempts = params[1]; hit.last_error = params[2]; } // pending 重试（保留 pending）
        return { rows: [hit] };
      }
      return { rows: [] };
    },
  };
}

describe('pendingWrite 待写队列 + 对账（P0-2）', () => {
  it('写失败入队 → pending 行存在（意图不丢）', async () => {
    const pool = fakePool();
    const store = createPendingWriteStore({ pool });
    await store.enqueue({ tenantId: 't1', provider: 'mock', object: 'AccountObj', externalId: 'acc-1', particleId: 'p1', target: 'internal', fields: { name: 'A' }, args: { foo: 1 } });
    const c = await store.count();
    expect(c.pending).toBe(1);
    expect(c.applied + c.skipped_stale + c.failed).toBe(0);
  });

  it('drain：成功 → applied', async () => {
    const pool = fakePool();
    const store = createPendingWriteStore({ pool });
    await store.enqueue({ tenantId: 't1', provider: 'mock', object: 'AccountObj', externalId: 'acc-1', particleId: 'p1', args: { row: {} } });
    const summary = await store.drain({ callWriteback: async () => ({ ok: true }) });
    expect(summary.applied).toBe(1);
    expect(summary.pending).toBe(0);
    const c = await store.count();
    expect(c.applied).toBe(1);
  });

  it('drain：外部已改（stale）→ skipped_stale（快照比对，非 wall clock）', async () => {
    const pool = fakePool();
    const store = createPendingWriteStore({ pool });
    await store.enqueue({ tenantId: 't1', provider: 'mock', object: 'AccountObj', externalId: 'acc-1', particleId: 'p1', args: {} });
    const summary = await store.drain({ callWriteback: async () => ({ ok: false, error: 'cas_conflict' }) });
    expect(summary.skipped_stale).toBe(1);
    expect(summary.failed).toBe(0);
    const c = await store.count();
    expect(c.skipped_stale).toBe(1);
  });

  it('drain：瞬时失败 → 重试保留 pending；超 max_attempts → failed（不无限重试）', async () => {
    const pool = fakePool();
    const store = createPendingWriteStore({ pool });
    await store.enqueue({ tenantId: 't1', provider: 'mock', object: 'AccountObj', externalId: 'acc-1', particleId: 'p1', args: {} });
    // 第 1 次：瞬时失败 → 仍 pending
    let s = await store.drain({ callWriteback: async () => ({ ok: false, error: 'network' }) });
    expect(s.pending).toBe(1);
    expect(s.failed).toBe(0);
    // 连续失败直到超过 max_attempts(5)
    for (let i = 0; i < 6; i++) {
      await store.drain({ callWriteback: async () => ({ ok: false, error: 'network' }) });
    }
    const c = await store.count();
    expect(c.failed).toBe(1);
    expect(c.pending).toBe(0);
  });

  it('对账判据：四态之和 == 入队总数（防新黑洞假绿）', async () => {
    const pool = fakePool();
    const store = createPendingWriteStore({ pool });
    const total = 4;
    for (let i = 0; i < total; i++) {
      await store.enqueue({ tenantId: 't1', provider: 'mock', object: 'AccountObj', externalId: 'acc-' + i, particleId: 'p' + i, args: { externalId: 'acc-' + i } });
    }
    // 一次 drain：1 成功、1 stale、2 失败（瞬时）→ 剩余 pending 应继续存在
    await store.drain({
      callWriteback: async (args) => {
        if (args.externalId === 'acc-0') return { ok: true };
        if (args.externalId === 'acc-1') return { ok: false, error: 'cas_conflict' };
        return { ok: false, error: 'network' };
      },
    });
    const c = await store.count();
    const sum = c.pending + c.applied + c.skipped_stale + c.failed;
    expect(sum).toBe(total); // 对账：四态之和恒等于入队总数
    expect(c.applied).toBe(1);
    expect(c.skipped_stale).toBe(1);
    expect(c.failed + c.pending).toBe(2); // 2 条瞬时失败仍待重试（pending/failed 取决于尝试次数）
  });
});
