import { describe, it, expect } from 'vitest';
import { buildMcpTools } from '../../src/mcp/tools.js';

describe('MCP 管理工具面', () => {
  it('tools 含 10 个新增工具（my-todo / tune / admin-* / crm-memory-read）', () => {
    const { tools } = buildMcpTools();
    const names = tools.map((t) => t.name);
    for (const n of ['my-todo-query', 'my-todo-approve', 'my-todo-reject', 'tune-approve', 'tune-reject',
      'admin-tenant-usage', 'admin-agent-summary', 'admin-decision-health', 'admin-param-diagnosis', 'crm-memory-read']) {
      expect(names).toContain(n);
    }
  });

  it('写工具 inputSchema 含 confirm_token/choice（两阶段）', () => {
    const { tools } = buildMcpTools();
    const appr = tools.find((t) => t.name === 'my-todo-approve');
    expect(appr.kind).toBe('write');
    const schema = appr.inputSchema;
    expect(schema.confirm_token).toBeDefined();
    expect(schema.choice).toBeDefined();
  });
});
