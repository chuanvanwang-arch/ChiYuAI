// test/aggregate-feedback.test.js
import { describe, it, expect } from 'vitest';
import { aggregateFeedback } from '../scripts/aggregate-feedback.mjs';

const feedback = [
  { task: 't1', agent: 'crm-copilot', gap_type: 'skill', observed: 'x', expected: 'y', ts: '2026-08-29T10:00:00+08:00', severity: 'warn' },
  { task: 't1', agent: 'crm-copilot', gap_type: 'skill', observed: 'x', expected: 'y', ts: '2026-08-29T11:00:00+08:00', severity: 'error' },
  { task: 't2', agent: 'deal-coach', gap_type: 'memory', observed: 'a', expected: 'b', ts: '2026-08-29T10:30:00+08:00', severity: 'warn' },
];

describe('aggregateFeedback', () => {
  it('仅对复现 ≥2 次产出提案', () => {
    const props = aggregateFeedback(feedback);
    expect(props).toHaveLength(1);
    expect(props[0].task).toBe('t1');
    expect(props[0].gap_type).toBe('skill');
    expect(props[0].occurrences).toBe(2);
    expect(props[0].requiresApproval).toBe(true);
  });
  it('提案含可落地的建议文案', () => {
    const [p] = aggregateFeedback(feedback);
    expect(p.proposal).toContain('skill');
  });
  it('空输入返回空数组', () => {
    expect(aggregateFeedback([])).toEqual([]);
  });
});
