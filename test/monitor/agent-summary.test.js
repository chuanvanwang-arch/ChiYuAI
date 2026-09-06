import { describe, it, expect } from 'vitest';
import { getAgentSummary } from '../../src/monitor/monitorStore.js';
import { getDecisionHealth } from '../../src/monitor/monitorStore.js';

describe('getAgentSummary', () => {
  it('按 agent 聚合运行成败（monitor_event agent 域）', async () => {
    const r = await getAgentSummary({ days: 7 });
    expect(r).toHaveProperty('totals');
    expect(r).toHaveProperty('by_agent');
    expect(Array.isArray(r.by_agent)).toBe(true);
    expect(r.totals).toHaveProperty('runs');
    expect(r.totals).toHaveProperty('fail_rate');
  });

  it('无数据时返回空聚合而非抛错', async () => {
    const r = await getAgentSummary({ days: 0 });
    expect(r.totals.runs).toBe(0);
    expect(r.by_agent).toEqual([]);
  });
});

describe('getDecisionHealth', () => {
  it('按场景聚合决策 made/escalated 与结果分布', async () => {
    const r = await getDecisionHealth({ days: 30 });
    expect(r).toHaveProperty('by_scenario');
    expect(r).toHaveProperty('outcomes');
    expect(r).toHaveProperty('made');
    expect(typeof r.made).toBe('number');
    expect(r.outcomes).toHaveProperty('won');
    expect(r.outcomes).toHaveProperty('lost');
  });

  it('无数据时返回空聚合而非抛错', async () => {
    const r = await getDecisionHealth({ days: 0 });
    expect(r.by_scenario).toEqual([]);
    expect(r.made).toBe(0);
  });
});
