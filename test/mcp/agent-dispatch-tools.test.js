// test/mcp/agent-dispatch-tools.test.js — agent-dispatch MCP 暴露契约测试
// 需求来源：2026-08-30 决策 1A（用户批准）——今天新增的 POST /api/agent/dispatch（需求→调度）
//   是纯 HTTP 路由（src/http/routes.js:455），未注册为 Action，故 MCP 未暴露任务调度能力。
//   本测试锁定修复契约：agent-dispatch 注册为 write Action（agent-* 命名空间），经 buildMcpTools
//   自动成为 MCP 工具，走 gateway 两阶段 confirm（第0闸 + confirm_token）。
import { describe, it, expect, beforeAll } from 'vitest';
import { buildMcpTools } from '../../src/mcp/tools.js';

describe('agent-dispatch MCP 工具契约（决策 1A）', () => {
  let tools;
  beforeAll(() => {
    tools = buildMcpTools({ seed: true }).tools;
  });

  const find = (n) => tools.find((t) => t.name === n);

  it('暴露 agent-dispatch 工具（MCP 工具集含任务调度）', () => {
    const t = find('agent-dispatch');
    expect(t).toBeTruthy();
  });

  it('agent-dispatch 为 write kind（业务写，非读直连）', () => {
    const t = find('agent-dispatch');
    expect(t.kind).toBe('write');
  });

  it('agent-dispatch 入参含 requirement（自然语言需求）', () => {
    const t = find('agent-dispatch');
    expect(t.inputSchema).toHaveProperty('requirement');
  });

  it('agent-dispatch 携带 MCP 两阶段协议字段（confirm_token/choice/decision_id）', () => {
    const t = find('agent-dispatch');
    expect(t.inputSchema).toHaveProperty('confirm_token');
    expect(t.inputSchema).toHaveProperty('choice');
    expect(t.inputSchema).toHaveProperty('decision_id');
  });

  it('agent-dispatch description 含「两阶段」提示（gateway 确认契约可发现性）', () => {
    const t = find('agent-dispatch');
    expect(t.description).toContain('两阶段');
  });
});