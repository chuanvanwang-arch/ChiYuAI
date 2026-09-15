// test/agent/prospectingAgent.test.js — prospecting agent 装配闭包（T1 注册 + T5 收敛）
// 设计输入：docs/2026-09-14-prospecting-module-design.md §A.3 + 实施计划 T1
// T1 注释 ③⑥（prospecting-* Action 在 T5 注册，中间态不允许装配断言通过）；
// T5 完成后启用 ③⑥ —— 届时 assertAgentAssembly 全绿。
import { describe, it, expect, beforeAll } from 'vitest';
import { agentSpecs } from '../../src/agent/agentSpec.js';
import { assertAgentAssembly } from '../../src/agent/agents.js';
import { seedActions } from '../../src/action/seed-actions.js';
import { seedDiscoveryActions } from '../../src/action/discoveryActions.js';
import { seedSkills } from '../../src/skills/seed.js';
import { getAction } from '../../src/action/registry.js';
import { CONTRACT_IDS } from '../../src/agent/contractIds.js';
import { getSkill } from '../../src/skills/registry.js';

beforeAll(() => { seedActions(); seedDiscoveryActions(); seedSkills(); });

const NAMES = ['prospecting-search', 'prospecting-select', 'prospecting-confirm'];

describe('prospecting agent 装配闭包（T1）', () => {
  it('① agentSpec 存在且六段式完整', () => {
    const spec = agentSpecs['prospecting'];
    expect(spec).toBeDefined();
    expect(spec.identity.derivedFrom).toBe('taskFlow:crm-prospecting');
    expect(spec.capabilities.actions).toContain('data-particle-read');
  });
  it('② skillCalls ⊆ actions（硬闭包）', () => {
    const spec = agentSpecs['prospecting'];
    for (const c of spec.capabilities.skillCalls) expect(spec.capabilities.actions, c).toContain(c);
  });
  it('③ 三个 Action 已在 registry（agentTool）', () => {
    for (const n of NAMES) expect(getAction(n), n).not.toBeNull();
  });
  it('④ 契约键已登记', () => {
    expect(CONTRACT_IDS['prospecting']).toBe('ct-prospecting');
  });
  it('⑤ SKILL data-particle-read 已注册（契约块依赖）', () => {
    expect(getSkill('data-particle-read')).not.toBeNull();
  });
  it('⑥ assertAgentAssembly 通过（含新 agent）', async () => {
    const r = await assertAgentAssembly();   // ⚠ async 必须 await
    expect(r.ok).toBe(true);
    expect(r.failed).toEqual([]);
  });
});
