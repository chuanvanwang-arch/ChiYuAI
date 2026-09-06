// test/http/graph-edges.test.js — T11 GET /api/graph/edges 路由测试（7 类边权威查询 + 鉴权）
import { describe, it, expect, beforeEach } from 'vitest';
import { queryWrite, query as q } from '../../src/db.js';
import { createApp } from '../../src/http/server.js';
import { issueToken } from '../../src/http/auth.js';
import { linkDecisions } from '../../src/decision/relation.js';

const app = createApp();
const token = issueToken({ username: 't-graph', role: 'sales', display_name: '图测试' });
const auth = { headers: { Authorization: `Bearer ${token}` } };

const SID = 'GRAPH_EDGES_SCENARIO';
const A = 'aaaa1111-0000-0000-0000-0000000000a1';
const B = 'bbbb2222-0000-0000-0000-0000000000b2';

beforeEach(async () => {
  await queryWrite('TRUNCATE crm.decision_relation RESTART IDENTITY CASCADE');
  await queryWrite(
    `INSERT INTO crm.decision_scenario(scenario_id, stage, trigger, eval_dimensions, required_dims)
     VALUES ($1,'ACTIVE','{}'::jsonb,'[]'::jsonb,'[]'::jsonb) ON CONFLICT (scenario_id, tenant_id) DO NOTHING`,
    [SID]
  );
  for (const id of [A, B]) {
    await queryWrite(
      `INSERT INTO crm.decision
         (decision_id, scenario_id, trigger_context, involved_entities, conditions_evaluated,
          disposition, decider_type, rationale, business_tier, state)
       VALUES ($1,$2,'{}'::jsonb,'[]'::jsonb,'[]'::jsonb,'PROCEED','AUTONOMOUS_AGENT','r','NORMAL','REQUIRED')
       ON CONFLICT(decision_id) DO NOTHING`,
      [id, SID]
    );
  }
  await linkDecisions(A, B, 'DECIDED_ON', { source: 'test' });
  await linkDecisions(B, A, 'REFERENCED_PRECEDENT', { source: 'test' });
});

describe('T11 GET /api/graph/edges', () => {
  it('未鉴权 → 401', async () => {
    const res = await app.fetch(`/api/graph/edges?entityId=${A}`);
    expect(res.status).toBe(401);
  });

  it('返回该实体的 7 类 typed 边（含 rel_type/serves_dimension）', async () => {
    const res = await app.fetch(`/api/graph/edges?entityId=${A}`, auth);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entity_id).toBe(A);
    expect(Array.isArray(body.edges)).toBe(true);
    // A → B (DECIDED_ON) 出边，B → A (REFERENCED_PRECEDENT) 入边，direction=both 都返回
    expect(body.edges).toHaveLength(2);
    const relTypes = body.edges.map((e) => e.rel_type).sort();
    expect(relTypes).toEqual(['DECIDED_ON', 'REFERENCED_PRECEDENT']);
    for (const e of body.edges) {
      expect(typeof e.serves_dimension).toBe('string');
      expect(e).toHaveProperty('from_id');
      expect(e).toHaveProperty('to_id');
    }
  });

  it('direction=out 仅返回出边', async () => {
    const res = await app.fetch(`/api/graph/edges?entityId=${A}&direction=out`, auth);
    const body = await res.json();
    expect(body.edges.map((e) => e.rel_type)).toEqual(['DECIDED_ON']);
  });

  it('缺 entityId → 400', async () => {
    const res = await app.fetch('/api/graph/edges', auth);
    expect(res.status).toBe(400);
  });

  it('T12 vendor 离线资源可访问（/portal/vendor/cytoscape.min.js）', async () => {
    const res = await app.fetch('/portal/vendor/cytoscape.min.js');
    expect(res.status).toBe(200);
    const txt = await res.text();
    expect(txt.length).toBeGreaterThan(100000); // cytoscape.min.js ≈ 373KB
    expect(txt.slice(0, 200)).toContain('Cytoscape');
  });
});
