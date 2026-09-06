import { describe, it, expect } from 'vitest';
import { buildSelfCheck } from '../../src/decision/selfcheck.js';
import { buildStory } from '../../src/decision/storyBuilder.js';

describe('buildSelfCheck · 极简 7 问读模型', () => {
  it('全要素齐全 → 7 问全 pass，overall=pass', () => {
    const d = {
      decision_id: 'd-1',
      intent: { purpose: '拿下 XX 制造产线订单', question: '客户真实痛点是产能还是成本？' },
      conditions_evaluated: [{ fact: '客户上月工博会留资', source: '展会' }],
      assumptions: [{ text: '客户今年有资本开支', basis: '客户口头确认', falsifiable_by: '年报' }],
      inference: { chain: [{ evidence: '需求明确', via_assumption: 'a1', conclusion: '应报方案 A' }], conclusion: '推方案 A' },
      viewpoints: [
        { stance: '客户采购', holder: '张总' },
        { stance: '技术', holder: '李工' },
        { stance: '反对预算', holder: '财务' },
      ],
      implications: [{ type: 'negative', text: '折扣过深伤毛利', probability: 0.4, mitigation: '设 85 折红线' }],
      risk_register: [{ risk: '竞品降价', severity: 'high', mitigation: '差异化交付' }],
      stop_loss: { status: 'armed', condition: '竞品低于 8 折', deadline: '2026-09-30', trigger: '报价' },
      rubric: { weighted_total: 0.82, pass_line: 0.5 },
    };
    const r = buildSelfCheck(d);
    expect(r.questions).toHaveLength(7);
    expect(r.summary).toEqual({ pass: 7, warn: 0, fail: 0, overall: 'pass' });
    r.questions.forEach((q) => expect(q.status).toBe('pass'));
  });

  it('空决策 → 诚实给 fail/warn（不假填充，给证据指针）', () => {
    const r = buildSelfCheck({});
    // Q1 缺目的=warn；其余 6 问无输入=fail → fail=6 warn=1 overall=warn
    expect(r.summary.overall).toBe('warn');
    expect(r.summary.fail).toBe(6);
    expect(r.summary.warn).toBe(1);
    r.questions.forEach((q) => {
      expect(['fail', 'warn']).toContain(q.status);
      expect(q.element_ref).toBeTruthy();
    });
  });

  it('JSONB 列以字符串传入也能安全解析（防假防御）', () => {
    const d = {
      intent: JSON.stringify({ purpose: 'p', question: 'q' }),
      conditions_evaluated: JSON.stringify([{ fact: 'f' }]),
      assumptions: JSON.stringify([]),
      inference: JSON.stringify({ chain: [] }),
      viewpoints: JSON.stringify([]),
      implications: JSON.stringify([]),
      risk_register: JSON.stringify([]),
      stop_loss: JSON.stringify({}),
      rubric: JSON.stringify({ weighted_total: 0.6 }),
    };
    const r = buildSelfCheck(d);
    // Q1 pass, Q6 pass；Q2 有事实无假设台账=warn；Q3/Q4/Q5/Q7 无输入=fail → pass=2 warn=1 fail=4
    expect(r.summary.pass).toBe(2);
    expect(r.summary.warn).toBe(1);
    expect(r.summary.fail).toBe(4);
  });

  it('视角不足 3 或无反方 → Q4 warn', () => {
    const d = {
      intent: { purpose: 'p', question: 'q' },
      conditions_evaluated: [{ fact: 'f' }],
      assumptions: [{ text: 'a', basis: 'b' }],
      inference: { chain: [{ evidence: 'e', via_assumption: 'a', conclusion: 'c' }] },
      viewpoints: [{ stance: '客户', holder: 'x' }],
      implications: [{ type: 'negative', text: 't', mitigation: 'm' }],
      risk_register: [{ risk: 'r', mitigation: 'm' }],
      stop_loss: { status: 'armed', deadline: '2026-10-01' },
      rubric: { weighted_total: 0.7 },
    };
    const r = buildSelfCheck(d);
    const q4 = r.questions.find((q) => q.no === 4);
    expect(q4.status).toBe('warn');
  });
});

describe('buildStory · 故事三构件', () => {
  it('characters 含决策主体 + 视角持有方；dynamics 含推论/后果/风险；trajectory 含决策节点 + 止损', () => {
    const d = {
      decision_id: 'd-2',
      decider_id: 'agent:alice',
      decider_type: 'AUTONOMOUS_AGENT',
      decider_role: 'sales',
      intent: { purpose: '拿单' },
      involved_entities: [{ id: 'acme', name: 'XX 制造', type: 'ACCOUNT' }],
      viewpoints: [{ stance: '客户采购', holder: '张总' }],
      inference: { chain: [{ evidence: '需求明确', via_assumption: 'a1', conclusion: '推方案 A' }] },
      implications: [{ type: 'negative', text: '伤毛利', mitigation: '红线' }],
      risk_register: [{ risk: '竞品', severity: 'high', mitigation: '差异化' }],
      stop_loss: { status: 'armed', deadline: '2026-09-30' },
      disposition: 'APPROVE',
    };
    const s = buildStory(d);
    expect(s.characters.some((c) => c.role === 'decider')).toBe(true);
    expect(s.characters.some((c) => c.role === 'entity' && c.name === 'XX 制造')).toBe(true);
    expect(s.characters.some((c) => c.role === 'viewpoint-holder')).toBe(true);
    expect(s.dynamics.some((x) => x.kind === 'inference')).toBe(true);
    expect(s.dynamics.some((x) => x.kind === 'implication:negative')).toBe(true);
    expect(s.dynamics.some((x) => x.kind === 'risk')).toBe(true);
    expect(s.trajectory[0].type).toBe('decision');
    expect(s.trajectory.some((x) => x.type === 'stop_loss')).toBe(true);
    // 每条必须带 element_ref（除 timeline/outcome）
    s.dynamics.forEach((x) => expect(x.element_ref).toBeTruthy());
  });

  it('外部时间线注入 trajectory（A3 故事源生效后的真实轨迹）', () => {
    const s = buildStory({ decision_id: 'd-3', intent: { purpose: 'p' } }, {
      timeline: [{ at: '2026-09-10', type: 'visit', text: '现场拜访' }],
    });
    expect(s.trajectory.some((x) => x.type === 'visit' && x.text === '现场拜访')).toBe(true);
  });
});
