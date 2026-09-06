import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createApp } from '../../src/http/server.js';
import { query, queryWrite } from '../../src/db.js';
import { issueToken } from '../../src/http/auth.js';

const app = createApp();
const token = issueToken({ role: 'admin', display_name: 't', username: 'tester' });
const AUTH = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

const D1 = 'e1111111-1111-1111-1111-1111111111e1';

async function mkDecision(id) {
  await queryWrite(
    `INSERT INTO crm.decision
      (decision_id, scenario_id, trigger_context, involved_entities, conditions_evaluated, disposition, decider_type, rationale, business_tier, state)
     VALUES ($1,'LEAD_FOLLOW_UP','{}'::jsonb,'[]'::jsonb,'[]'::jsonb,'PROCEED','AUTONOMOUS_AGENT','r','NORMAL','AUTONOMOUS')
     ON CONFLICT (decision_id) DO NOTHING`,
    [id]);
}

describe('T16 gate-outcome + outcome 路由', () => {
  beforeAll(async () => { await mkDecision(D1); });
  beforeEach(async () => { await queryWrite('TRUNCATE crm.decision_outcome RESTART IDENTITY CASCADE'); });

  it('POST /api/decision/:id/outcome 无 token → 401', async () => {
    const res = await app.fetch(`/api/decision/${D1}/outcome`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcome_type: 'won' }),
    });
    expect(res.status).toBe(401);
  });

  it('POST /api/decision/:id/outcome 有 token → 200 幂等回写', async () => {
    const res = await app.fetch(`/api/decision/${D1}/outcome`, {
      method: 'POST', headers: AUTH,
      body: JSON.stringify({ outcome_type: 'won', payload: { amount: 100 } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    const d = (await query('SELECT outcome_verified FROM crm.decision WHERE decision_id=$1', [D1])).rows[0];
    expect(d.outcome_verified).toBe('won');
    // 幂等：再次同参不报错
    const res2 = await app.fetch(`/api/decision/${D1}/outcome`, {
      method: 'POST', headers: AUTH,
      body: JSON.stringify({ outcome_type: 'won', payload: { amount: 100 } }),
    });
    expect(res2.status).toBe(200);
  });

  it('POST /api/decision/:id/outcome 缺 outcome_type → 400', async () => {
    const res = await app.fetch(`/api/decision/${D1}/outcome`, {
      method: 'POST', headers: AUTH, body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('GET /api/monitor/gate-outcome 无 token → 403（requireAdminRole 守卫，对齐 2026-09-03 监控台收敛）', async () => {
    const res = await app.fetch('/api/monitor/gate-outcome?scenario_id=LEAD_FOLLOW_UP');
    expect(res.status).toBe(403);
  });

  it('GET /api/monitor/gate-outcome 有 token → 200 聚合', async () => {
    await app.fetch(`/api/decision/${D1}/outcome`, {
      method: 'POST', headers: AUTH,
      body: JSON.stringify({ outcome_type: 'won', payload: { amount: 100 } }),
    });
    const res = await app.fetch('/api/monitor/gate-outcome?scenario_id=LEAD_FOLLOW_UP', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scenario_id).toBe('LEAD_FOLLOW_UP');
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(body.business_success_rate).not.toBeNull();
  });
});
