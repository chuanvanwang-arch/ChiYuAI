// src/billing/pricing.js — 计价纯函数（按账号/席位单线，零 DB、可单测）
// 模型：2026-09-04 批准修订——「按账号/席位单线」计费，无独立 Token 超量费（Token 用量含于套餐，不单列超量）
//   - 账号费 = seat_unit_price × 席位（免费版 / 本地旗舰版 seat_unit_price=0 → 不计费 / 面议）
//   - token_fee 恒为 0（设计 §4 / §5：取消独立 Token 计量计费线）
// 全部参数来自 config_store['billing-plans']（禁硬编码）

export const DEFAULT_PLAN = {
  plan_id: 'free',
  name: '免费版',
  base_fee: 0,
  included_seats: 0,
  seat_unit_price: 0,
  included_tokens: 0,
  token_overage_unit_price: 0,
  entitlements: [],
};

export function computeBilling(plan, tokenIn, tokenOut, seatCount) {
  plan = plan || DEFAULT_PLAN;
  const seats = Number(seatCount) || 0;
  // 按账号/席位单线：账号费 = 席位 × 单席价；无独立 Token 超量费（token_fee 恒 0）
  const seatFee = Number(plan.seat_unit_price || 0) * seats;
  const round2 = (n) => Math.round(n * 100) / 100;
  return {
    seat_count: seats,
    seat_fee: round2(seatFee),
    token_fee: 0,
    total_fee: round2(seatFee),
  };
}
