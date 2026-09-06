// test/price-calc.test.js — 四级定价链路 + 价变审计（C12/E15）
// 纯逻辑本地可跑（无 PG 依赖）；写时管线由 quoteService（T3-5）取价调用
import { describe, it, expect } from 'vitest';
import { isPriceActive, getUnitPrice, resolvePrice, priceChangePayload, appendChangeLog } from '../src/sales/priceCalc.js';

const TODAY = new Date('2026-08-25T00:00:00Z');

const PRICE_LISTS = [
  { name: '标准价', status: 'active', valid_from: '2026-01-01', valid_to: null, products: [{ product_id: 'p1', price: 100 }, { product_id: 'p2', price: 200 }] },
  { name: '促销价', status: 'active', valid_from: '2026-08-01', valid_to: '2026-08-31', products: [{ product_id: 'p1', price: 80 }] },
  { name: '过期价', status: 'expired', valid_from: '2025-01-01', valid_to: '2025-12-31', products: [{ product_id: 'p1', price: 60 }] },
  { name: '未来价', status: 'active', valid_from: '2026-09-01', valid_to: null, products: [{ product_id: 'p1', price: 120 }] },
];

describe('有效期判定 isPriceActive（E15：time-limited）', () => {
  it('有效期内 → true', () => {
    expect(isPriceActive({ status: 'active', valid_from: '2026-01-01', valid_to: null }, TODAY)).toBe(true);
  });
  it('valid_to 已过 → false', () => {
    expect(isPriceActive({ status: 'active', valid_from: '2025-01-01', valid_to: '2025-12-31' }, TODAY)).toBe(false);
  });
  it('valid_from 未到 → false', () => {
    expect(isPriceActive({ status: 'active', valid_from: '2026-09-01', valid_to: null }, TODAY)).toBe(false);
  });
  it('status=expired → false', () => {
    expect(isPriceActive({ status: 'expired' }, TODAY)).toBe(false);
  });
});

describe('取价 getUnitPrice（E15：同一产品多套定价）', () => {
  it('命中有效促销价（窗口内优先）', () => {
    expect(getUnitPrice('p1', PRICE_LISTS, { today: TODAY })).toBe(80); // 促销价窗口 8/1-8/31
  });
  it('未命中产品 → null', () => {
    expect(getUnitPrice('p9', PRICE_LISTS, { today: TODAY })).toBeNull();
  });
  it('过期价不参与', () => {
    expect(getUnitPrice('p1', PRICE_LISTS.filter(p => p.status !== 'expired'), { today: TODAY })).toBe(80);
  });
  it('未来窗口价不参与', () => {
    expect(getUnitPrice('p1', [PRICE_LISTS[0], PRICE_LISTS[3]], { today: TODAY })).toBe(100); // 未来价排除 → 标准价
  });
});

describe('四级链 resolvePrice（产品价 → 价格表 → 回退产品价）', () => {
  it('价格表命中 → 表价', () => {
    expect(resolvePrice({ id: 'p1', price: 100 }, PRICE_LISTS, { today: TODAY })).toBe(80);
  });
  it('表未命中 → 回退产品单价值', () => {
    expect(resolvePrice({ id: 'p9', price: 55 }, [])).toBe(55);
  });
  it('无产品 → null', () => {
    expect(resolvePrice(null, [])).toBeNull();
  });
});

describe('价变审计（E15：变更留痕 + 审计载荷）', () => {
  it('priceChangePayload 含 before/after/actor/timestamp（审计输入）', () => {
    const p = priceChangePayload({ productId: 'p1', priceListId: 'pl-1', before: 100, after: 80, actor: 'person-sales-a' });
    expect(p.kind).toBe('price_change');
    expect(p.before).toBe(100);
    expect(p.after).toBe(80);
    expect(p.actor).toBe('person-sales-a');
    expect(p.changed_at).toBeTruthy();
  });
  it('appendChangeLog 追加 + 幂等（同 before/after 不重复登记）', () => {
    const c1 = priceChangePayload({ productId: 'p1', priceListId: 'pl-1', before: 100, after: 80 });
    const c2 = priceChangePayload({ productId: 'p1', priceListId: 'pl-1', before: 100, after: 80 });
    const log = appendChangeLog([], c1);
    // 幂等判据不含 changed_at（毫秒级时间戳纳入会使幂等形同虚设）：
    // 即便 c1/c2 的 changed_at 不同（机器负载高时必然跨毫秒），仍应判为重复而跳过。
    const log2 = appendChangeLog(log, c2); // 同 price_list/product/before/after → 幂等跳过
    expect(log2.length).toBe(1);
  });
});