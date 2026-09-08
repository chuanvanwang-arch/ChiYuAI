// 建议卡装配（对话驱动决策建议 T2）
import { describe, it, expect } from 'vitest';
import { evaluateConditions, buildAdviceCard } from '../../src/decision/adviceCard.js';

const dims = [
  { cond: 'price_vs_floor', label: '开盘/目标/底价对比', weight: 0.25, required: true },
  { cond: 'discount_condition', label: '折扣对等条件', weight: 0.2, required: true },
  { cond: 'pay_ratio', label: '付款比例', weight: 0.2 },
];

describe('evaluateConditions', () => {
  it('区分已满足与缺失，required 缺失单列', () => {
    const r = evaluateConditions(dims, { price_vs_floor: '高于底价' });
    expect(r.satisfied.map((x) => x.cond)).toEqual(['price_vs_floor']);
    expect(r.missing.map((x) => x.cond)).toEqual(['discount_condition', 'pay_ratio']);
    expect(r.requiredMissing.map((x) => x.cond)).toEqual(['discount_condition']);
    expect(r.coverage).toBeCloseTo(0.25 / 0.65, 5);
  });
  it('空维度返回 coverage=0 且不抛错', () => {
    const r = evaluateConditions([], {});
    expect(r.coverage).toBe(0);
    expect(r.missing).toEqual([]);
  });
});

describe('buildAdviceCard', () => {
  it('required 有缺失 → C 档只补信息、不给处置', () => {
    const card = buildAdviceCard({
      scenario: { scenario_id: 'QUOTE_PRICING', eval_dimensions: dims, default_tier: 'HIGH', rubric_pass_line: 0.65 },
      coordinate: { scenario_id: 'QUOTE_PRICING', stage: 'S4', confidence: 'high', reason: '关键词命中 折扣' },
      facts: { price_vs_floor: '高于底价' },
    });
    expect(card.tier).toBe('C');
    expect(card.disposition).toBeNull();
    expect(card.gaps[0].cond).toBe('discount_condition');
  });
  it('条件齐 + 红线 → B 档风险提示并指向审批流', () => {
    const card = buildAdviceCard({
      scenario: { scenario_id: 'QUOTE_PRICING', eval_dimensions: dims, default_tier: 'HIGH', rubric_pass_line: 0.65 },
      coordinate: { scenario_id: 'QUOTE_PRICING', stage: 'S4', confidence: 'high', reason: 'x' },
      facts: { price_vs_floor: '低于底价', discount_condition: '已换账期', pay_ratio: '3:7' },
      redlines: [{ cond: 'margin_redline', label: '毛利红线', detail: '毛利率 12% < 下限 20%' }],
    });
    expect(card.tier).toBe('B');
    expect(card.disposition).toBe('ESCALATE');
    expect(card.approval_flow).toBe('CRM_APPROVAL_FLOW');
  });
  it('条件齐且无红线且覆盖率达标 → A 档明确处置', () => {
    const card = buildAdviceCard({
      scenario: { scenario_id: 'QUOTE_PRICING', eval_dimensions: dims, default_tier: 'NORMAL', rubric_pass_line: 0.65 },
      coordinate: { scenario_id: 'QUOTE_PRICING', stage: 'S4', confidence: 'high', reason: 'x' },
      facts: { price_vs_floor: 'a', discount_condition: 'b', pay_ratio: 'c' },
    });
    expect(card.tier).toBe('A');
    expect(card.disposition).toBe('APPROVE');
    expect(card.headline).toContain('S4');
  });
  it('低置信坐标即使条件齐也降级为 C 档（防误导）', () => {
    const card = buildAdviceCard({
      scenario: { scenario_id: 'OPP_QUALIFY', eval_dimensions: [], default_tier: 'NORMAL' },
      coordinate: { scenario_id: 'OPP_QUALIFY', stage: null, confidence: 'low', reason: '无关键词' },
      facts: {},
    });
    expect(card.tier).toBe('C');
  });
});
