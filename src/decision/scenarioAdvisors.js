// src/decision/scenarioAdvisors.js — 按场景分派的业务事实采集（唯一接触 DB/业务规则的建议层）
// 设计：docs/2026-09-08-dialog-driven-decision-advice-design.md §3、§8.1（T3/T4/T5 按 agent 分派）
// 铁律：阈值一律来自 config（advisorConfig），禁硬编码业务常量；失败 fail-open 返回空事实，不抛错
import { marginView } from './offerPolicyMath.js';
import { discountAuthorityCheck } from './offerPolicyFacts.js';

export const DEFAULT_ADVISOR_CONFIG = Object.freeze({
  margin_floor_pct: 20,      // 毛利下限（%），低于即红线
  cost_estimate_ratio: 0.6,  // 无成本字段时的出厂估算比例
  stuck_days: 30,            // 阶段停留告警天数
  forgotten_days: 7,         // 近 N 天无拜访视为疏于跟进
});

// ── 报价类（quote-engine 契约 ct-quote-calc）：毛利红线 ──
// 报价毛利口径：与门户口径一致 —— 成本取自政策包 cost_structure，红线取自政策 margin_redline，
// 比较对象是 deal 报价 amount。无政策时退回 advisorConfig 出厂下限（向后兼容既有测试）。
// 折扣权限红线：角色缺失 → 仅按 default 上限提示需审批（设计 D6 降级）。
export function gatherQuoteFacts(deal, {
  advisorConfig = DEFAULT_ADVISOR_CONFIG,
  ctx = {},
  offerPolicy = null,
  discountMatrix = null,
  requestedDiscountPct = null,
} = {}) {
  const cfg = { ...DEFAULT_ADVISOR_CONFIG, ...(advisorConfig || {}) };
  const amount = Number(deal?.payload?.amount) || 0;
  const hasCost = deal?.payload?.cost !== undefined && deal?.payload?.cost !== null;
  const cost = hasCost ? Number(deal.payload.cost) : amount * cfg.cost_estimate_ratio;
  const marginPct = amount > 0 ? ((amount - cost) / amount) * 100 : 0;
  const redlines = [];
  let marginSource = hasCost ? 'actual' : 'estimated';
  let floor = null;
  let redlinePct = null;

  if (offerPolicy) {
    const mv = marginView(offerPolicy, amount);
    if (mv) {
      floor = mv.floor;
      redlinePct = mv.redline;
      marginSource = 'policy';
      if (mv.pass === false) {
        const gap = Number(((Number(mv.redline) - mv.marginRate) * 100).toFixed(2));
        redlines.push({
          cond: 'margin_redline', label: '毛利红线',
          detail: `毛利率 ${Number((mv.marginRate * 100).toFixed(1))}% < 租户红线 ${Number((mv.redline * 100).toFixed(1))}%（差 ${gap} 个百分点）`,
        });
      }
    }
  } else if (marginPct < Number(cfg.margin_floor_pct)) {
    // 无政策时退回出厂下限（向后兼容既有测试）
    redlines.push({
      cond: 'margin_redline', label: '毛利红线',
      detail: `毛利率 ${marginPct.toFixed(1)}% < 下限 ${cfg.margin_floor_pct}%`,
    });
  }

  // 折扣权限红线（角色缺失 → 仅按 default 上限提示需审批，D6 降级）
  const role = ctx?.role || null;
  if (requestedDiscountPct != null && discountMatrix) {
    const d = discountAuthorityCheck(role, requestedDiscountPct, discountMatrix);
    if (d.evaluated && d.exceeded) {
      redlines.push({
        cond: 'discount_authority_exceeded', label: '折扣超权限',
        detail: d.reason,
        gap_pct: d.gapPct, role: d.role, role_cap: d.roleCap, requested: d.requestedDiscountPct,
      });
    }
  }

  return {
    facts: {
      price_vs_floor: amount > 0 ? `报价 ${amount}，成本 ${cost.toFixed(0)}，毛利率 ${marginPct.toFixed(1)}%` : null,
      margin_pct: Number(marginPct.toFixed(2)),
      margin_source: marginSource,
      price_floor: floor,
      margin_redline: redlinePct,
    },
    redlines,
  };
}

// ── 跟进/丢单类（followup-agent 契约 ct-followup）：跟进超期 ──
export function gatherFollowupFacts(deal, { advisorConfig = DEFAULT_ADVISOR_CONFIG } = {}) {
  const cfg = { ...DEFAULT_ADVISOR_CONFIG, ...(advisorConfig || {}) };
  const raw = deal?.payload?.last_visit_at;
  const redlines = [];
  let recent_visit = null;
  let visit_source = 'none';
  if (raw) {
    const days = Math.floor((Date.now() - new Date(raw).getTime()) / 86400000);
    visit_source = 'payload';
    if (days <= Number(cfg.forgotten_days)) recent_visit = `近 ${days} 天内有拜访`;
    else redlines.push({
      cond: 'followup_overdue', label: '跟进超期',
      detail: `距上次拜访 ${days} 天，超过 ${cfg.forgotten_days} 天阈值`,
    });
  } else {
    redlines.push({ cond: 'followup_overdue', label: '跟进超期', detail: '无拜访记录（视为从未拜访）' });
  }
  const contacts = Number(deal?.payload?.contact_count);
  return {
    facts: {
      recent_visit,
      visit_source,
      role_identified: Number.isFinite(contacts) && contacts > 0 ? `已登记 ${contacts} 位联系人` : null,
    },
    redlines,
  };
}

// ── 签单风险/评审类（review-gate 契约 ct-review-gate）：阶段卡点 ──
export function gatherReviewFacts(deal, { advisorConfig = DEFAULT_ADVISOR_CONFIG } = {}) {
  const cfg = { ...DEFAULT_ADVISOR_CONFIG, ...(advisorConfig || {}) };
  const raw = deal?.payload?.stage_updated_at || deal?.updated_at;
  const redlines = [];
  let stage_freshness = null;
  if (raw) {
    const days = Math.floor((Date.now() - new Date(raw).getTime()) / 86400000);
    stage_freshness = `阶段已停留 ${days} 天`;
    if (days > Number(cfg.stuck_days)) {
      redlines.push({ cond: 'stage_stuck', label: '阶段卡点', detail: `停留 ${days} 天 > ${cfg.stuck_days} 天阈值` });
    }
  }
  // HIGH 档场景（QUOTE_PRICING/SIGN_RISK）按设计 §3 不得自治，处置由 buildAdviceCard 收敛为 ESCALATE
  return {
    facts: { stage_freshness, autonomy_allowed: false },
    redlines,
  };
}

const ADVISORS = {
  QUOTE_PRICING: gatherQuoteFacts,
  INVOICE_APPROVE: gatherQuoteFacts,
  CLIENT_STRATEGY: gatherFollowupFacts,
  LOSS_REVIEW: gatherFollowupFacts,
  DEAL_REOPEN: gatherFollowupFacts,
  SIGN_RISK: gatherReviewFacts,
  REVIEW_GATE: gatherReviewFacts,
};

export function pickAdvisor(scenario_id) {
  return ADVISORS[scenario_id] || null;
}
