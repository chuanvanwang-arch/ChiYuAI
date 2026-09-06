// test/monitor-graph.test.js — P7 决策链监控端点（trace / impact / audit）
import { describe, it, expect, beforeEach } from 'vitest';
import { query } from '../src/db.js';
import { ensureGraph, isAvailable, addDecision, addEdge } from '../src/decision/ageGraph.js';
import { createDecision } from '../src/decision/decisionRepo.js';
import { createApp } from '../src/http/server.js';
import { issueToken } from '../src/http/auth.js';

const app = createApp();
const AUTH = { authorization: `Bearer ${issueToken({ username: 't-admin', role: 'admin', display_name: '测试管理员' })}` };

beforeEach(async () => {
  await query('TRUNCATE crm.decision, crm.decision_provenance, crm.decision_precedent_rel, crm.decision_event, crm.memory_log RESTART IDENTITY CASCADE');
  await ensureGraph();
  if (isAvailable()) {
    await addDecision({ decision_id: 'x', scenario_id: 'S', disposition: 'APPROVE', business_tier: 'NORMAL', state: 'AUTONOMOUS', rationale: 'r' });
    await addDecision({ decision_id: 'y', scenario_id: 'S', disposition: 'APPROVE', business_tier: 'NORMAL', state: 'AUTONOMOUS', rationale: 'r' });
    await addEdge('REFERENCED_PRECEDENT', 'y', 'x', {});
  }
});

describe('P7 监控图端点', () => {
  it('GET /api/monitor/trace/y 上游链含 x', async () => {
    if (!isAvailable()) return;
    const res = await app.fetch('/api/monitor/trace/y', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.chain.map((n) => n.decision_id)).toContain('x');
  });

  it('GET /api/monitor/impact/y 返回下游图结构', async () => {
    if (!isAvailable()) return;
    const res = await app.fetch('/api/monitor/impact/y', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.nodes)).toBe(true);
  });

  it('GET /api/monitor/audit?decision_id= 返回审计（含链状态）', async () => {
    const d = await createDecision({
      scenario_id: 'LEAD_FOLLOW_UP', trigger_context: {}, conditions_evaluated: [],
      disposition: 'APPROVE', decider_type: 'AUTONOMOUS_AGENT', rationale: 'r',
      business_tier: 'NORMAL', state: 'AUTONOMOUS',
    });
    const res = await app.fetch(`/api/monitor/audit?decision_id=${d.decision_id}`, { headers: AUTH });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.chainStatus).toBe('OK');
  });
});
