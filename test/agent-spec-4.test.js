// test/agent-spec-4.test.js — 6 agent 名册重建（A接诊/B报价/C跟进/D评审/E决策复盘/F决策接线）
// 2026-08-31 用户拍板：第 5 个 agent（decision-retro 决策复盘）保留，名册由 4 体 → 5 体。
// 2026-09-02 方案C（决策接入 agent 编排层）：新增第 6 体 decision-agent（决策前后双 Agent 的承载体，
//   由 requireDecision fire-forget 派发 method-decision-enrich / method-decision-execute），名册 5 体 → 6 体。
import { describe, it, expect } from 'vitest';
import { agentSpecs } from '../src/agent/agentSpec.js';

describe('6 agent 名册重建', () => {
  it('注册 6 个业务角色 agent', () => {
    expect(Object.keys(agentSpecs)).toEqual([
      'intake-router', 'quote-engine', 'followup-agent', 'review-gate', 'decision-retro', 'decision-agent',
    ]);
  });
  it('每个 agent 六段式字段齐备', () => {
    for (const spec of Object.values(agentSpecs)) {
      expect(spec).toHaveProperty('identity');
      expect(spec).toHaveProperty('capabilities');
      expect(spec).toHaveProperty('context');
      expect(spec).toHaveProperty('memory');
      expect(spec).toHaveProperty('evaluation');
      expect(spec).toHaveProperty('governance');
    }
  });
  it('skillCalls ⊆ actions（权限闭包）', () => {
    for (const spec of Object.values(agentSpecs)) {
      for (const c of spec.capabilities.skillCalls) {
        expect(spec.capabilities.actions).toContain(c);
      }
    }
  });
  it('memory.read 仅引用现 6 体（无悬空旧 agent）', () => {
    const VALID = new Set(['intake-router', 'quote-engine', 'followup-agent', 'review-gate', 'decision-retro', 'decision-agent']);
    const DANGLING = ['lead-miner', 'deal-coach', 'crm-copilot'];
    for (const [id, spec] of Object.entries(agentSpecs)) {
      for (const m of spec.memory.read) {
        expect(VALID.has(m)).toBe(true); // 引用必须是现 6 体之一
      }
      for (const d of DANGLING) {
        expect(spec.memory.read).not.toContain(d); // 不得再出现废弃旧 agent
      }
    }
    // 关键跨读仍保留（协调系统记忆共享）
    expect(agentSpecs['intake-router'].memory.read).toContain('followup-agent');
    expect(agentSpecs['quote-engine'].memory.read).toContain('followup-agent');
    expect(agentSpecs['review-gate'].memory.read).toContain('quote-engine');
    expect(agentSpecs['review-gate'].memory.read).toContain('intake-router');
    // 决策复盘读评审上下文（复盘结论需回溯当初的评审决策）
    expect(agentSpecs['decision-retro'].memory.read).toContain('review-gate');
    // 决策 agent 读评审上下文（决策前后双 Agent 需回溯评审结论；方案C 新增第 6 体配套断言）
    expect(agentSpecs['decision-agent'].memory.read).toContain('review-gate');
  });
});