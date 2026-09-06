// test/g3-knowledge-scope.test.js — G3 修复验证
// 背景：review-gate 曾声明 L3，但 KG 全局降级（kg_coverage_stage2），契约校验层（contractService.js:36 / contractParser.js:117）
// 仅比对声明集合、不感知降级态，导致 L3 检索缺失时静默误判。G3 收敛声明 + 加降级一致性守护。
import { describe, it, expect } from 'vitest';
import { agentSpecs } from '../src/agent/agentSpec.js';
import { assertAgentAssembly, l3DegradedGuard } from '../src/agent/agents.js';

describe('G3 知识范围降级一致性', () => {
  it('review-gate 收敛后 knowledgeScope.layers 不含 L3', () => {
    const layers = agentSpecs['review-gate'].capabilities.knowledgeScope.layers;
    expect(layers).not.toContain('L3');
    expect(layers).toEqual(['L1', 'L2']);
  });

  // 2026-08-31：名册由 4 体 → 5 体（新增 decision-retro 决策复盘，用户拍板保留）
  it('现 5 体无"声明 L3 但 KG 降级"组合', () => {
    for (const [id, spec] of Object.entries(agentSpecs)) {
      const g = l3DegradedGuard(spec);
      expect(g.ok, `${id} 不应声明 L3 而 KG 降级`).toBe(true);
    }
  });

  it('decision-retro 同守降级契约：layers 只到 L2，L3 意图走 kgTarget', () => {
    const c = agentSpecs['decision-retro'].capabilities;
    expect(c.knowledgeScope.layers).toEqual(['L1', 'L2']);
    expect(c.kgTarget).toBe('L3'); // KG 就绪后升级目标（与 review-gate 同范式）
  });

  it('l3DegradedGuard 对声明 L3 的 spec 返回 ok:false', () => {
    const bad = { capabilities: { knowledgeScope: { layers: ['L1', 'L2', 'L3'] } } };
    const g = l3DegradedGuard(bad);
    expect(g.ok).toBe(false);
    expect(g.detail).toBe('声明L3但KG降级');
  });

  it('assertAgentAssembly 对异常组合（临时注入 L3）返回 ok:false，且还原不污染', async () => {
    const original = agentSpecs['review-gate'];
    const saved = JSON.parse(JSON.stringify(original));
    agentSpecs['review-gate'] = {
      ...original,
      capabilities: { ...original.capabilities, knowledgeScope: { layers: ['L1', 'L2', 'L3'], maxHops: 4 } },
    };
    try {
      const { results } = await assertAgentAssembly();
      const guard = results.find(r => r.agent === 'review-gate' && r.assertion === 'l3_stated_but_kg_degraded');
      expect(guard).toBeDefined();
      expect(guard.ok).toBe(false);
    } finally {
      agentSpecs['review-gate'] = saved; // 还原，避免污染其它测试
    }
    // 还原后守护应恢复 ok
    expect(l3DegradedGuard(agentSpecs['review-gate']).ok).toBe(true);
  });

  it('assertAgentAssembly 全量：l3_stated_but_kg_degraded 断言存在且全 ok', async () => {
    const { results, ok } = await assertAgentAssembly();
    const guards = results.filter(r => r.assertion === 'l3_stated_but_kg_degraded');
    // 按现役名册长度推导而非写死数字：本用例意图是「每个 agent 都有这道闸门」。
    // 名册由 5 体 → 6 体（2026-09-02 方案C 新增 decision-agent）时，写死 5 会误报失败。
    expect(guards.length).toBe(Object.keys(agentSpecs).length); // 6 体（含 decision-retro + decision-agent）
    expect(guards.every(g => g.ok)).toBe(true);
    expect(ok).toBe(true);
  });
});
