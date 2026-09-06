// src/billing/seatPolicy.js — 席位（用户数）硬封顶闸
import { query } from '../db.js';
import { getPlan } from './billingService.js';

export class SeatLimitError extends Error {
  constructor(message) { super(message); this.name = 'SeatLimitError'; this.isSeat = true; }
}

async function activeSeats(tenantId) {
  const r = await query(`SELECT count(*)::int AS n FROM crm.crm_users WHERE tenant_id=$1 AND enabled = true`, [tenantId]);
  return r.rows[0].n;
}

// 返回 { ok, mode:'unlimited'|'bill'|'block', included, used, remaining, error? }
export async function checkSeatLimit(tenantId) {
  // system 平台/内部 Agent 运行身份：恒豁免席位封顶（与 resolveEntitlements 对 system 特殊处理一致），
  // 避免内部账号扩容被免费档 included_seats(=3) 卡死；即便已超 3 席仍可继续添加。
  if (tenantId === 'system') {
    const used = await activeSeats(tenantId);
    return { ok: true, mode: 'unlimited', included: -1, used, remaining: null, exempt: true };
  }
  const plan = await getPlan(tenantId);
  const included = Number(plan.included_seats);
  const price = Number(plan.seat_unit_price) || 0;
  const used = await activeSeats(tenantId);
  if (included === -1) return { ok: true, mode: 'unlimited', included, used, remaining: null };
  if (price > 0) return { ok: true, mode: 'bill', included, used, remaining: null }; // 按席位计费，不封顶
  const remaining = Math.max(0, included - used);
  if (used >= included) {
    return { ok: false, mode: 'block', included, used, remaining: 0, error: `当前套餐席位已满（${used}/${included}），请升级套餐以添加更多成员` };
  }
  return { ok: true, mode: 'block', included, used, remaining };
}
