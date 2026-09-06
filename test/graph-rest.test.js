// test/graph-rest.test.js — P8 决策图查询 REST 面（neighbors / trace / impact / provenance）
import { describe, it, expect, beforeEach } from 'vitest';
import { query } from '../src/db.js';
import { ensureGraph, isAvailable, addDecision, addEdge } from '../src/decision/ageGraph.js';
import { createDecision } from '../src/decision/decisionRepo.js';
import { createApp } from '../src/http/server.js';
import { issueToken } from '../src/http/auth.js';

const app = createApp();
// T11：graph/* 已补全鉴权（requireMe）；route 仅校验 token 签名，不查 crm_users，直接签发 Bearer。
const token = issueToken({ username: 't-viewer', role: 'sales', display_name: '测试查看者' });
const auth = { headers: { Authorization: `Bearer ${token}` } };

const P1 = '11111111-1111-1111-1111-111111111111';
const P2 = '22222222-2222-2222-2222-222222222222';

beforeEach(async () => {
  await query('TRUNCATE crm.particles, crm.edges, crm.decision, crm.decision_provenance, crm.decision_precedent_rel, crm.decision_event, crm.memory_log RESTART IDENTITY CASCADE');
  await ensureGraph();
  // 实体级邻居网络：account → key_contact → contact
  await query(
    `INSERT INTO crm.particles (id, tenant_id, type, slug, title, state, payload) VALUES
       ($1,'system','CRM_ACCOUNT','acc','Acme','ACTIVE','{"name":"Acme"}'),
       ($2,'system','CRM_CONTACT','con','Bob','ACTIVE','{"name":"Bob"}')`,
    [P1, P2]);
  await query(
    `INSERT INTO crm.edges (tenant_id, source_type, source_id, edge_type, target_type, target_id, meta)
     VALUES ('system','CRM_ACCOUNT',$1,'key_contact','CRM_CONTACT',$2,'{"relation_confidence":0.9}')`,
    [P1, P2]);
  // 决策级因果链：y 引用 x 为先例
  if (isAvailable()) {
    await addDecision({ decision_id: 'x', scenario_id: 'S', disposition: 'APPROVE', business_tier: 'NORMAL', state: 'AUTONOMOUS', rationale: 'r' });
    await addDecision({ decision_id: 'y', scenario_id: 'S', disposition: 'APPROVE', business_tier: 'NORMAL', state: 'AUTONOMOUS', rationale: 'r' });
    await addEdge('REFERENCED_PRECEDENT', 'y', 'x', {});
  }
});

describe('P8 决策图 REST 面', () => {
  it('GET /api/graph/* 未鉴权 → 401（T11 补全鉴权）', async () => {
    const res = await app.fetch(`/api/graph/neighbors?entityId=${P1}`);
    expect(res.status).toBe(401);
  });

  it('GET /api/graph/neighbors 返回边+邻居', async () => {
    const res = await app.fetch(`/api/graph/neighbors?entityId=${P1}`, auth);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.edges)).toBe(true);
    expect(Array.isArray(body.neighbors)).toBe(true);
    expect(body.edges.length).toBeGreaterThan(0);
    expect(body.neighbors.map((n) => n.id).filter(Boolean)).toContain(P2);
  });

  it('GET /api/graph/neighbors 缺 entityId → 400', async () => {
    const res = await app.fetch('/api/graph/neighbors', auth);
    expect(res.status).toBe(400);
  });

  it('GET /api/graph/trace 返回上/下游链', async () => {
    if (!isAvailable()) return;
    const res = await app.fetch('/api/graph/trace?decisionId=y', auth);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.upstream)).toBe(true);
    expect(Array.isArray(body.downstream)).toBe(true);
    expect(body.upstream.map((n) => n.decision_id)).toContain('x');
    expect(Array.isArray(body.typedEdges)).toBe(true); // T11 附加 7 类 typed 边
  });

  it('GET /api/graph/impact 返回下游图结构', async () => {
    if (!isAvailable()) return;
    const res = await app.fetch('/api/graph/impact?decisionId=y', auth);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.nodes)).toBe(true);
  });

  it('GET /api/graph/provenance 返回 PROV-O 审计（含链状态）', async () => {
    const d = await createDecision({
      scenario_id: 'LEAD_FOLLOW_UP', trigger_context: {}, conditions_evaluated: [],
      disposition: 'APPROVE', decider_type: 'AUTONOMOUS_AGENT', rationale: 'r',
      business_tier: 'NORMAL', state: 'AUTONOMOUS',
    });
    const res = await app.fetch(`/api/graph/provenance?decision_id=${d.decision_id}`, auth);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.chainStatus).toBe('OK');
  });
});
