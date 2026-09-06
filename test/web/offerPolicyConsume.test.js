import { test, expect } from 'vitest';
import { validateOfferPolicyPatch, resolvePriceBands, costTotal, marginView } from '../../src/portal/offerPolicyRender.js';
import { activeDictValues } from '../../src/portal/dictEntriesRender.js';

// —— 报价三级定价取数（设计 §4 第 3 行：QUOTE_PRICING 评估取 price_bands）——
test('resolvePriceBands 对象与 JSON 字符串两种形态均可解析', () => {
  expect(resolvePriceBands({ payload: { price_bands: { floor: 85000 } } }).floor).toBe(85000);
  const v = validateOfferPolicyPatch({ name: 'p', price_bands: '{"open":120000,"target":100000,"floor":85000}' });
  expect(resolvePriceBands({ payload: v.normalized }).floor).toBe(85000);
});
test('resolvePriceBands 缺失 / 纯文本返回 null', () => {
  expect(resolvePriceBands({})).toBeNull();
  expect(resolvePriceBands({ payload: { price_bands: '三档价面议' } })).toBeNull();
});

// —— 报价毛利透视（设计 §4 第 2 行：成本可透视）——
test('costTotal 汇总成本结构', () => {
  const v = validateOfferPolicyPatch({ name: 'p', cost_structure: '[{"item":"实施","cost":8000},{"item":"授权","cost":2000}]' });
  expect(costTotal({ payload: v.normalized })).toBe(10000);
  expect(costTotal({ payload: {} })).toBeNull();
});
test('marginView 毛利透视 + 毛利红线判定', () => {
  const v = validateOfferPolicyPatch({
    name: '标准方案包', cost_structure: '[{"item":"成本","cost":60000}]',
    price_bands: '{"open":120000,"target":100000,"floor":85000}', margin_redline: '0.3',
  });
  const p = { payload: v.normalized };
  const m = marginView(p, 100000);
  expect(m.cost).toBe(60000);
  expect(m.margin).toBe(40000);
  expect(m.marginRate).toBeCloseTo(0.4, 5);
  expect(m.floor).toBe(85000);
  expect(m.pass).toBe(true);              // 40% ≥ 30% 红线 → 放行
  expect(marginView(p, 80000).pass).toBe(false); // 25% < 30% → 触红线
});

// —— 字典联动（设计 §4 第 4 行：新建商机/客户 select 属性消费活跃值域）——
test('activeDictValues 只取 registered 且 active 项，按 sort_order 升序', () => {
  const items = [
    { state: 'registered', payload: { dict_key: 'industry', dict_value: '制造', sort_order: 2, active: true } },
    { state: 'registered', payload: { dict_key: 'industry', dict_value: '金融', sort_order: 1, active: true } },
    { state: 'registered', payload: { dict_key: 'industry', dict_value: '废弃项', sort_order: 0, active: false } },
    { state: 'deprecated', payload: { dict_key: 'industry', dict_value: '已停用', sort_order: 0, active: true } },
  ];
  expect(activeDictValues(items, 'industry')).toEqual(['金融', '制造']);
});
test('activeDictValues 按 dict_key 过滤（不传 key 返回全部）', () => {
  const items = [
    { state: 'registered', payload: { dict_key: 'region', dict_value: '华东', sort_order: 0 } },
    { state: 'registered', payload: { dict_key: 'industry', dict_value: '制造', sort_order: 0 } },
  ];
  expect(activeDictValues(items, 'region')).toEqual(['华东']);
  expect(activeDictValues(items)).toEqual(['华东', '制造']);
});
