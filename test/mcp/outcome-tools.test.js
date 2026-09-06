import { describe, it, expect, beforeAll } from 'vitest';
import { buildMcpTools } from '../../src/mcp/tools.js';

describe('T18 J2 反馈回路 MCP 工具', () => {
  let tools;
  beforeAll(() => {
    // buildMcpTools({seed:true}) 内部 seedActions → 注册全部 action（含 T18 三个 outcome 工具）
    tools = buildMcpTools({ seed: true }).tools;
  });

  it('暴露 3 个 outcome 反馈回路工具', () => {
    const names = tools.map((t) => t.name);
    expect(names).toContain('crm_decision_outcome_query');
    expect(names).toContain('crm_gate_outcome');
    expect(names).toContain('crm_decision_outcome_write');
  });

  it('写工具为 write kind 且携带两阶段确认协议字段', () => {
    const w = tools.find((t) => t.name === 'crm_decision_outcome_write');
    expect(w.kind).toBe('write');
    expect(w.inputSchema).toHaveProperty('decision_id');
    expect(w.inputSchema).toHaveProperty('outcome_type');
    expect(w.inputSchema).toHaveProperty('confirm_token'); // gateway 两阶段
  });
});
