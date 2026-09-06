// test/agent/g3-guardian.test.js — G3 守护（kg_target / L3 收敛闸门）落地验证
// 背景：agents.js 此前仅有 l3DegradedGuard（声明层守护），缺运行时「kg_target / L3 收敛闸门」。
// 本测试覆盖：运行时 knowledge_scope.layers 收敛到 KG 可服务范围（kg_target 天花板约束）、
// L3 收敛闸门触发/拦截、resolveRuntimeKgLayers 强制注入、assertAgentAssembly 新增断言。
import { describe, it, expect } from 'vitest';
import { agentSpecs } from '../../src/agent/agentSpec.js';
import {
  assertAgentAssembly,
  kgConvergenceGate,
  resolveRuntimeKgLayers,
} from '../../src/agent/agents.js';

describe('G3 L3 收敛闸门 · kg_target 收敛判定', () => {
  it('review-gate(kgTarget=L3) 运行时收敛到 [L1,L2]，不触发闸门', () => {
    const spec = agentSpecs['review-gate'];
    const g = kgConvergenceGate(spec);
    expect(g.target).toBe('L3');
    expect(g.declared).toEqual(['L1', 'L2']);
    expect(g.effective).toEqual(['L1', 'L2']);
    expect(g.dropped).toEqual([]);
    expect(g.triggered).toBe(false);
    expect(g.ok).toBe(true);
    expect(resolveRuntimeKgLayers(spec)).toEqual(['L1', 'L2']);
  });

  it('kgTarget 天花板约束：kgTarget=L2 时即便声明 L3 也被收敛掉', () => {
    const spec = {
      capabilities: { kgTarget: 'L2', knowledgeScope: { layers: ['L1', 'L2', 'L3'] } },
    };
    const g = kgConvergenceGate(spec);
    expect(g.effective).toEqual(['L1', 'L2']);
    expect(g.dropped).toEqual(['L3']);
    expect(g.triggered).toBe(true);
  });

  it('L3 收敛闸门触发：声明 L3 但 KG 降级 → ok:false 且 detail 含收敛说明', () => {
    const spec = {
      capabilities: { kgTarget: 'L3', knowledgeScope: { layers: ['L1', 'L2', 'L3'] } },
    };
    const g = kgConvergenceGate(spec);
    expect(g.triggered).toBe(true);
    expect(g.dropped).toEqual(['L3']);
    expect(g.ok).toBe(false);
    expect(g.detail).toContain('L3收敛闸门');
    expect(g.detail).toContain('kg_target=L3');
  });

  it('无 kgTarget 时天花板放开到最高层，但降级态仍收敛掉 L3/L4', () => {
    const g = kgConvergenceGate({ capabilities: { knowledgeScope: { layers: ['L1', 'L2', 'L3', 'L4'] } } });
    expect(g.effective).toEqual(['L1', 'L2']);
    expect(g.dropped).toEqual(['L3', 'L4']);
    expect(g.ok).toBe(false);
  });
});

describe('G3 守护 · assertAgentAssembly 集成', () => {
  // 2026-08-31：名册由 4 体 → 5 体（新增 decision-retro 决策复盘，用户拍板保留）
  // 2026-09-02：5 体 → 6 体（新增 decision-agent 决策接线，方案C）。
  //   数量断言改为「按名册长度推导」而非写死数字——本用例的意图是「每个 agent 都有这道闸门」，
  //   而非「恰好 N 个」，写死会在每次名册扩展时误报失败。
  it('全量：kg_target_convergence 断言存在且对现役名册全 ok（无 L3 声明）', async () => {
    const { results, ok } = await assertAgentAssembly();
    const gates = results.filter((r) => r.assertion === 'kg_target_convergence');
    expect(gates.length).toBe(Object.keys(agentSpecs).length);
    expect(gates.every((g) => g.ok)).toBe(true);
    expect(ok).toBe(true);
  });

  it('临时注入 L3 声明 → kg_target_convergence ok:false 且还原不污染', async () => {
    const original = agentSpecs['review-gate'];
    const saved = JSON.parse(JSON.stringify(original));
    agentSpecs['review-gate'] = {
      ...original,
      capabilities: { ...original.capabilities, knowledgeScope: { layers: ['L1', 'L2', 'L3'], maxHops: 4 } },
    };
    try {
      const { results } = await assertAgentAssembly();
      const gate = results.find(
        (r) => r.agent === 'review-gate' && r.assertion === 'kg_target_convergence'
      );
      expect(gate).toBeDefined();
      expect(gate.ok).toBe(false);
    } finally {
      agentSpecs['review-gate'] = saved; // 还原，避免污染其它测试
    }
    expect(kgConvergenceGate(agentSpecs['review-gate']).ok).toBe(true);
  });
});
