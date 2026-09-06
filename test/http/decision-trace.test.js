import { describe, it, expect, beforeAll } from 'vitest';
import { createApp } from '../../src/http/server.js';
import { queryWrite } from '../../src/db.js';
import { issueToken } from '../../src/http/auth.js';

const app = createApp();
const token = issueToken({ role: 'admin', display_name: 't', username: 'tester' });
const AUTH = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

const SCN = 'TRACE_ROUTE_SCEN';
const D = 'e2222222-2222-2222-2222-2222222222e2';
const P = 'f2222222-2222-2222-2222-2222222222f2';
const PTYPE = 'TRACE_ROUTE_DEAL';

describe('T30 GET /api/decision/:id/trace 溯源端点', () => {
  beforeAll(async () => {
    await queryWrite('DELETE FROM crm.decision_relation WHERE from_id=$1', [D]);
    await queryWrite('DELETE FROM crm.decision WHERE decision_id=$1', [D]);
    await queryWrite('DELETE FROM crm.particles WHERE id=$1', [P]);
    await queryWrite('DELETE FROM crm.meta_attr WHERE particle_type=$1', [PTYPE]);
    await queryWrite(`INSERT INTO crm.decision_scenario(scenario_id, stage, trigger, eval_dimensions) VALUES ($1,'TRACE','{}'::jsonb,'[]'::jsonb) ON CONFLICT (scenario_id, tenant_id) DO NOTHING`, [SCN]);
    await queryWrite(
      `INSERT INTO crm.decision (decision_id, scenario_id, trigger_context, involved_entities, conditions_evaluated, disposition, decider_type, rationale, business_tier, state, decided_at)
       VALUES ($1,$2,'{}'::jsonb,$3::jsonb,'[]'::jsonb,'PROCEED','AUTONOMOUS_AGENT','r','NORMAL','REQUIRED', now())`,
      [D, SCN, JSON.stringify([{ id: P, type: PTYPE }])]
    );
    await queryWrite(
      `INSERT INTO crm.particles (id, type, slug, title, payload, updated_at)
       VALUES ($1,$2,'s-trace-1','trace deal 1','{"cust_no":"C1"}'::jsonb, now())`,
      [P, PTYPE]
    );
    await queryWrite(
      `INSERT INTO crm.meta_attr (particle_type, attr_slug, title, attr_type, required, enabled, source_refresh_sla)
       VALUES ($1,'customer_name','客户名','text',true,true,'24 hours')`,
      [PTYPE]
    );
  });

  it('无 token → 401', async () => {
    const res = await app.fetch(`/api/decision/${D}/trace`);
    expect(res.status).toBe(401);
  });

  it('有 token → 200 返回四层溯源链 + 七类根因', async () => {
    const res = await app.fetch(`/api/decision/${D}/trace`, { headers: AUTH });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.trace.decision_id).toBe(D);
    // 四层：J / M / K / 粒子库
    expect(b.trace.layer_j).toHaveProperty('attribution');
    expect(b.trace.layer_m).toHaveProperty('edge_compliance');
    expect(b.trace.layer_k.particles.length).toBe(1);
    // ④ 跳三检：孤儿字段 cust_no → 字段不一致；required customer_name 缺失 → 信息不完整
    expect(b.trace.particle_checks.field_mismatch).toBe(true);
    expect(b.trace.particle_checks.info_incomplete).toBe(true);
    // 边合规 E1-E7 全列（T29-b：7 类投影 + required_edges/required_missing/known 三元组键）
    expect(Object.keys(b.trace.edge_compliance).length).toBe(10);
    expect(b.trace.edge_compliance).toHaveProperty('required_edges');
    expect(b.trace.edge_compliance).toHaveProperty('required_missing');
    expect(b.trace.edge_compliance).toHaveProperty('known');
    // J3 归因条结构
    expect(b.root_cause).toHaveProperty('code');
    expect(b.root_cause).toHaveProperty('layer');
    expect(b.root_cause).toHaveProperty('severity');
    expect(Array.isArray(b.root_cause.evidence)).toBe(true);
  });

  it('不存在的决策 → 404', async () => {
    const res = await app.fetch('/api/decision/e0000000-0000-0000-0000-000000000000/trace', { headers: AUTH });
    expect(res.status).toBe(404);
  });
});
