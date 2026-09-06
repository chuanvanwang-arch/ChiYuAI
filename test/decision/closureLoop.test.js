// test/decision/closureLoop.test.js — P2 闭环回流纯函数单测（无 DB 依赖）
import { describe, it, expect } from 'vitest';
import { routeRetroChannels, mapKnowledgeUpdateToPatch } from '../../src/decision/closureLoop.js';

describe('routeRetroChannels §9.2 三通道分流', () => {
  it('C2：falsified 假设被识别为反面先例，其余不计入', () => {
    const r = routeRetroChannels({
      assumption_review: [
        { assumption: '决策人为生产总监', verdict: 'falsified', falsified_by: '实为采购总监' },
        { assumption: '预算已确认', verdict: 'confirmed' },
        { assumption: '缺字段', verdict: 'unknown' },
      ],
    });
    expect(r.negative_precedents).toHaveLength(1);
    expect(r.negative_precedents[0].assumption).toBe('决策人为生产总监');
    expect(r.negative_precedents[0].falsified_by).toBe('实为采购总监');
  });

  it('C3：knowledge_update 与 C3′ memory_impact 分别归集', () => {
    const r = routeRetroChannels({
      knowledge_update: [{ type: 'required_dims', target: 'LEAD_FOLLOW_UP', to_value: ['semantics'] }],
      memory_impact: [{ ref: 'mem-1', impact: '客户背景更新' }],
    });
    expect(r.knowledge_patches).toHaveLength(1);
    expect(r.memory_impacts).toHaveLength(1);
  });

  it('C1：事实类统计聚合（A/B/C/D/G）', () => {
    const r = routeRetroChannels({
      outcome_type: 'won',
      assumption_review: [{ assumption: 'x', verdict: 'confirmed' }],
      missing_information: ['budget_doc'],
      root_cause: 'DIM_MISSING',
    });
    expect(r.facts.has_outcome).toBe(true);
    expect(r.facts.assumption_review_count).toBe(1);
    expect(r.facts.missing_information_count).toBe(1);
    expect(r.facts.has_root_cause).toBe(true);
    expect(r.negative_precedents).toHaveLength(0);
  });
});

describe('mapKnowledgeUpdateToPatch §9.2 C3 处方合法性', () => {
  it('required_dims / threshold / weight 等 KNOBS 可处方', () => {
    const p = mapKnowledgeUpdateToPatch({ type: 'required_dims', target: 'S1', to_value: ['semantics'] });
    expect(p.rejected).toBe(false);
    expect(p.knob).toBe('required_dims');
    expect(p.risk).toBe('MEDIUM');
  });

  it('focus_rulers 等越界 knob 被拒（不假填充，诚实返回 reason）', () => {
    const p = mapKnowledgeUpdateToPatch({ type: 'focus_rulers', target: 'S1', to_value: ['x'] });
    expect(p.rejected).toBe(true);
    expect(p.reason).toMatch(/可处方清单/);
  });

  it('to_value 缺失被拒', () => {
    const p = mapKnowledgeUpdateToPatch({ type: 'threshold' });
    expect(p.rejected).toBe(true);
    expect(p.reason).toMatch(/to_value/);
  });

  it('risk 合法值透传，非法值回落 MEDIUM', () => {
    const ok = mapKnowledgeUpdateToPatch({ type: 'threshold', to_value: 0.7, risk: 'HIGH' });
    expect(ok.risk).toBe('HIGH');
    const bad = mapKnowledgeUpdateToPatch({ type: 'threshold', to_value: 0.7, risk: 'BOOM' });
    expect(bad.risk).toBe('MEDIUM');
  });
});
