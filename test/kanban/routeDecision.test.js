// test/kanban/routeDecision.test.js — Task 2：routeThroughIntake 决策分支（方案C 双 Agent）
import { describe, test, expect } from 'vitest';
import { routeThroughIntake } from '../../src/kanban/scheduler.js';

describe('routeThroughIntake · 决策前后双 Agent 路由', () => {
  test('decision-enrich → decision-agent + method-decision-enrich + ct-decision-enrich + 不挂 gate', () => {
    const r = routeThroughIntake({ id: 't1', payload: { intent: 'decision-enrich' } });
    expect(r.targetAgent).toBe('decision-agent');
    expect(r.gateAgents).toEqual([]);
    expect(r.payload.skill_slug).toBe('method-decision-enrich');
    expect(r.payload.contract_task_id).toBe('ct-decision-enrich');
    expect(r.payload.dispatchedFrom).toBe('intake-router');
  });

  test('decision-execute → decision-agent + method-decision-execute + ct-decision-execute + 不挂 gate', () => {
    const r = routeThroughIntake({ id: 't2', payload: { intent: 'decision-execute' } });
    expect(r.targetAgent).toBe('decision-agent');
    expect(r.gateAgents).toEqual([]);
    expect(r.payload.skill_slug).toBe('method-decision-execute');
    expect(r.payload.contract_task_id).toBe('ct-decision-execute');
  });

  test('决策分支不污染原有 quote/retro/followup 路由', () => {
    expect(routeThroughIntake({ payload: { intent: 'quote' } }).targetAgent).toBe('quote-engine');
    expect(routeThroughIntake({ payload: { intent: 'retro' } }).targetAgent).toBe('decision-retro');
    expect(routeThroughIntake({ payload: { intent: 'followup' } }).targetAgent).toBe('followup-agent');
  });

  test('重大商机（level=L3）仍只在 quote 分支挂 review-gate，决策分支恒不挂 gate', () => {
    const major = routeThroughIntake({ payload: { intent: 'decision-execute', level: 'L3' } });
    expect(major.targetAgent).toBe('decision-agent');
    expect(major.gateAgents).toEqual([]);
    const quoteMajor = routeThroughIntake({ payload: { intent: 'quote', level: 'L3' } });
    expect(quoteMajor.gateAgents).toEqual(['review-gate']);
  });
});
