// method-dialog-router SKILL 注册契约（对话驱动决策建议 T0）
import { describe, it, expect, beforeAll } from 'vitest';
import { seedSkills } from '../../src/skills/seed.js';
import { getSkill, agentSkillAllowed } from '../../src/skills/registry.js';
import { agentSpecs } from '../../src/agent/agentSpec.js';

beforeAll(() => { seedSkills(); });

describe('method-dialog-router SKILL 注册', () => {
  it('已注册且带 steps[]（缺 steps 执行会崩）', () => {
    const s = getSkill('method-dialog-router');
    expect(s).toBeTruthy();
    expect(Array.isArray(s.steps)).toBe(true);
    expect(s.steps.length).toBeGreaterThan(0);
  });
  it('intake-router 已声明该 SKILL（skillCalls 闭包）', () => {
    expect(agentSkillAllowed('intake-router', 'method-dialog-router')).toBe(true);
    expect(agentSpecs['intake-router'].capabilities.skillCalls).toContain('method-dialog-router');
  });
});
