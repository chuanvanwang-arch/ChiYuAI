// test/decision/adviseService-quote.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { advise } from '../../src/decision/adviseService.js';
import { queryWrite } from '../../src/db.js';
import { writeConfig } from '../../src/config/configStore.js';
import { createDecisionFixture, dropDecisionFixture } from './decisionFixture.js';

const T = 'plan-t6-' + Date.now();
let dealId, DEC;
beforeAll(async () => {
  DEC = await createDecisionFixture();
  await writeConfig('price-authority', { default_max_discount_pct: 10, roles: { sales: { max_discount_pct: 10 } } }, { tenantId: 'system' });
  await writeConfig('requirement-dimensions', { levels: ['MUST'], dimensions: [{ dim_key: 'REQ_WRITTEN_APPROVAL', label: '书面批文', level: 'MUST' }] }, { tenantId: 'system' });
  const r = await queryWrite(
    `INSERT INTO crm.particles (type, tenant_id, state, slug, title, payload) VALUES ('CRM_DEAL',$1,'active',$2,$3,$4::jsonb) RETURNING id`,
    [T, 'deal-' + Date.now(), 'T6 deal', JSON.stringify({ amount: 100000, cost: 90000, discount_pct: 20 })]
  );
  dealId = r.rows[0].id;
});
afterAll(async () => {
  await dropDecisionFixture(DEC);
  if (dealId) await queryWrite(`DELETE FROM crm.particles WHERE id=$1`, [dealId]).catch(() => {});
});

describe('advise QUOTE_PRICING 红线 B 档', () => {
  it('低于毛利红线 + 折扣超权限 → B 档含预填', async () => {
    const r = await advise({ utterance: '客户要求 8 折', ctx: { tenantId: T, role: 'sales' }, deal: { id: dealId, payload: { amount: 100000, cost: 90000, discount_pct: 20 } }, stage: 'S3' });
    expect(r.ok).toBe(true);
    expect(r.advice.tier).toBe('B');
    expect(r.advice.approval_prefill?.action).toBe('crm-approval-start');
  });
  it('deal 未确认 MUST 书面批文 → C 档降级（毛利达标、折扣在权限内）', async () => {
    // 成本 8 万 → 毛利 20% = 及格线，不触发毛利红线；无折扣 → 不触发折扣红线；仅 REQUIREMENT MUST 缺失 → C
    const r = await advise({ utterance: '报价 9 折', ctx: { tenantId: T, role: 'manager' }, deal: { id: dealId, payload: { amount: 100000, cost: 80000 } }, stage: 'S3' });
    expect(r.advice.tier).toBe('C');
  });
});

describe('advise REVIEW_GATE 消费红线', () => {
  it('review 场景持 deal 且毛利破线 → 红线进入卡', async () => {
    const r = await advise({ utterance: '复核这单', ctx: { tenantId: T, role: 'manager' }, deal: { id: dealId, payload: { amount: 100000, cost: 90000 } }, stage: 'S5' });
    expect(r.advice.redlines.some((x) => x.cond === 'margin_redline')).toBe(true);
  });
});
