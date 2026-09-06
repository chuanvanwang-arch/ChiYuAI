// B2 单测：materializeEightElements 八要素草稿物化（fail-open，不假填充 BG-04）
import { describe, it, expect } from 'vitest';
import { materializeEightElements } from '../../src/decision/decisionRepo.js';

describe('materializeEightElements (B2)', () => {
  it('调用方传入优先：intent 原样保留', () => {
    const out = materializeEightElements(
      { intent: { purpose: 'p', question: 'q' }, assumptions: [{ id: 'a1', text: 'x' }] },
      { rationale: '', trigger_context: {} }
    );
    expect(out.intent).toEqual({ purpose: 'p', question: 'q' });
    expect(out.assumptions).toEqual([{ id: 'a1', text: 'x' }]);
  });

  it('intent 未传且 rationale 存在 → 从 rationale 生成弱草稿（让常规决策 intent 非空）', () => {
    const out = materializeEightElements({}, { rationale: '客户要求 8 折', trigger_context: {} });
    expect(out.intent).toEqual({ purpose: '客户要求 8 折', question: '', sub_questions: [] });
  });

  it('intent 未传且 trigger_context.query 存在 → question 取自 query', () => {
    const out = materializeEightElements({}, { rationale: '', trigger_context: { query: '是否接受再降 10%' } });
    expect(out.intent.question).toBe('是否接受再降 10%');
  });

  it('intent 未传且无任何信号 → 诚实留 null（不假填充）', () => {
    const out = materializeEightElements({}, { rationale: '', trigger_context: {} });
    expect(out.intent).toBeNull();
  });

  it('其余要素未传 → 诚实留 null（评分计 0，不假填充）', () => {
    const out = materializeEightElements({}, { rationale: 'r', trigger_context: {} });
    expect(out.assumptions).toBeNull();
    expect(out.inference).toBeNull();
    expect(out.viewpoints).toBeNull();
    expect(out.implications).toBeNull();
    expect(out.risk_register).toBeNull();
    expect(out.stop_loss).toBeNull();
    expect(out.concept_refs).toBeNull();
  });

  it('elements 非对象入参不抛（fail-open 健壮性）', () => {
    const out = materializeEightElements(null, null);
    expect(out.intent).toBeNull();
    expect(out.assumptions).toBeNull();
  });
});
