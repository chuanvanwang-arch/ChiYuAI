// 回归测试：reopenDeal 反向重开（S7/S8→S2，保留粒子身份，DEAL_REOPEN 锚定）
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { reopenDeal } from '../../src/sales/reopenDeal.js';
import { createParticle } from '../../src/particles/particleRepo.js';

// PG 仅监听 IPv6 ::1：必须用 localhost（解析优先 ::1），127.0.0.1 会 ECONNREFUSED
const pool = new pg.Pool({ user: 'agent2b', password: 'agent2b', host: 'localhost', port: 5433, database: 'crm_native_test' });
async function withDeal(stage, fn) {
  const p = await createParticle('CRM_DEAL', { name: 't', stage });
  const id = p.id;
  try { await fn(id); } finally {
    const c = await pool.connect();
    try { await c.query("SET search_path TO crm, public"); await c.query('DELETE FROM crm.particles WHERE id=$1', [id]); } finally { c.release(); }
  }
}

describe('reopenDeal', () => {
  it('非退出态(S2)调用抛错', async () => {
    await withDeal('S2', async (id) => {
      await expect(reopenDeal(id, { reason: 'x', owner: 'u', decision_id: 'd1' }))
        .rejects.toThrow(/仅退出态/);
    });
  });
  it('S7 重开 → stage=S2 且 reopen_count=1 且 last_reopen_decision_id 落库', async () => {
    await withDeal('S7', async (id) => {
      const u = await reopenDeal(id, { reason: '客户回流', owner: 'u', decision_id: 'dec-abc' });
      expect(u.payload.stage).toBe('S2');
      expect(u.payload.reopen_count).toBe(1);
      expect(u.payload.last_reopen_decision_id).toBe('dec-abc');
      const c = await pool.connect();
      try {
        await c.query("SET search_path TO crm, public");
        const r = await c.query('SELECT payload->>\'last_reopen_decision_id\' AS v FROM crm.particles WHERE id=$1', [id]);
        expect(r.rows[0].v).toBe('dec-abc');
      } finally { c.release(); }
    });
  });
});
