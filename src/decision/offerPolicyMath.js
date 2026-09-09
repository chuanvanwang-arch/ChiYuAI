// src/decision/offerPolicyMath.js
// 后端毛利计算纯函数。与门户 src/portal/offerPolicyRender.js 的 marginView 保持同口径，
// 但本模块零 UI 依赖（门户模块 import 了浏览器全局 sessionStorage，禁止在后端引入）。
// 若门户口径变更，须同步本文件（单一事实源约束见设计文档 §4 风险登记）。

export function resolvePriceBands(policy) {
  const raw = policy?.payload?.price_bands;
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  const s = String(raw).trim();
  if (!/^[{[]/.test(s)) return null;
  try { return JSON.parse(s); } catch { return null; }
}

export function costTotal(policy) {
  const raw = policy?.payload?.cost_structure;
  let items = raw;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return null;
    try { items = JSON.parse(s); } catch { return null; }
  }
  if (!Array.isArray(items)) return null;
  return items.reduce((sum, it) => sum + (Number(it?.cost) || 0), 0);
}

// marginView(policy, dealPrice) → { cost, margin, marginRate, floor, redline, pass }
// 注意：redline 直接采用 payload.margin_redline（门户同口径：0.2 表示 20%）。
export function marginView(policy, dealPrice) {
  const bands = resolvePriceBands(policy);
  const cost = costTotal(policy);
  const price = Number(dealPrice);
  if (!isFinite(price) || cost == null) return null;
  const margin = price - cost;
  const marginRate = price > 0 ? margin / price : 0;
  const redline = Number(policy?.payload?.margin_redline);
  const pass = isFinite(redline) ? marginRate >= redline : true;
  return {
    cost, margin, marginRate,
    floor: bands?.floor ?? null,
    redline: isFinite(redline) ? redline : null,
    pass,
  };
}
