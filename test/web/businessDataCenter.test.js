import { test, expect } from 'vitest';
import { BUSINESS_DATA_ITEMS, renderBusinessDataCenter } from '../../src/portal/businessDataCenter.js';
import { PARTICLE_TYPES, ATTRIBUTE_TYPE_SET } from '../../src/particles/particleModel.js';
import { PRODUCT_FIELDS, validateProductPatch, renderProductList, renderProductForm } from '../../src/portal/productCatalogRender.js';
import { validatePriceListPatch, renderPriceList } from '../../src/portal/priceListRender.js';
import { validateOfferPolicyPatch } from '../../src/portal/offerPolicyRender.js';
import { DICT_KEYS, validateDictPatch, renderDictList } from '../../src/portal/dictEntriesRender.js';
import { validatePaymentPatch, PAYMENT_SUBTYPE } from '../../src/portal/paymentPolicyRender.js';

// —— 门户总览 ——
test('门户 6 面齐全', () => {
  expect(BUSINESS_DATA_ITEMS).toHaveLength(6);
});
test('门户渲染含 6 张卡片', () => {
  const html = renderBusinessDataCenter();
  expect((html.match(/cfg-card/g) || []).length).toBe(6);
});
test('BUSINESS_DATA_ITEMS 含指名客户管理（客户管理组）', () => {
  expect(BUSINESS_DATA_ITEMS.some(i => i.name === '指名客户管理' && i.group === '客户管理')).toBe(true);
});
test('门户渲染含第 6 卡链接', () => {
  const html = renderBusinessDataCenter();
  expect(html).toContain('/named-account-manage.html');
  expect(html).toContain('客户管理');
});
test('门户每项均有 page 与 endpoint', () => {
  for (const it of BUSINESS_DATA_ITEMS) {
    expect(it.page).toMatch(/^\/[a-z-]+\.html$/);
    expect(it.endpoint).toBeTruthy();
    expect(it.endpoint).toMatch(/^\/api\//);
  }
});

// —— 粒子注册（设计 §2）——
test('4 个业务主数据粒子已注册', () => {
  for (const t of ['CRM_OFFER_POLICY', 'CRM_DICT_ENTRY', 'CRM_COMPETITOR', 'CRM_RESOURCE_CALENDAR']) {
    expect(PARTICLE_TYPES[t]).toBeDefined();
  }
});
test('新粒子属性类型 ∈ 19 类型集', () => {
  for (const t of ['CRM_OFFER_POLICY', 'CRM_DICT_ENTRY', 'CRM_COMPETITOR', 'CRM_RESOURCE_CALENDAR']) {
    for (const ty of Object.values(PARTICLE_TYPES[t].coreAttributes || {})) {
      expect(ATTRIBUTE_TYPE_SET.has(ty)).toBe(true);
    }
  }
});
test('CRM_PRODUCT 已补 category（P0 产品目录依赖）', () => {
  expect(PARTICLE_TYPES.CRM_PRODUCT.coreAttributes.category).toBe('select');
});
test('CRM_OFFER_POLICY 含回款政策字段（subtype=payment）', () => {
  const ca = PARTICLE_TYPES.CRM_OFFER_POLICY.coreAttributes;
  expect(ca.payment_term).toBe('number');
  expect(ca.collection_tier).toBe('select');
  expect(ca.prepay_ratio).toBe('percent');
});

// —— 产品目录（Task 2）——
test('validateProductPatch 合法用例', () => {
  const r = validateProductPatch({ name: 'CRM 标准版', unit: '套', category: '软件', list_price: '98000', status: 'on_sale' });
  expect(r.ok).toBe(true);
  expect(r.normalized.name).toBe('CRM 标准版');
  expect(r.normalized.list_price).toBe(98000);
});
test('validateProductPatch 未知字段 / 负价 / 空名', () => {
  expect(validateProductPatch({ unknown: 1 }).ok).toBe(false);
  expect(validateProductPatch({ name: 'x', list_price: -1 }).ok).toBe(false);
  expect(validateProductPatch({ name: '   ' }).ok).toBe(false);
});
test('renderProductList 空态 + 含软停用按钮（禁物理删除）', () => {
  expect(renderProductList([])).toContain('暂无产品');
  const html = renderProductList([{ id: 'p1', payload: { name: 'A', list_price: 100 } }]);
  expect(html).toContain('data-stop="p1"');
  expect(html).not.toContain('删除');
});
test('renderProductForm 含 PRODUCT_FIELDS 全部字段', () => {
  const html = renderProductForm();
  for (const f of PRODUCT_FIELDS) expect(html).toContain(f);
});

// —— 基础价格表（Task 3）——
test('validatePriceListPatch 合法 + products 转数组', () => {
  const r = validatePriceListPatch({ name: '2026 标准价', valid_from: '2026-01-01', valid_to: '2026-12-31', permission: 'internal', products: 'CRM 标准版, 实施服务' });
  expect(r.ok).toBe(true);
  expect(r.normalized.products).toEqual(['CRM 标准版', '实施服务']);
});
test('validatePriceListPatch 日期格式非法 / 区间倒置 / 权限非法', () => {
  expect(validatePriceListPatch({ name: 'x', valid_from: '2026/01/01' }).ok).toBe(false);
  expect(validatePriceListPatch({ name: 'x', valid_from: '2026-12-31', valid_to: '2026-01-01' }).ok).toBe(false);
  expect(validatePriceListPatch({ name: 'x', permission: 'secret' }).ok).toBe(false);
});
test('renderPriceList 空态', () => {
  expect(renderPriceList([])).toContain('暂无价格表');
});

// —— 报价商务规则包（Task 4）——
test('validateOfferPolicyPatch 合法 JSON 结构', () => {
  const r = validateOfferPolicyPatch({
    name: '标准方案包', subtype: 'standard',
    cost_structure: '[{"item":"实施服务","cost":8000}]',
    price_bands: '{"open":120000,"target":100000,"floor":85000}',
    margin_redline: '0.25',
  });
  expect(r.ok).toBe(true);
  expect(JSON.parse(r.normalized.price_bands).floor).toBe(85000);
});
test('validateOfferPolicyPatch 非法 JSON 被拒', () => {
  const r = validateOfferPolicyPatch({ name: 'x', price_bands: '{open:120000}' });
  expect(r.ok).toBe(false);
  expect(r.errors.join()).toContain('合法 JSON');
});
test('validateOfferPolicyPatch 纯文本放行（非 JSON 形态）', () => {
  expect(validateOfferPolicyPatch({ name: 'x', change_billing: '按人天 2000 元' }).ok).toBe(true);
});

// —— 字典值域（Task 5）——
test('validateDictPatch 合法 / 非法 dict_key', () => {
  expect(validateDictPatch({ dict_key: 'industry', dict_value: '制造', sort_order: '1', active: 'on' }).ok).toBe(true);
  expect(validateDictPatch({ dict_key: 'unknown_key', dict_value: 'x' }).ok).toBe(false);
  expect(DICT_KEYS).toContain('payment_method');
});
test('renderDictList 空态', () => {
  expect(renderDictList([])).toContain('暂无字典项');
});

// —— 回款政策（Task 6）——
test('validatePaymentPatch 合法（subtype=payment）', () => {
  const r = validatePaymentPatch({ name: '标准账期', subtype: PAYMENT_SUBTYPE, payment_term: '30', collection_tier: '施压', prepay_ratio: '20' });
  expect(r.ok).toBe(true);
  expect(r.normalized.payment_term).toBe(30);
  expect(r.normalized.subtype).toBe('payment');
});
test('validatePaymentPatch 账期越界 / 分级非法 / 预付比例越界', () => {
  expect(validatePaymentPatch({ name: 'x', subtype: 'payment', payment_term: '400' }).ok).toBe(false);
  expect(validatePaymentPatch({ name: 'x', subtype: 'payment', collection_tier: '暴力' }).ok).toBe(false);
  expect(validatePaymentPatch({ name: 'x', subtype: 'payment', prepay_ratio: '120' }).ok).toBe(false);
});
