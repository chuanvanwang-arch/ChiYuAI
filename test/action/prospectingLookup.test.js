// test/action/prospectingLookup.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import { getAction } from '../../src/action/registry.js';
import { seedActions } from '../../src/action/seed-actions.js';
import { agentSpecs } from '../../src/agent/agentSpec.js';
import { assertAgentAssembly } from '../../src/agent/agents.js';
import { buildMcpTools } from '../../src/mcp/tools.js';

beforeAll(() => { seedActions(); });

describe('prospecting-lookup action', () => {
  it('已注册且为 read（直接 dispatch，无决策闸）', () => {
    const a = getAction('prospecting-lookup');
    expect(a).not.toBeNull();
    expect(a.kind).toBe('read');
    expect(a.namespace).toBe('prospecting');
    expect(a.agentTool).toBe(true);
  });

  it('装配闭包：prospecting-lookup ⊆ prospecting.actions ⊆ skillCalls', () => {
    const spec = agentSpecs['prospecting'];
    expect(spec.capabilities.actions).toContain('prospecting-lookup');
    expect(spec.capabilities.skillCalls).toContain('prospecting-lookup');
    expect(getAction('prospecting-lookup')).not.toBeNull();
  });

  it('assertAgentAssembly 通过（含 prospecting-lookup 闭包）', async () => {
    const r = await assertAgentAssembly();
    expect(r.ok).toBe(true);
    const fails = (r.results || []).filter((x) => !x.ok && (x.detail || '').includes('prospecting-lookup'));
    expect(fails).toEqual([]);
  });

  it('MCP 暴露面包含 prospecting-lookup 且含 protocol 字段', () => {
    const { tools } = buildMcpTools({ seed: false });
    const t = tools.find((x) => x.name === 'prospecting-lookup');
    expect(t).toBeDefined();
    expect(t.inputSchema).toHaveProperty('provider');
    expect(t.inputSchema).toHaveProperty('kind');
    expect(t.inputSchema).toHaveProperty('payload');
  });

  it('handler 调路由 + 暂存草稿，零 CRM 粒子写', async () => {
    let routed = null, drafted = null;
    const a = getAction('prospecting-lookup');
    const res = await a.handler({ provider: 'anysite', kind: 'prospect', payload: { icp: {} } },
      { tenantId: 't1' },
      { routeExternalLookup: async (p) => { routed = p; return { provider: p.provider, kind: p.kind, items: [{ name: 'Acme' }] }; },
        insertDraft: async (d) => { drafted = d; return { draft_id: 'd-1' }; } });
    expect(routed.provider).toBe('anysite');
    expect(drafted.tenantId).toBe('t1');
    expect(drafted.items).toEqual([{ name: 'Acme' }]);
    expect(res.draft_id).toBe('d-1');
    expect(res.count).toBe(1);
  });
});
