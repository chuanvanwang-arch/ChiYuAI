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

describe('gatherQuoteFacts 接租户政策', () => {
  // 报价毛利口径：与门户口径一致 —— 成本取自政策包的 cost_structure，红线取自政策 margin_redline；
  // 比较对象是 deal 的报价 amount（不是 deal.cost）。
  const policy = { payload: { cost_structure: '[{"cost":80000}]', price_bands: '{"floor":85000}', margin_redline: 0.2 } };
  it('租户红线 20% 生效：报价 10 万、政策成本 8 万 → 毛利 20% 达标，无红线', async () => {
    const r = await gatherQuoteFacts(
      { payload: { amount: 100000 } },
      { advisorConfig: { margin_floor_pct: 20 }, offerPolicy: policy },
    );
    expect(r.redlines).toEqual([]);
    expect(r.facts.margin_source).toBe('policy');
  });
  it('报价低于政策红线 → margin_redline 红线含差距数值', async () => {
    const r = await gatherQuoteFacts(
      { payload: { amount: 90000 } }, // 政策成本 8 万 → 毛利 11.1% < 20%
      { advisorConfig: { margin_floor_pct: 20 }, offerPolicy: policy },
    );
    expect(r.redlines[0].cond).toBe('margin_redline');
    expect(r.redlines[0].detail).toContain('差');
  });
  it('折扣超权限 → discount_authority_exceeded 红线', async () => {
    const matrix = { default_max_discount_pct: 10, roles: { sales: { max_discount_pct: 10 } } };
    const r = await gatherQuoteFacts(
      { payload: { amount: 100000, discount_pct: 20 } },
      { advisorConfig: { margin_floor_pct: 20 }, ctx: { role: 'sales' }, discountMatrix: matrix, requestedDiscountPct: 20 },
    );
    expect(r.redlines[0].cond).toBe('discount_authority_exceeded');
    expect(r.redlines[0].gap_pct).toBe(10);
  });
});
