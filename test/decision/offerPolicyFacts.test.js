// test/decision/offerPolicyFacts.test.js
import { describe, it, expect } from 'vitest';
import { discountAuthorityCheck, resolveOfferPolicy, buildApprovalPrefill, resolveRequestedDiscount } from '../../src/decision/offerPolicyFacts.js';
import { marginView } from '../../src/decision/offerPolicyMath.js';

const MATRIX = {
  default_max_discount_pct: 10,
  roles: {
    sales: { max_discount_pct: 10 },
    presales: { max_discount_pct: 15 },
    manager: { max_discount_pct: 30 },
    director: { max_discount_pct: 100 },
  },
};

describe('discountAuthorityCheck', () => {
  it('sales 申请 8 折(20% off) 超权限 → exceeded', () => {
    const r = discountAuthorityCheck('sales', 20, MATRIX);
    expect(r.evaluated).toBe(true);
    expect(r.exceeded).toBe(true);
    expect(r.roleCap).toBe(10);
    expect(r.gapPct).toBe(10);
  });
  it('manager 申请 30% 在权限内 → 不超', () => {
    const r = discountAuthorityCheck('manager', 30, MATRIX);
    expect(r.exceeded).toBe(false);
  });
  it('无角色 → 走 default 上限', () => {
    const r = discountAuthorityCheck(null, 12, MATRIX);
    expect(r.role).toBeNull();
    expect(r.roleCap).toBe(10);
    expect(r.exceeded).toBe(true);
  });
  it('矩阵或折扣缺失 → fail-open 不阻断', () => {
    expect(discountAuthorityCheck('sales', null, MATRIX).evaluated).toBe(false);
    expect(discountAuthorityCheck('sales', 20, null).evaluated).toBe(false);
  });
});

describe('offerPolicyMath.marginView parity', () => {
  it('与门户口径一致：成本 80000 报价 100000 → marginRate 0.2', () => {
    const policy = { payload: { cost_structure: '[{"cost":80000}]', price_bands: '{"floor":85000}', margin_redline: 0.2 } };
    const mv = marginView(policy, 100000);
    expect(mv.cost).toBe(80000);
    expect(mv.marginRate).toBeCloseTo(0.2, 5);
    expect(mv.floor).toBe(85000);
    expect(mv.redline).toBe(0.2);
  });
});

describe('resolveRequestedDiscount', () => {
  it('直接取 discount_pct', () => {
    expect(resolveRequestedDiscount({ payload: { discount_pct: 20 } })).toBe(20);
  });
  it('由 list_price/amount 反算', () => {
    expect(resolveRequestedDiscount({ payload: { list_price: 100000, amount: 80000 } })).toBe(20);
  });
  it('两者皆无 → null（只提示需审批，不判具体角色）', () => {
    expect(resolveRequestedDiscount({ payload: {} })).toBeNull();
  });
});

describe('buildApprovalPrefill', () => {
  it('B 档预填 crm-approval-start 参数，不自动写', () => {
    const p = buildApprovalPrefill({
      scenario_id: 'QUOTE_PRICING', deal_id: 'deal-1',
      redlines: [{ label: '毛利红线', detail: '毛利 12% < 20%' }],
    });
    expect(p.flow_id).toBe('CRM_APPROVAL_FLOW');
    expect(p.business_type).toBe('QUOTE_PRICING');
    expect(p.business_id).toBe('deal-1');
    expect(p.action).toBe('crm-approval-start');
    expect(p.note).toContain('不自动发起');
  });
});

describe('resolveOfferPolicy (fail-open)', () => {
  it('无租户政策 → null 不抛错', async () => {
    const r = await resolveOfferPolicy('nonexistent-tenant-' + Date.now());
    expect(r).toBeNull();
  });
});
