// test/mcp/agent-dispatch-gateway.test.js — agent-dispatch 经 MCP gateway 两阶段行为契约
// 需求来源：2026-08-30 决策 1A（用户批准）。注册 agent-dispatch 后，MCP 写通道必须
//   仍遵守第 0 闸：无 decision_id → gate=decision_required（无决策不写）；
//   带 decision_id → 发 confirm_token（两阶段表单），phase2 choice=1 才真正执行。
import { describe, it, expect, beforeAll } from 'vitest';
import { mcpWritePhase1 } from '../../src/mcp/gateway.js';
import { seedActions } from '../../src/action/seed-actions.js';
import { issueToken } from '../../src/mcp/issueToken.js';

describe('agent-dispatch MCP gateway 两阶段（第0闸 + confirm）', () => {
  beforeAll(() => { seedActions(); });

  it('无 decision_id → 第0闸拦截（gate=decision_required，无决策不写）', async () => {
    const actor = `gw_${Math.random().toString(36).slice(2, 10)}`;
    const { tokenPlain } = await issueToken({ actor, roleTag: 'sales', scopes: {} });
    const r = await mcpWritePhase1('agent-dispatch', { api_token: tokenPlain, requirement: '跟进华南区线索' }, {});
    expect(r.ok).toBe(false);
    expect(r.gate).toBe('decision_required');
  });

  it('带 decision_id → 返回两阶段表单（confirm_token + action=agent-dispatch + role 透传）', async () => {
    const actor = `gw_${Math.random().toString(36).slice(2, 10)}`;
    const { tokenPlain } = await issueToken({ actor, roleTag: 'manager', scopes: {} });
    const r = await mcpWritePhase1('agent-dispatch', { api_token: tokenPlain, requirement: '跟进华南区线索', decision_id: 'DEC-GW-DSP-002' }, {});
    expect(r.ok).toBe(true);
    expect(r.confirm_token).toBeTruthy();
    expect(r.form.action).toBe('agent-dispatch');
    expect(r.form.role).toBe('manager');
  });
});