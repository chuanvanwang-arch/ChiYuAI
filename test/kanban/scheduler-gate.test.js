// test/kanban/scheduler-gate.test.js — runGateAgents 读结构化 verdict（② gate 阻断式）
import { describe, it, expect } from 'vitest';
import { runGateAgents } from '../../src/kanban/scheduler.js';

const routed = (gateAgents) => ({ gateAgents, payload: { level: 'major' } });
const task = { id: 't1', payload: {} };

describe('runGateAgents verdict', () => {
  it('verdict=pass → ok true', async () => {
    const out = await runGateAgents(routed(['review-gate']), task, async () => ({ verdict: 'pass', defects: [] }));
    expect(out['review-gate'].ok).toBe(true);
    expect(out['review-gate'].verdict).toBe('pass');
  });
  it('verdict=reject → ok false + defects', async () => {
    const out = await runGateAgents(routed(['review-gate']), task, async () => ({ verdict: 'reject', defects: ['毛利不达标'] }));
    expect(out['review-gate'].ok).toBe(false);
    expect(out['review-gate'].verdict).toBe('reject');
    expect(out['review-gate'].defects).toContain('毛利不达标');
  });
  it('异常 → 保守 reject（fail-safe）', async () => {
    const out = await runGateAgents(routed(['review-gate']), task, async () => { throw new Error('llm down'); });
    expect(out['review-gate'].ok).toBe(false);
    expect(out['review-gate'].verdict).toBe('reject');
  });
  it('缺 verdict → 保守 reject', async () => {
    const out = await runGateAgents(routed(['review-gate']), task, async () => ({ summary: 'ok' }));
    expect(out['review-gate'].ok).toBe(false);
    expect(out['review-gate'].verdict).toBe('reject');
  });
});
