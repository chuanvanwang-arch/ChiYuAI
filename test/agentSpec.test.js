// test/agentSpec.test.js
import { describe, it, expect } from 'vitest';
import { query } from '../src/db.js';
import { agentSpecs } from '../src/agent/agentSpec.js';
import { assertAgentAssembly } from '../src/agent/agents.js';

describe('Agent Spec 装配', () => {
  // 2026-08-31 用户拍板保留第 5 体（decision-retro 决策复盘）
  it('5 Agent 注册（intake-router/quote-engine/followup-agent/review-gate/decision-retro）', () => {
    const names = Object.keys(agentSpecs);
    expect(names).toEqual(expect.arrayContaining(['intake-router', 'quote-engine', 'followup-agent', 'review-gate', 'decision-retro']));
  });

  it('权限闭包：⋃(SKILL.calls) ⊆ capabilities.actions', () => {
    for (const spec of Object.values(agentSpecs)) {
      const calls = spec.capabilities.skillCalls || [];
      const allowed = spec.capabilities.actions;
      for (const c of calls) {
        expect(allowed).toContain(c);
      }
    }
  });

  it('六条装配断言全通过（KB 就绪用降级语义）', async () => {
    const result = await assertAgentAssembly();
    expect(result.ok).toBe(true);
  });
});
