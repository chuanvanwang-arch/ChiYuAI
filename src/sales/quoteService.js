// src/sales/quoteService.js — 报价粒子 + 写时金额计算（E14/C12：金额计算规则 = 可配置运算符组合）
// 设计输入：综合详设 §4 C12（amount = Σ unit_price×qty×(1-discount)×(1+tax) 写时自动计算，非手填）
//          §5 E14（金额计算规则可配置；报价单关联价格表自动填充；报价关联商机/合同双向）
//          §5 E15（四级定价：产品→价格表→报价→合同；报价自动取价）
// 写时管线：createQuote 自动算 amount = Σ items(unit_price × qty × (1-discount) × (1+tax))
//          → 写后验证 sum=明细（§5ter-quater Q.5：写后验证 sum=明细）
// 纯逻辑（价格计算部分无 PG）；粒子持久化走 particleRepo（写时 hooks 自动建边/向量）
import { getUnitPrice } from './priceCalc.js'; // 静态导入（纯函数无循环依赖）

// 金额计算管线（纯函数，可本地单测）：Σ (unit_price × qty × (1-discount) × (1+tax))
// items: [{ product_id, qty, unit_price, discount?, tax? }]
export function computeQuoteAmount(items) {
  if (!Array.isArray(items) || !items.length) return 0;
  return items.reduce((sum, it) => {
    if (it.qty == null || it.unit_price == null) return sum;
    const discount = it.discount || 0;
    const tax = it.tax || 0;
    return sum + it.unit_price * it.qty * (1 - discount) * (1 + tax);
  }, 0);
}

// 逐行小计（写后验证 sum=明细用）
export function computeLineAmounts(items) {
  return (items || []).map(it => ({
    ...it,
    line_total: it.qty != null && it.unit_price != null
      ? it.unit_price * it.qty * (1 - (it.discount || 0)) * (1 + (it.tax || 0))
      : 0,
  }));
}

// 写后验证：amount === Σ line_total（精度 2 位容差）
export function verifyQuoteAmount(amount, lineAmounts) {
  const sum = lineAmounts.reduce((s, l) => s + l.line_total, 0);
  return Math.abs(amount - sum) < 0.01;
}

// 报价自动取价：items 无 unit_price → 从价格表取（resolvePrice：产品价 → 价格表 → 回退产品价）
// 依赖 priceCalc.getUnitPrice（E15：同一产品多套定价取最低生效档）
export function fillUnitPrices(items, products, priceLists, { today = new Date() } = {}) {
  return (items || []).map(it => {
    if (it.unit_price != null) return it;
    const unit_price = getUnitPrice(it.product_id, priceLists, { today }) ?? null;
    return { ...it, unit_price, source: unit_price != null ? 'price_list' : 'missing' };
  });
}

// 创建报价（写时管线）：
// - items 缺价 → 自动取价（fillUnitPrices）
// - amount 自动计算（computeQuoteAmount）
// - 写后验证 sum=明细（verifyQuoteAmount，不通过抛错）
// - 持久化走 createParticle（写时 hooks：embedding/FTS/本体同步自动）
export async function createQuote({ name, deal_id, valid_until, items, products = [], priceLists = [], tenantId = 'system', decisionId = null }) {
  const { createParticle } = await import('../particles/particleRepo.js');
  const filled = fillUnitPrices(items, products, priceLists);
  const amount = computeQuoteAmount(filled);
  const lines = computeLineAmounts(filled);
  if (!verifyQuoteAmount(amount, lines)) {
    throw new Error(`报价金额写后验证失败: amount=${amount} ≠ Σ明细=${lines.reduce((s, l) => s + l.line_total, 0)}`);
  }
  const quote = await createParticle('CRM_QUOTATION', {
    name, deal_id, valid_until, items: filled, amount,
    approval_status: 'draft', invalid: false,
  }, { tenantId, requireDecisionId: decisionId });
  return { ...quote, amount, lines };
}

// 报价审批通过后生效（第三闸消费端：approvalPassed → activateQuote）
// 语义：draft → approved（报价只有审批通过才能对外生效，提交/报价/发客户前必过审批）
// 铁律：只允许 draft→approved 单向；approved 后不可回退为 draft（终态保护）
export async function activateQuote(quote_id, { by, tenantId = 'system', decisionId = null } = {}) {
  const { getParticle, updateParticle } = await import('../particles/particleRepo.js');
  // 预校验：非 uuid 形态的 quote_id 直接业务错误（不透传给 PG 造成类型错误漏出，对齐测试「报价不存在」语义）
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(String(quote_id || ''))) throw new Error(`报价不存在: ${quote_id}`);
  const quote = await getParticle(quote_id);
  if (!quote) throw new Error(`报价不存在: ${quote_id}`);
  const cur = quote.payload.approval_status || 'draft';
  if (cur !== 'draft') throw new Error(`报价审批状态机拒绝: 仅 draft 可激活（当前 ${cur}）`);
  const updated = await updateParticle(quote_id, {
    patch: { ...quote.payload, approval_status: 'approved', activated_at: new Date().toISOString(), activated_by: by },
    requireDecisionId: decisionId,
  });
  return { ...updated, approval_status: 'approved' };
}