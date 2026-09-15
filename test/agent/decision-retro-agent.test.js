// test/agent/decision-retro-agent.test.js — 第 5 体 decision-retro（决策复盘）装配守卫
// 背景（2026-08-31 用户拍板保留 5 agent，名册 4→5）：decision-retro 当初是「半个 agent」——
//   ① 声明 skillCall `decision-retrospective` 但 actions 未含 → 权限闭包被打破
//   ② `decision-retrospective` 从未在 Action Registry 注册 → 装配断言 4（action_in_registry）失败
//   ③ knowledgeScope.layers 直写 L3，违反 KG 降级契约 → 连触 l3_stated_but_kg_degraded + kg_target_convergence 双闸门
// 本测试锁死这三处，防止第 5 体再次以「声明了但没落地」的形态复活（缺任一环整册装配即失败）。
import { describe, it, expect, beforeAll } from 'vitest';
import { agentSpecs } from '../../src/agent/agentSpec.js';
import { assertAgentAssembly, l3DegradedGuard } from '../../src/agent/agents.js';
import { seedActions } from '../../src/action/seed-actions.js';
import { getAction } from '../../src/action/registry.js';

beforeAll(() => { seedActions(); });

describe('decision-retro（第 5 体）装配契约', () => {
  // 2026-09-02 方案C（决策接入 agent 编排层）：名册 5 体 → 6 体，新增 decision-agent
  // （决策前后双 Agent 的承载体）。本用例锁的是「decision-retro 仍在册」，故改为断言包含关系，
  // 名册整体顺序/数量由 test/agent-spec-4.test.js 独占校验，避免同一事实在多处重复锁死。
  it('decision-retro 在册（名册现 7 体，含方案C 新增的 decision-agent 与 T1 新增的 prospecting）', () => {
    expect(Object.keys(agentSpecs)).toEqual([
      'intake-router', 'quote-engine', 'followup-agent', 'review-gate', 'decision-retro', 'decision-agent', 'prospecting',
    ]);
  });

  it('① 权限闭包：skillCalls ⊆ actions（不得调用未授权 action）', () => {
    const c = agentSpecs['decision-retro'].capabilities;
    for (const call of c.skillCalls) expect(c.actions).toContain(call);
  });

  it('② decision-retrospective 已在 Action Registry 注册且可读可用', async () => {
    const a = getAction('decision-retrospective');
    expect(a).not.toBeNull();
    expect(a.kind).toBe('read');
    // 真实可读：返回决策复盘聚合结构（根因分布 + 应连边缺失率 + 结果校验数）
    const out = await a.handler({ windowDays: 30, limit: 5 }, { tenantId: 'system' });
    expect(typeof out.total).toBe('number');
    expect(typeof out.byCode).toBe('object');
    expect(out).toHaveProperty('edgeMissingCount');
    expect(out).toHaveProperty('edgeMissingRate');
    expect(out).toHaveProperty('verified');
    expect(Array.isArray(out.samples)).toBe(true);
  });

  it('③ KG 降级契约：layers 只到 L2，L3 意图走 kgTarget', () => {
    const c = agentSpecs['decision-retro'].capabilities;
    expect(c.knowledgeScope.layers).toEqual(['L1', 'L2']);
    expect(c.kgTarget).toBe('L3');
    expect(l3DegradedGuard(agentSpecs['decision-retro']).ok).toBe(true);
  });

  it('整册装配全通过（含第 5 体与第 6 体）', async () => {
    const { ok, results, failed } = await assertAgentAssembly();
    expect(ok, `装配失败项: ${JSON.stringify(failed)}`).toBe(true);
    // 每个 agent 各贡献一道 KG 闸门 → 按现役名册长度推导，名册扩展时不误报
    const rosterSize = Object.keys(agentSpecs).length;
    expect(results.filter((r) => r.assertion === 'l3_stated_but_kg_degraded').length).toBe(rosterSize);
    expect(results.filter((r) => r.assertion === 'kg_target_convergence').length).toBe(rosterSize);
  });
});
