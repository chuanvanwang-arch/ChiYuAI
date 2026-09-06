// src/sales/priceCalc.js — 四级定价链路 + 价变审计（C12/E15：产品 → 价格表 N 套定价 → 报价自动取价 → 合同）
// 设计输入：综合详设 §4 C12（产品→价格表→报价单三级，升级为四级：产品→价格表→报价单→合同）
//          §5 E15（同一产品多套定价/有效期/权限/价变日志/关联产品价格自动同步）
// 纯逻辑（无 PG 依赖，本地可单测）；写时管线由 quoteService（T3-5）取价调用

// 有效期判定：valid_from ≤ today ≤ valid_to（无 valid_to = 长期有效；无 valid_from = 立即生效）
export function isPriceActive(priceList, today = new Date()) {
  const t = today.toISOString().slice(0, 10);
  if (priceList.valid_from && t < priceList.valid_from) return false;
  if (priceList.valid_to && t > priceList.valid_to) return false;
  return priceList.status !== 'expired';
}

// 取价：从多套价格表（priceLists: CRM_PRICE_LIST 粒子 payload 数组）中找产品单价
// 匹配规则：① 产品在价格表 products 内 ② 价格表 status≠expired ③ 有效期命中
// 同一产品多套定价（E15）→ 取【当前生效档的最低价】（促销期取促销价，非促销期回标准价；保守取最低 = 客户可见最优）
export function getUnitPrice(productId, priceLists, { today = new Date() } = {}) {
  if (!Array.isArray(priceLists)) return null;
  let best = null;
  for (const pl of priceLists) {
    if (!pl || pl.status === 'expired') continue;
    if (!isPriceActive(pl, today)) continue;
    const products = pl.products || [];
    const found = products.find(p => p.product_id === productId);
    const price = found && found.price != null ? found.price
      : (products.includes(productId) && pl.default_price != null ? pl.default_price : null);
    if (price != null && (best === null || price < best)) best = price;
  }
  return best;
}

// 价变审计事件载荷（E15：价格变更留痕 → 事件总线 audit 事件：before/after + actor + timestamp）
export function priceChangePayload({ productId, priceListId, before, after, actor }) {
  return {
    kind: 'price_change',
    product_id: productId,
    price_list_id: priceListId,
    before,
    after,
    actor: actor || 'system',
    changed_at: new Date().toISOString(),
  };
}

// 追加价变日志（change_log 数组追加；幂等：同 price_list/product/before/after 不重复登记）
// 幂等判据**刻意不含 changed_at**：changed_at 由 new Date().toISOString() 生成（毫秒级），
// 纳入判据会使幂等形同虚设——两次相同价变只要跨毫秒就会被判为不同记录而重复登记
// （2026-09-03 全量回归实测：机器负载高时两调用跨毫秒 → price-calc 幂等用例时红时绿）。
// 业务语义上「同一价格表同一产品的同一 before→after 价变」即重复，与发生时刻无关。
export function appendChangeLog(change_log = [], change) {
  const exists = change_log.some(c => c.product_id === change.product_id
    && c.price_list_id === change.price_list_id
    && c.before === change.before && c.after === change.after);
  if (exists) return change_log;
  return [...change_log, change];
}

// 四级定价链取价：产品价 → 价格表（无则回退产品价）→（报价/合同在写时管线取用）
export function resolvePrice(product, priceLists, { today = new Date() } = {}) {
  if (!product) return null;
  const listPrice = getUnitPrice(product.id || product.product_id, priceLists, { today });
  if (listPrice != null) return listPrice;
  return product.price != null ? product.price : null; // 回退产品单价值
}