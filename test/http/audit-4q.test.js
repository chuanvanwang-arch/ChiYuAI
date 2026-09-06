import { describe, it, expect, beforeAll } from 'vitest';
import { createApp } from '../../src/http/server.js';
import { queryWrite } from '../../src/db.js';
import { issueToken } from '../../src/http/auth.js';

const app = createApp();
const token = issueToken({ role: 'admin', display_name: 't', username: 'tester' });
const AUTH = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

const SCN = 'AUDIT4Q_SCEN';
const D = 'a4444444-4444-4444-4444-4444444444a4';
const P = 'b4444444-4444-4444-4444-4444444444b4';
const PTYPE = 'AUDIT4Q_DEAL';

describe('T-AUDIT4Q GET /api/decision/:id/audit-4q 四问审计聚合', () => {
  beforeAll(async () => {
    await queryWrite('DELETE FROM crm.decision_relation WHERE from_id=$1', [D]);
    await queryWrite('DELETE FROM crm.decision WHERE decision_id=$1', [D]);
    await queryWrite('DELETE FROM crm.assertions WHERE entity_id=$1', [P]);
    await queryWrite('DELETE FROM crm.particles WHERE id=$1', [P]);
    await queryWrite('DELETE FROM crm.meta_attr WHERE particle_type=$1', [PTYPE]);
    await queryWrite(`INSERT INTO crm.decision_scenario(scenario_id, stage, trigger, eval_dimensions) VALUES ($1,'AUDIT','{}'::jsonb,'[]'::jsonb) ON CONFLICT (scenario_id, tenant_id) DO NOTHING`, [SCN]);
    await queryWrite(
      `INSERT INTO crm.decision (decision_id, scenario_id, trigger_context, involved_entities, conditions_evaluated, disposition, decider_type, rationale, business_tier, state, decided_at)
       VALUES ($1,$2,'{}'::jsonb,$3::jsonb,'[]'::jsonb,'PROCEED','AUTONOMOUS_AGENT','r','NORMAL','REQUIRED', now())`,
      [D, SCN, JSON.stringify([{ id: P, type: PTYPE }])]
    );
    await queryWrite(
      `INSERT INTO crm.particles (id, type, slug, title, payload, updated_at)
       VALUES ($1,$2,'s-audit-1','audit deal 1','{"cust_no":"C1"}'::jsonb, now())`,
      [P, PTYPE]
    );
    // Q3 冲突种子：同实体同属性两个不同来源值 → 多源不一致保留不删，needs_review=true（待裁决）
    await queryWrite(
      `INSERT INTO crm.assertions (entity_id, attr, value, source_id, needs_review) VALUES
       ($1,'customer_name','张三','src_a',true),($1,'customer_name','李四','src_b',true)`,
      [P]
    );
  });

  it('无 token → 401', async () => {
    const res = await app.fetch(`/api/decision/${D}/audit-4q`);
    expect(res.status).toBe(401);
  });

  it('有 token → 200 返回四问结构与可审计性 N/4', async () => {
    const res = await app.fetch(`/api/decision/${D}/audit-4q`, { headers: AUTH });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.decision_id).toBe(D);
    expect(b.health.total).toBe(4);
    expect(b.health.statuses).toHaveProperty('Q1');
    expect(b.health.statuses).toHaveProperty('Q2');
    expect(b.health.statuses).toHaveProperty('Q3');
    expect(b.health.statuses).toHaveProperty('Q4');
    for (const q of ['Q1', 'Q2', 'Q3', 'Q4']) {
      expect(['pass', 'warn', 'fail']).toContain(b.questions[q].status);
      expect(b.questions[q].question).toBeTruthy();
    }
  });

  it('Q3 冲突事实：种子冲突应被聚合为未裁决冲突（status=warn, unresolved>=1）', async () => {
    const res = await app.fetch(`/api/decision/${D}/audit-4q`, { headers: AUTH });
    const b = await res.json();
    expect(b.questions.Q3.status).toBe('warn');
    expect(b.questions.Q3.unresolved_count).toBeGreaterThanOrEqual(1);
    expect(b.questions.Q3.conflicts[0].values.sort()).toEqual(['张三', '李四']);
    expect(b.health.needs_review_count).toBeGreaterThanOrEqual(1);
  });

  it('不存在的决策 → 404', async () => {
    const res = await app.fetch('/api/decision/e0000000-0000-0000-0000-000000000000/audit-4q', { headers: AUTH });
    expect(res.status).toBe(404);
  });
});
