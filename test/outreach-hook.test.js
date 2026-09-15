// test/outreach-hook.test.js — P1-1a 三处装配 + P1-1b 钩子生成（TDD）
import { describe, it, expect, beforeAll } from 'vitest';
import { getSkill } from '../src/skills/registry.js';
import { seedSkills } from '../src/skills/seed.js';
import { seedActions } from '../src/action/seed-actions.js';
import { getAction } from '../src/action/registry.js';
import { agentSpecs } from '../src/agent/agentSpec.js';

beforeAll(() => {
  seedSkills();
  seedActions();
});

describe('method-outreach-hook 三处装配', () => {
  it('SKILL 已登记（seed.js registry 元数据）', () => {
    const s = getSkill('method-outreach-hook');
    expect(s).not.toBeNull();
    expect(s.slug).toBe('method-outreach-hook');
  });

  it('Action Registry 已注册 method-outreach-hook（seed-actions.js method-* 数组）', () => {
    const a = getAction('method-outreach-hook');
    expect(a).not.toBeNull();
    expect(a.kind).toBe('read'); // 方法论壳：只读知识，零写（第 0 闸由壳内步骤各自过）
    expect(a.namespace).toBe('method');
  });

  it('承载 agent 已声明 actions+skillCalls（agentSpec.js capabilities 闭包）', () => {
    // 三处同改（装配铁律）：skillCalls ⊆ actions ⊆ Action Registry
    const host = Object.values(agentSpecs).find(
      (s) => s.capabilities?.actions?.includes('method-outreach-hook')
    );
    expect(host, '至少一个 agent 声明 method-outreach-hook').toBeTruthy();
    expect(host.capabilities.skillCalls).toContain('method-outreach-hook');
  });
});
