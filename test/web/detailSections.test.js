// test/web/detailSections.test.js — 7 类业务详情 section 渲染单测（纯函数，node 环境）
import { describe, it, expect } from 'vitest';
import { renderBusinessSections, hasBusinessSection } from '../../src/portal/detailSections.js';

const base = (type, payload = {}) => ({ id: 'p1', type, payload, state: 'active' });

describe('hasBusinessSection', () => {
  it('7 类真实粒子返回 true', () => {
    for (const t of ['CRM_DEAL','CRM_QUOTATION','CRM_CONTRACT','CRM_ORDER','CRM_PAYMENT_PLAN','CRM_PAYMENT_RECORD','CRM_INVOICE'])
      expect(hasBusinessSection(t)).toBe(true);
  });
  it('未知类型返回 false（降级通用 dump）', () => {
    expect(hasBusinessSection('CRM_ACCOUNT')).toBe(false);
    expect(hasBusinessSection('FOO')).toBe(false);
  });
});

describe('renderBusinessSections — CRM_DEAL', () => {
  it('输出 L2C 进度条与金额', () => {
    const html = renderBusinessSections(base('CRM_DEAL', { name: 'X', stage: 'opportunity', amount: 100000 }), [], {});
    expect(html).toContain('data-section="l2c"');
    expect(html).toContain('商机');           // 当前阶段标签
    expect(html).toContain('¥100,000');
  });
  it('stage=lead 显示「线索」', () => {
    const html = renderBusinessSections(base('CRM_DEAL', { stage: 'lead' }), [], {});
    expect(html).toContain('线索');
  });
});

describe('renderBusinessSections — CRM_QUOTATION', () => {
  it('渲染明细子表与关联商机链接', () => {
    const html = renderBusinessSections(
      base('CRM_QUOTATION', { name: 'Q1', deal_id: 'd1', amount: 5000, items: [{ product_id: 'pr1', qty: 2, unit_price: 2500 }] }),
      [], {});
    expect(html).toContain('data-section="quotation"');
    expect(html).toContain('pg-subtable');     // 明细子表
    expect(html).toContain('/deals/d1');        // 关联商机深链
    expect(html).toContain('¥5,000');
  });
});

describe('renderBusinessSections — CRM_CONTRACT', () => {
  it('渲染合同要素与关联深链', () => {
    const html = renderBusinessSections(
      base('CRM_CONTRACT', { contract_no: 'C1', deal_id: 'd1', quotation_id: 'q1', amount: 8000 }), [], {});
    expect(html).toContain('data-section="contract"');
    expect(html).toContain('C1');
    expect(html).toContain('/deals/d1');
    expect(html).toContain('/quotes/q1');
  });
});

describe('renderBusinessSections — CRM_ORDER', () => {
  it('渲染订单要素与关联合同/商机', () => {
    const html = renderBusinessSections(
      base('CRM_ORDER', { order_no: 'O1', deal_id: 'd1', contract_id: 'c1', amount: 8000, status: 'confirmed' }), [], {});
    expect(html).toContain('data-section="order"');
    expect(html).toContain('O1');
    expect(html).toContain('/contracts/c1');
  });
});

describe('renderBusinessSections — CRM_PAYMENT_PLAN', () => {
  it('渲染回款计划要素', () => {
    const html = renderBusinessSections(
      base('CRM_PAYMENT_PLAN', { contract_id: 'c1', plan_amount: 4000, plan_end: '2026-09-01', plan_status: 'pending' }), [], {});
    expect(html).toContain('data-section="payment-plan"');
    expect(html).toContain('¥4,000');
    expect(html).toContain('/contracts/c1');
  });
});

describe('renderBusinessSections — CRM_PAYMENT_RECORD', () => {
  it('渲染回款记录要素', () => {
    const html = renderBusinessSections(
      base('CRM_PAYMENT_RECORD', { contract_id: 'c1', paid_amount: 4000, paid_at: '2026-08-20' }), [], {});
    expect(html).toContain('data-section="payment-record"');
    expect(html).toContain('¥4,000');
    expect(html).toContain('/contracts/c1');
  });
});

describe('renderBusinessSections — CRM_INVOICE', () => {
  it('渲染发票要素与关联合同', () => {
    const html = renderBusinessSections(
      base('CRM_INVOICE', { invoice_no: 'INV1', contract_id: 'c1', invoice_amount: 8000, reconcile_status: 'open' }), [], {});
    expect(html).toContain('data-section="invoice"');
    expect(html).toContain('INV1');
    expect(html).toContain('/contracts/c1');
  });
});

describe('renderBusinessSections — 未知类型降级', () => {
  it('返回空串（页面仅渲染通用 dump）', () => {
    expect(renderBusinessSections(base('CRM_ACCOUNT'), [], {})).toBe('');
  });
});
