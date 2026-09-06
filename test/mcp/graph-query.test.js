// test/mcp/graph-query.test.js — P8 决策图查询 MCP 工具（crm_graph_query）注册 + RBAC 数据范围过滤
// 设计输入：docs/superpowers/specs/2026-08-26-age-semantica-program-design.md P8（验收：MCP 调用 graph_query 返回受限范围）
import { describe, it, expect, beforeEach } from 'vitest';
import { query } from '../../src/db.js';
import { buildMcpTools } from '../../src/mcp/tools.js';
import { actionExecutor } from '../../src/action/executor.js';
import { seedActions } from '../../src/action/seed-actions.js';
import { ensureGraph } from '../../src/decision/ageGraph.js';
import { createDecision } from '../../src/decision/decisionRepo.js';

beforeEach(async () => {
  await query('TRUNCATE crm.decision, crm.decision_relation, crm.decision_event, crm.memory_log RESTART IDENTITY CASCADE');
  seedActions();
  await ensureGraph();
});

describe('P8 crm_graph_query MCP 工具', () => {
  it('buildMcpTools 暴露 crm_graph_query（read kind）', () => {
    const tools = buildMcpTools({ seed: true }).tools;
    const t = tools.find((x) => x.name === 'crm_graph_query');
    expect(t).toBeTruthy();
    expect(t.kind).toBe('read');
    expect(t.inputSchema).toHaveProperty('query_type');
    expect(t.inputSchema).toHaveProperty('decision_id');
  });

  it('manager 角色经 executor 读 trace 返回受限范围数据（ok + upstream/downstream）', async () => {
    // 建一个决策 + 先例链，供 trace 返回有内容
    const d1 = await createDecision({ scenario_id: 'LEAD_FOLLOW_UP', trigger_context: {}, conditions_evaluated: [], disposition: 'APPROVE', decider_type: 'AUTONOMOUS_AGENT', rationale: 'r', business_tier: 'NORMAL', state: 'AUTONOMOUS' });
    const d2 = await createDecision({ scenario_id: 'OPP_QUALIFY', trigger_context: {}, conditions_evaluated: [], disposition: 'APPROVE', decider_type: 'AUTONOMOUS_AGENT', rationale: 'r', business_tier: 'NORMAL', state: 'AUTONOMOUS', referenced_precedents: [d1.decision_id] });
    // 角色映射：actor=mgr1 需是 CRM_PERSON 且 role_tags[0]='manager'
    await query(`INSERT INTO crm.particles (type, slug, title, state, payload, tenant_id) VALUES ('CRM_PERSON','mgr1','M','active','{"role_tags":["manager"]}','system') ON CONFLICT DO NOTHING`);
    const r = await actionExecutor.dispatch('crm_graph_query', { query_type: 'trace', decision_id: d2.decision_id }, { tenantId: 'system', actor: 'mgr1' });
    expect(r.ok).toBe(true);
    expect(r.data.query_type).toBe('trace');
    expect(Array.isArray(r.data.upstream)).toBe(true);
    expect(Array.isArray(r.data.downstream)).toBe(true);
    // 返回受限范围：节点仅业务字段（decision_id/state/disposition），无内部 action/agent 名
    for (const n of [...r.data.upstream, ...r.data.downstream]) {
      expect(n).not.toHaveProperty('action');
      expect(n).not.toHaveProperty('agent');
    }
  });

  it('sales 角色越权 → 第1.5闸 permission_denied（受限范围，不返回决策网）', async () => {
    // sales 不在 rbac_roles，actor=unknown 时 actorRole 返回 null → 同样拒绝（受限）
    const r = await actionExecutor.dispatch('crm_graph_query', { query_type: 'trace', decision_id: 'any' }, { tenantId: 'system', actor: 'unknown-sales' });
    expect(r.ok).toBe(false);
    expect(r.gate).toBe('permission_denied');
  });
});
