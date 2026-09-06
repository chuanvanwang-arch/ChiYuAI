// test/living-contract/export.test.js
import { describe, it, expect } from 'vitest';
import { exportContractFeedback } from '../../scripts/export-contract-feedback.mjs';
import { aggregateFeedback } from '../../scripts/aggregate-feedback.mjs';

describe('export-contract-feedback', () => {
  it('导出数组形状（供 aggregate-feedback.mjs 消费）', async () => {
    const rows = [
      { doc_path: 'd', task: 'T', gap_type: 'success', agent: 'crm-copilot', observed: 'x', expected: 'y', severity: 'info', status: 'resolved' },
      { doc_path: 'd', task: 'T', gap_type: 'success', agent: 'crm-copilot', observed: 'x', expected: 'y', severity: 'info', status: 'resolved' },
      { doc_path: 'd', task: 'X', gap_type: 'skill', agent: 'crm-copilot', observed: 'z', expected: '', severity: 'warn', status: 'open' },
    ];
    const list = await exportContractFeedback({ query: async () => ({ rows }) });
    expect(Array.isArray(list)).toBe(true);
    expect(list).toHaveLength(3);
    expect(list[0]).toHaveProperty('task');
    expect(list[0]).toHaveProperty('gap_type');
  });
  it('复现≥2 同 (task,gap_type) → aggregateFeedback 产出 requiresApproval 提案', async () => {
    const rows = [
      { task: 'T', gap_type: 'success', agent: 'crm-copilot', observed: 'x', expected: 'y' },
      { task: 'T', gap_type: 'success', agent: 'crm-copilot', observed: 'x', expected: 'y' },
    ];
    const list = await exportContractFeedback({ query: async () => ({ rows }) });
    const proposals = aggregateFeedback(list);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].requiresApproval).toBe(true);
    expect(proposals[0].occurrences).toBe(2);
  });
});
