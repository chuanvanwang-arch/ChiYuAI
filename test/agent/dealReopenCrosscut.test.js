// 横切断言：reopen 三处横切（agentSpec action / GATE_SCENARIOS / Action Registry）
import { describe, it, expect } from 'vitest';
import { agentSpecs } from '../../src/agent/agentSpec.js';
import { GATE_SCENARIOS } from '../../src/monitor/monitorStore.js';

describe('deal reopen 横切', () => {
  it('followup-agent 注册 crm-deal-reopen', () => {
    expect(agentSpecs['followup-agent'].capabilities.actions).toContain('crm-deal-reopen');
  });
  it('GATE_SCENARIOS 含 DEAL_REOPEN', () => {
    expect(GATE_SCENARIOS).toContain('DEAL_REOPEN');
  });
});
