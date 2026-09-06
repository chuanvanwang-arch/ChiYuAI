// test/agent/decisionAgentWiring.test.js — Task 1 装配断言
import { describe, test, expect, beforeAll } from 'vitest';
import { agentSpecs } from '../../src/agent/agentSpec.js';
import { getSkill } from '../../src/skills/registry.js';
import { seedSkills } from '../../src/skills/seed.js';

describe('decision-agent wiring', () => {
  beforeAll(() => seedSkills());
  test('decision-agent 存在于名册且权限闭包成立', () => {
    const spec = agentSpecs['decision-agent'];
    expect(spec).toBeTruthy();
    for (const c of spec.capabilities.skillCalls) {
      expect(spec.capabilities.actions).toContain(c); // skillCalls ⊆ actions
    }
  });
  test('两个决策 SKILL 已注册', () => {
    expect(getSkill('method-decision-enrich')).toBeTruthy();
    expect(getSkill('method-decision-execute')).toBeTruthy();
  });
});
