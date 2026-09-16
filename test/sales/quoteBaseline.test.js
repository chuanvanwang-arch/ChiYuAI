import { describe, it, expect } from 'vitest';
import { resolvePrice, getUnitPrice } from 'file:///D:/system/CRM-ai-native/src/sales/priceCalc.js';

describe('quote baseline（报价基线 T08）', () => {
  it('命中既有价格表 → 返回真实价', () => {
    const r = resolvePrice(
      { id: 'p1', price: 100 },
      [{ product_id: 'p1', unit_price: 80, status: 'active', products: [{ product_id: 'p1', price: 80 }] }],
    );
    expect(r).toBe(80);
  });

  it('无价格表也无产品价 → 明确报缺（null，不静默按默认价）', () => {
    const r = resolvePrice({ id: 'p1', price: null }, []);
    expect(r).toBeNull();
  });

  it('getUnitPrice：同一产品多套定价取当前生效最低档（E15）', () => {
    const today = new Date('2026-09-16T00:00:00');
    const r = getUnitPrice('p1', [
      { status: 'active', products: [{ product_id: 'p1', price: 90 }] },
      { status: 'active', products: [{ product_id: 'p1', price: 80 }] },
    ], { today });
    expect(r).toBe(80); // 最低生效档
  });
});
