// src/billing/quotaGate.js — Token 超额强制闸（配置驱动：block / bill+安全上限）
import { getPlan, tokenQuota } from './billingService.js';

export class TokenQuotaError extends Error {
  constructor(message) { super(message); this.name = 'TokenQuotaError'; this.isQuota = true; }
}

// 调用前预检：免费档硬封顶（used>=included），付费档超安全上限封顶
export async function enforceTokenQuota(tenantId, period) {
  // 平台租户豁免：与 resolveEntitlements / checkSeatLimit 对 system 的特殊放行保持一致，
  // 否则内部 Agent 调用累积后会撞上免费档硬封顶，阻断平台自身 LLM 操作。
  if (tenantId === 'system') {
    const q = await tokenQuota(tenantId, period);
    return { ok: true, mode: 'unlimited', used: q.used_total, cap: null, exempt: true };
  }
  const plan = await getPlan(tenantId);
  const q = await tokenQuota(tenantId, period);
  const mode = plan.token_overage_mode || 'bill';
  const included = Number(plan.included_tokens) || 0;
  // -1 = 不限（哨兵，与 seatPolicy included_seats=-1 口径一致）：直接放行，避免负 hardCap 误封
  if (included < 0) {
    return { ok: true, mode: 'unlimited', used: q.used_total, cap: null };
  }
  const hardCap = plan.token_hard_cap != null
    ? Number(plan.token_hard_cap)
    : (mode === 'bill' ? included * 3 : included);
  if (mode === 'block' && q.used_total >= included) {
    throw new TokenQuotaError(`Token 额度已用完（${q.used_total}/${included}），请升级套餐`);
  }
  if (mode === 'bill' && q.used_total >= hardCap) {
    throw new TokenQuotaError(`本月 Token 用量已达安全上限（${q.used_total}/${hardCap}），请升级套餐或购买加量包`);
  }
  return { ok: true, mode, used: q.used_total, cap: hardCap };
}
