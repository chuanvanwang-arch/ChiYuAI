import { describe, it, expect, beforeAll } from 'vitest';
import { buildMcpTools } from '../../src/mcp/tools.js';

describe('T25/T26/T27 溯源与反馈 MCP 工具', () => {
  let tools;
  beforeAll(() => {
    tools = buildMcpTools({ seed: true }).tools;
  });

  it('暴露 3 个溯源/反馈工具', () => {
    const names = tools.map((t) => t.name);
    expect(names).toContain('crm_decision_trace');
    expect(names).toContain('crm_decision_root_cause');
    expect(names).toContain('crm_decision_outcome_set');
  });

  it('trace / root_cause 为 read kind，含 decision_id 入参', () => {
    const t = tools.find((x) => x.name === 'crm_decision_trace');
    const rc = tools.find((x) => x.name === 'crm_decision_root_cause');
    expect(t.kind).toBe('read');
    expect(t.inputSchema).toHaveProperty('decision_id');
    expect(rc.kind).toBe('read');
    expect(rc.inputSchema).toHaveProperty('decision_id');
  });

  it('outcome_set 为 write kind 且经第0闸（两阶段确认）', () => {
    const w = tools.find((x) => x.name === 'crm_decision_outcome_set');
    expect(w.kind).toBe('write');
    expect(w.inputSchema).toHaveProperty('decision_id');
    expect(w.inputSchema).toHaveProperty('feedback');
  });

  it('暴露 §7 crm_root_cause_list（按根因类别/层/严重度聚合的 read 工具）', () => {
    const l = tools.find((x) => x.name === 'crm_root_cause_list');
    expect(l).toBeDefined();
    expect(l.kind).toBe('read');
    expect(l.inputSchema).toHaveProperty('window_days');
    expect(l.inputSchema).toHaveProperty('code');
  });
});
