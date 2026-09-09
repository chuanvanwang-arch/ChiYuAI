// test/decision/adviceCard-approval.test.js
import { describe, it, expect } from 'vitest';
import { buildAdviceCard } from '../../src/decision/adviceCard.js';

describe('buildAdviceCard B 档预填', () => {
  it('红线命中 → tier B + approval_flow + approval_prefill', () => {
    const card = buildAdviceCard({
      scenario: { scenario_id: 'QUOTE_PRICING', default_tier: 'HIGH', eval_dimensions: [] },
      coordinate: { scenario_id: 'QUOTE_PRICING', stage: 'S3', deal_id: 'deal-x' },
      facts: {},
      redlines: [{ cond: 'margin_redline', label: '毛利红线', detail: '毛利 10% < 20%' }],
    });
    expect(card.tier).toBe('B');
    expect(card.approval_flow).toBe('CRM_APPROVAL_FLOW');
    expect(card.approval_prefill?.action).toBe('crm-approval-start');
    expect(card.approval_prefill?.business_id).toBe('deal-x');
  });
});
