// 对话坐标判定内核（对话驱动决策建议 T1）
import { describe, it, expect } from 'vitest';
import { resolveCoordinate, matchScenario, DEFAULT_SCENARIO_MAP } from '../../src/decision/dialogAdvisor.js';

describe('resolveCoordinate', () => {
  it('报价关键词 + S4 → QUOTE_PRICING 高置信', () => {
    const r = resolveCoordinate({ utterance: '客户要求 8 折，能不能报', stage: 'S4' });
    expect(r.scenario_id).toBe('QUOTE_PRICING');
    expect(r.stage).toBe('S4');
    expect(r.confidence).toBe('high');
  });
  it('寄样品在 S3 → SOLUTION_VALUE', () => {
    expect(resolveCoordinate({ utterance: '要不要给客户寄样品', stage: 'S3' }).scenario_id).toBe('SOLUTION_VALUE');
  });
  it('寄样品在 S4 降级为报价让步条件（交叉校验）', () => {
    const r = resolveCoordinate({ utterance: '要不要给客户寄样品', stage: 'S4' });
    expect(r.scenario_id).toBe('QUOTE_PRICING');
    expect(r.reason).toContain('让步');
  });
  it('无关键词但有阶段 → 取阶段默认场景，置信度 low', () => {
    const r = resolveCoordinate({ utterance: '帮我看看这个客户', stage: 'S5' });
    expect(r.scenario_id).toBe('SIGN_RISK');
    expect(r.confidence).toBe('low');
  });
  it('无关键词无阶段 → 场景为 null 且不抛错（C 档降级前提）', () => {
    const r = resolveCoordinate({ utterance: '' });
    expect(r.scenario_id).toBeNull();
    expect(r.confidence).toBe('low');
  });
  it('多命中时优先选 stages 含当前阶段的场景', () => {
    const r = resolveCoordinate({ utterance: '报价和合同风险都要看', stage: 'S5' });
    expect(r.scenario_id).toBe('SIGN_RISK');
  });
});

describe('matchScenario', () => {
  it('返回命中关键词明细，供建议卡解释依据', () => {
    const m = matchScenario('客户想降价并延长账期', DEFAULT_SCENARIO_MAP);
    expect(m[0].scenario_id).toBe('QUOTE_PRICING');
    expect(m[0].hits).toContain('降价');
    expect(m[0].hits).toContain('账期');
  });
});
