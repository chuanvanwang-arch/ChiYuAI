// 回归测试：决策 stop_loss 落库时 fail-open 镜像到 CRM_DEAL.payload.stop_loss
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { createDecision } from '../../src/decision/decisionRepo.js';
import { createParticle } from '../../src/particles/particleRepo.js';

const pool = new pg.Pool({ user: 'agent2b', password: 'agent2b', host: '127.0.0.1', port: 5433, database: 'crm_native_test' });

describe('stop_loss 镜像到粒子 payload', () => {
  it('决策 stop_loss + 挂 CRM_DEAL → 粒子 payload.stop_loss 同步', async () => {
    const c = await pool.connect();
    let dealId, decId;
    try {
      await c.query("SET search_path TO crm, public");
      const d = await createParticle('CRM_DEAL', { name: 'm' });
      dealId = d.id;
      const dec = await createDecision({
        scenario_id: 'QUOTE_PRICING', disposition: 'APPROVE',
        involved_entities: [{ type: 'CRM_DEAL', id: dealId }],
        stop_loss: { status: 'armed', condition: '15 天未签', deadline: '2026-09-30', trigger: '报价过期', owner: '销售' },
        tenantId: 'system',
      });
      decId = dec.decision_id;
      const r = await c.query('SELECT payload->\'stop_loss\' AS sl FROM crm.particles WHERE id=$1', [dealId]);
      expect(r.rows[0].sl).toMatchObject({ status: 'armed', condition: '15 天未签' });
    } finally {
      if (decId) await c.query('DELETE FROM crm.decision WHERE decision_id=$1', [decId]).catch(() => {});
      if (dealId) await c.query('DELETE FROM crm.particles WHERE id=$1', [dealId]);
      c.release();
    }
  });
  it('决策无 stop_loss → 不写粒子 stop_loss（无残留）', async () => {
    const c = await pool.connect();
    let dealId, decId;
    try {
      await c.query("SET search_path TO crm, public");
      const d = await createParticle('CRM_DEAL', { name: 'n' });
      dealId = d.id;
      const dec = await createDecision({
        scenario_id: 'OPP_QUALIFY', disposition: 'APPROVE',
        involved_entities: [{ type: 'CRM_DEAL', id: dealId }],
        tenantId: 'system',
      });
      decId = dec.decision_id;
      const r = await c.query('SELECT payload->\'stop_loss\' AS sl FROM crm.particles WHERE id=$1', [dealId]);
      expect(r.rows[0].sl).toBeNull();
    } finally {
      if (decId) await c.query('DELETE FROM crm.decision WHERE decision_id=$1', [decId]).catch(() => {});
      if (dealId) await c.query('DELETE FROM crm.particles WHERE id=$1', [dealId]);
      c.release();
    }
  });
});
