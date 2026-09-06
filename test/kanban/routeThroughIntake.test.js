// test/kanban/routeThroughIntake.test.js
import { describe, it, expect } from 'vitest';
import { routeThroughIntake } from '../../src/kanban/scheduler.js';

describe('routeThroughIntake skill_slug 覆盖', () => {
  it('intent=stage-progression 且 payload.skill_slug=method-stage-progression → quote-engine + 保留 skill_slug', () => {
    const r = routeThroughIntake({ id: 't1', payload: { intent: 'stage-progression', skill_slug: 'method-stage-progression' } });
    expect(r.targetAgent).toBe('quote-engine');
    expect(r.payload.skill_slug).toBe('method-stage-progression');
    expect(r.payload.contract_task_id).toBe('ct-quote-calc');
  });
  it('未传 skill_slug → 回落 primarySkillFor(quote-engine)=method-quote-engine', () => {
    const r = routeThroughIntake({ id: 't2', payload: { intent: 'stage-progression' } });
    expect(r.payload.skill_slug).toBe('method-quote-engine');
  });
  it('越权 skill_slug（不在 targetAgent.skillCalls）→ 回落 primarySkillFor，不泄露越权', () => {
    const r = routeThroughIntake({ id: 't3', payload: { intent: 'stage-progression', skill_slug: 'method-decision-execute' } });
    expect(r.payload.skill_slug).toBe('method-quote-engine'); // 不在 quote-engine.skillCalls → 回落
  });
  it('CRM_ACCOUNT funnel-classification（事件任务带 targetAgent=followup-agent）→ 保留路由与 skill_slug', () => {
    const r = routeThroughIntake({ id: 't4', payload: { intent: 'funnel-classification', targetAgent: 'followup-agent', skill_slug: 'method-funnel-classification' } });
    expect(r.targetAgent).toBe('followup-agent');
    expect(r.payload.skill_slug).toBe('method-funnel-classification');
  });
  it('无 payload.targetAgent 时按 intent 推导（funnel-classification 非已知意图 → 回落 quote-engine）', () => {
    const r = routeThroughIntake({ id: 't5', payload: { intent: 'funnel-classification', skill_slug: 'method-funnel-classification' } });
    expect(r.targetAgent).toBe('quote-engine'); // 无显式 targetAgent → 走 intent 推导默认
  });
});
