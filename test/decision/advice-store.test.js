// 建议落锚点（对话驱动决策建议 T8）
import { describe, it, expect } from 'vitest';
import { buildAdviceAnchor, ADVISED_STATE } from '../../src/decision/adviceStore.js';

describe('ADVISED 状态', () => {
  it('建议态枚举为 ADVISED 且不属 DISPOSABLE_STATES', () => {
    expect(ADVISED_STATE).toBe('ADVISED');
    expect(['REQUIRED', 'HUMAN', 'AUTONOMOUS']).not.toContain(ADVISED_STATE);
  });
});

describe('buildAdviceAnchor', () => {
  it('产出 createDecision 入参：场景/阶段/结构化摘要，且不接受对话原文', () => {
    // 故意多传 utterance：实现签名不消费该字段，锚点中不得出现任何原文片段（D2 原文零落库）
    const input = buildAdviceAnchor({
      advice: { tier: 'B', disposition: 'ESCALATE', scenario_id: 'QUOTE_PRICING', stage: 'S4', coverage: 0.8, hits: ['折扣'] },
      utterance: '客户要求 8 折，还要再降 10%（这句原文不得入库）',
      tenantId: 'acme-auto',
    });
    expect(input.scenario_id).toBe('QUOTE_PRICING');
    expect(input.state).toBe('ADVISED');
    expect(input.decider_type).toBe('AGENT_ADVICE');
    const blob = JSON.stringify(input);
    expect(blob).toContain('S4');
    expect(blob).not.toContain('还要再降 10%');
  });
  it('摘要为结构化产物且必含场景与阶段（非原文截断）', () => {
    const input = buildAdviceAnchor({
      advice: { tier: 'C', disposition: null, scenario_id: 'OPP_QUALIFY', stage: 'S2', hits: ['预算'] },
      summary: null,
      tenantId: 'system',
    });
    expect(input.trigger_context.summary.length).toBeLessThanOrEqual(120);
    expect(input.trigger_context.summary).toContain('OPP_QUALIFY');
    expect(input.trigger_context.summary).toContain('S2');
    expect(input.trigger_context.summary).toContain('预算');
  });
  it('原文即便经 summary 入参传入也只截断不延展（显式覆盖路径）', () => {
    const long = '预'.repeat(500);
    const input = buildAdviceAnchor({
      advice: { scenario_id: 'OPP_QUALIFY', stage: 'S2' },
      summary: long,
      tenantId: 'system',
    });
    expect(input.trigger_context.summary.length).toBeLessThanOrEqual(120);
  });
  it('无 scenario 时不产出锚点（返回 null，防脏数据）', () => {
    expect(buildAdviceAnchor({ advice: { scenario_id: null }, utterance: 'x', tenantId: 'system' })).toBeNull();
  });
});
