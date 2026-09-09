// src/decision/offerPolicyFacts.js
// 报价事实/授权/审批预填的纯函数与 DB 解析层（后端，零 UI 依赖）
//
// 本文件分阶段落地（见实施计划）：
// - T1：discountAuthorityCheck（折扣授权矩阵判定，纯）
// - T2：resolveOfferPolicy / buildApprovalPrefill / resolveRequestedDiscount

import { queryParticles } from '../particles/particleRepo.js';
import { marginView } from './offerPolicyMath.js';

// —— 折扣授权矩阵判定（纯）——
// matrix: { default_max_discount_pct:number, roles: { [role]: { max_discount_pct:number } } }
export function discountAuthorityCheck(role, requestedDiscountPct, matrix) {
  if (!matrix || requestedDiscountPct == null || Number.isNaN(Number(requestedDiscountPct))) {
    return { evaluated: false, exceeded: false, reason: 'matrix 或 requestedDiscountPct 缺失 → fail-open 不阻断' };
  }
  const pct = Number(requestedDiscountPct);
  const roles = matrix.roles || {};
  const cap = (role && roles[role] && Number.isFinite(Number(roles[role].max_discount_pct)))
    ? Number(roles[role].max_discount_pct)
    : Number(matrix.default_max_discount_pct ?? 0);
  const exceeded = pct > cap;
  return {
    evaluated: true,
    exceeded,
    role: role || null,
    requestedDiscountPct: pct,
    roleCap: cap,
    gapPct: exceeded ? Number((pct - cap).toFixed(2)) : 0,
    reason: exceeded
      ? `折扣 ${pct}% 超出 ${role || '默认'} 权限上限 ${cap}%`
      : `折扣 ${pct}% 在 ${role || '默认'} 权限上限 ${cap}% 内`,
  };
}

// 解析租户当前生效的报价政策（优先级：deal 关联 > subtype=standard active > 其余 active）
// fail-open：任何异常返回 null（决策侧退回 advisorConfig 出厂下限，不阻断）
export async function resolveOfferPolicy(tenantId = 'system', { dealId = null } = {}) {
  try {
    const items = await queryParticles({
      type: 'CRM_OFFER_POLICY', tenantId, excludeStates: ['expired'], limit: 50,
    });
    if (!items.length) return null;
    const active = items.filter((p) => p.state === 'active');
    const pool = active.length ? active : items;
    if (dealId) {
      const linked = pool.find((p) => String(p.payload?.deal_id) === String(dealId));
      if (linked) return linked;
    }
    const standard = pool.find((p) => p.payload?.subtype === 'standard');
    return standard || pool[0];
  } catch {
    return null;
  }
}

// 红线命中 → 预填 crm-approval-start 参数（系统不自动写，由销售/客户端显式发起）
export function buildApprovalPrefill({ scenario_id, deal_id, redlines = [] } = {}) {
  const reasons = Array.isArray(redlines)
    ? redlines.map((r) => `${r.label}：${r.detail}`).join('；')
    : '';
  return {
    flow_id: 'CRM_APPROVAL_FLOW',
    business_type: scenario_id || 'QUOTE_PRICING',
    business_id: deal_id || null,
    approvers: [], // 留空 → 由审批引擎按流配置解析；显式指定须覆盖全节点（engine 侧 fail-closed）
    reason: reasons || '触碰业务红线，须走审批流',
    note: '系统不自动发起审批。请销售或客户端显式调用 crm-approval-start（携带 HITL confirmation token），生成 decision_id 后方可继续报价写操作。',
    action: 'crm-approval-start',
  };
}

// 从 deal 解析请求折扣百分比（优先 discount_pct，其次 list_price/amount 反算）
export function resolveRequestedDiscount(deal) {
  const p = deal?.payload || {};
  if (p.discount_pct != null && p.discount_pct !== '') return Number(p.discount_pct);
  if (Number(p.list_price) > 0 && Number(p.amount) > 0) {
    return Number((((Number(p.list_price) - Number(p.amount)) / Number(p.list_price)) * 100).toFixed(2));
  }
  return null;
}
