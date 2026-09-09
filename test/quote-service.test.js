// test/quote-service.test.js — 报价粒子 + 写时金额计算（E14/C12）+ 自动取价（E15）
// 纯逻辑本地可跑（金额计算/取价/写后验证无 PG）；持久化走 particleRepo（PG 环境验收）
import { describe, it, expect } from 'vitest';
import { computeQuoteAmount, computeLineAmounts, verifyQuoteAmount, fillUnitPrices } from '../src/sales/quoteService.js';

const TODAY = new Date('2026-08-25T00:00:00Z');
// 价格表：p1 标准 100 / 促销 80（8月窗口内）；p2 标准 200
const PRICE_LISTS = [
  { name: '标准价', status: 'active', valid_from: '2026-01-01', valid_to: null, products: [{ product_id: 'p1', price: 100 }, { product_id: 'p2', price: 200 }] },
  { name: '促销价', status: 'active', valid_from: '2026-08-01', valid_to: '2026-08-31', products: [{ product_id: 'p1', price: 80 }] },
];
const PRODUCTS = [{ id: 'p1', price: 100 }, { id: 'p2', price: 200 }];

describe('金额计算 computeQuoteAmount（E14 写时管线）', () => {
  it('单行：100×2×(1-0.1)×(1+0.13) ≈ 203.4', () => {
    expect(computeQuoteAmount([{ product_id: 'p1', qty: 2, unit_price: 100, discount: 0.1, tax: 0.13 }])).toBeCloseTo(203.4, 1);
  });
  it('多行加总', () => {
    const amount = computeQuoteAmount([
      { product_id: 'p1', qty: 1, unit_price: 100, discount: 0, tax: 0 },
      { product_id: 'p2', qty: 2, unit_price: 200, discount: 0, tax: 0 },
    ]);
    expect(amount).toBe(500); // 100 + 400
  });
  it('空/无明细 → 0', () => {
    expect(computeQuoteAmount([])).toBe(0);
    expect(computeQuoteAmount(null)).toBe(0);
  });
  it('缺 qty/unit_price 行跳过', () => {
    expect(computeQuoteAmount([{ product_id: 'p1', qty: 2 }])).toBe(0);
  });
});

describe('写后验证 verifyQuoteAmount（Q.5：写后 sum=明细）', () => {
  it('amount === Σ明细 → true', () => {
    const items = [{ product_id: 'p1', qty: 2, unit_price: 100, discount: 0.1, tax: 0.13 }];
    const lines = computeLineAmounts(items);
    expect(verifyQuoteAmount(computeQuoteAmount(items), lines)).toBe(true);
  });
  it('金额被改（≠Σ明细）→ false', () => {
    const lines = computeLineAmounts([{ product_id: 'p1', qty: 2, unit_price: 100 }]);
    expect(verifyQuoteAmount(250, lines)).toBe(false);
  });
});

describe('自动取价 fillUnitPrices（E15：报价自动取价）', () => {
  it('items 无 unit_price → 从价格表填充（促销期 80）', () => {
    const filled = fillUnitPrices([{ product_id: 'p1', qty: 1 }], PRODUCTS, PRICE_LISTS, { today: TODAY });
    expect(filled[0].unit_price).toBe(80);
    expect(filled[0].source).toBe('price_list');
  });
  it('无价格表命中 → 回退产品价（p2 无促销 → 200）', () => {
    const filled = fillUnitPrices([{ product_id: 'p2', qty: 1 }], PRODUCTS, PRICE_LISTS, { today: TODAY });
    expect(filled[0].unit_price).toBe(200);
  });
  it('已带 unit_price 的行不覆盖', () => {
    const filled = fillUnitPrices([{ product_id: 'p1', qty: 1, unit_price: 120 }], PRODUCTS, PRICE_LISTS, { today: TODAY });
    expect(filled[0].unit_price).toBe(120);
  });
  it('价格表无此产品且产品价缺失 → unit_price=null + source=missing', () => {
    const filled = fillUnitPrices([{ product_id: 'p9', qty: 1 }], PRODUCTS, PRICE_LISTS, { today: TODAY });
    expect(filled[0].unit_price).toBeNull();
    expect(filled[0].source).toBe('missing');
  });
});

// 2026-09-09 修复：价目表 products 仅存产品名分组、不带单价 → 必须回退 CRM_PRODUCT.list_price
// 真实价目表（name 数组、无 price）喂给 fillUnitPrices，产品单价来自产品主数据
const REAL_PRICE_LISTS = [
  { name: '标准价', status: 'active', valid_from: '2026-01-01', valid_to: '2026-12-31', products: ['CRM 标准版（SaaS 年费）', '实施服务'] },
];
const REAL_PRODUCTS = [
  { id: 'b0000001-0000-0000-0000-000000000001', name: 'CRM 标准版（SaaS 年费）', list_price: 98000 },
  { id: 'b0000001-0000-0000-0000-000000000004', name: '实施服务', list_price: 2000 },
];

describe('自动取价回退产品主数据 list_price（2026-09-09 修复）', () => {
  it('价目表无单价 → 回退 CRM_PRODUCT.list_price（按 id 引用）', () => {
    const filled = fillUnitPrices([{ product_id: 'b0000001-0000-0000-0000-000000000001', qty: 1 }], REAL_PRODUCTS, REAL_PRICE_LISTS, { today: TODAY });
    expect(filled[0].unit_price).toBe(98000);
    expect(filled[0].source).toBe('product_master');
  });
  it('按产品名引用也能命中 list_price', () => {
    const filled = fillUnitPrices([{ product_id: '实施服务', qty: 3 }], REAL_PRODUCTS, REAL_PRICE_LISTS, { today: TODAY });
    expect(filled[0].unit_price).toBe(2000);
    expect(filled[0].source).toBe('product_master');
  });
  it('已带 unit_price 的行不覆盖（仍是 price_list/沿用传入）', () => {
    const filled = fillUnitPrices([{ product_id: '实施服务', qty: 1, unit_price: 1500 }], REAL_PRODUCTS, REAL_PRICE_LISTS, { today: TODAY });
    expect(filled[0].unit_price).toBe(1500);
  });
  it('价目表与产品主数据均无此产品 → missing', () => {
    const filled = fillUnitPrices([{ product_id: '不存在产品', qty: 1 }], REAL_PRODUCTS, REAL_PRICE_LISTS, { today: TODAY });
    expect(filled[0].unit_price).toBeNull();
    expect(filled[0].source).toBe('missing');
  });
});