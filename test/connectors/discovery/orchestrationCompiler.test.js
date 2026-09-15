// test/connectors/discovery/orchestrationCompiler.test.js
// C1 可组合 GTM 编排层编译器的纯函数测试（零 IO，无 PG 依赖）
import { describe, it, expect } from 'vitest';
import { compilePlaybook, selectPlaybook } from '../../../src/connectors/discovery/orchestrationCompiler.js';

const RULES = {
  playbooks: [
    { name: 'high-funding', match: 'funding_round && hiring_icp_role',
      data: ['tender', 'gaode'], ai: ['claygentResearch:deep'], action: ['method-followup-engine'] },
    { name: 'lite-redesign', match: 'website_redesign',
      data: ['web-research'], ai: ['claygentResearch:lite'], action: ['method-followup-engine'] },
    { name: 'default', match: '', data: ['web-research'], ai: [], action: [] },
  ],
};

describe('orchestration compiler (C1)', () => {
  it('① selects playbook by signal match (all terms of && must hit)', () => {
    const pb = selectPlaybook(RULES, [{ type: 'funding_round' }, { type: 'hiring_icp_role' }]);
    expect(pb.name).toBe('high-funding');
  });
  it('①b partial match does NOT hit (&& is conjunctive)', () => {
    const pb = selectPlaybook(RULES, [{ type: 'funding_round' }]); // 缺 hiring_icp_role → 落 default
    expect(pb.name).toBe('default');
  });
  it('② compiles playbook into executable 4-primitive plan (ordered)', () => {
    const plan = compilePlaybook(RULES.playbooks[0]);
    expect(plan.steps.map((st) => st.stage)).toEqual(['data', 'condition', 'ai', 'action']);
    expect(plan.steps[0].adapters).toContain('gaode');
    expect(plan.steps[3].skills).toContain('method-followup-engine');
  });
  it('③ falls back to declared default playbook when no match', () => {
    const pb = selectPlaybook(RULES, [{ type: 'unknown_signal' }]);
    expect(pb.name).toBe('default');
  });
  it('③b returns null when no match AND no default entry (factory playbooks=[])', () => {
    expect(selectPlaybook({ playbooks: [] }, [{ type: 'x' }])).toBeNull();
    expect(selectPlaybook({}, [{ type: 'x' }])).toBeNull();
    expect(selectPlaybook({ playbooks: [{ name: 'a', match: 'zzz', data: ['tender'] }] }, [])).toBeNull();
  });
  it('④ throws on malformed playbook (null / missing name)', () => {
    expect(() => compilePlaybook(null)).toThrow();
    expect(() => compilePlaybook(undefined)).toThrow();
    expect(() => compilePlaybook({})).toThrow();
    expect(() => compilePlaybook({ data: ['tender'] })).toThrow(); // 无名编排禁止静默进主干
  });
  it('④b plan stages come 100% from input (no hardcoded stage when段缺)', () => {
    const plan = compilePlaybook({ name: 'action-only', action: ['method-followup-engine'] });
    expect(plan.steps.map((s) => s.stage)).toEqual(['action']);
    expect(plan.steps.some((s) => s.adapters)).toBe(false);
    expect(plan.name).toBe('action-only');
  });
});
