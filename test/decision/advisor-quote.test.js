// 报价类场景事实采集（对话驱动决策建议 T3）
import { describe, it, expect } from 'vitest';
import { gatherQuoteFacts, pickAdvisor } from '../../src/decision/scenarioAdvisors.js';

describe('pickAdvisor', () => {
  it('QUOTE_PRICING 分派给报价采集器', () => {
    expect(pickAdvisor('QUOTE_PRICING').name).toBe('gatherQuoteFacts');
  });
});

describe('gatherQuoteFacts', () => {
  it('毛利率低于配置下限 → 产出 margin_redline 红线', async () => {
    const r = await gatherQuoteFacts(
      { payload: { amount: 100000, cost: 88000 } },           // 毛利 12%
      { tenantId: 'system', advisorConfig: { margin_floor_pct: 20 } },
    );
    expect(r.facts.price_vs_floor).toBeTruthy();
    expect(r.redlines[0].cond).toBe('margin_redline');
    expect(r.redlines[0].detail).toContain('20');
  });
  it('毛利率达标 → 无红线', async () => {
    const r = await gatherQuoteFacts(
      { payload: { amount: 100000, cost: 60000 } },
      { tenantId: 'system', advisorConfig: { margin_floor_pct: 20 } },
    );
    expect(r.redlines).toEqual([]);
  });
  it('缺成本字段按出厂 60% 估算且标注估算来源（不假称实测）', async () => {
    const r = await gatherQuoteFacts({ payload: { amount: 100000 } }, { tenantId: 'system', advisorConfig: { margin_floor_pct: 20 } });
    expect(r.facts.margin_source).toBe('estimated');
  });
});
