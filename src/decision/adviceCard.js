// src/decision/adviceCard.js — 决策建议卡装配（条件体检 + A/B/C 三档）
// 设计：docs/2026-09-08-dialog-driven-decision-advice-design.md §3
// 铁律：纯函数、不碰 DB、不调用 LLM；红线判定由 scenarioAdvisors 传入（业务知识不在此层硬编码）
//
// ⚠ 轴声明（E2，2026-09-16）——本函数输出的 `tier` 是【建议档｜轴=ADVICE_MATURITY】，取值 A/B/C，
//   与 crm.business_tier_config 的【项目分级｜轴=OBJECT_RISK】A/B/C 是**两条独立且方向相反**的轴：
//
//     | 值 | 建议档（本文件，证据成熟度）          | 项目分级（businessTier，对象风险）      |
//     | -  | ------------------------------------ | --------------------------------------- |
//     | A  | 证据齐备 → APPROVE（可自治处置）      | 高风险 → HIGH（一律升级）               |
//     | B  | 红线命中 / HIGH 级场景 → ESCALATE     | NORMAL                                  |
//     | C  | 证据不足 → 只补信息，**禁止处置**     | 低风险 → LEAD（可自治）                 |
//
//   即「建议档 A」的风险方向 ≈「项目分级 C」。**两轴禁止直接比较、禁止互相赋值**——
//   跨轴投影的唯一合法路径是 decision/adviceStore.js 的保守投影（仅 A→NORMAL，其余→HIGH）。
export const ADVICE_TIER_AXIS = 'ADVICE_MATURITY';
export const ADVICE_TIERS = Object.freeze(['A', 'B', 'C']);

import { buildApprovalPrefill } from './offerPolicyFacts.js';


export function evaluateConditions(eval_dimensions = [], facts = {}) {
  const list = Array.isArray(eval_dimensions) ? eval_dimensions : [];
  const satisfied = [];
  const missing = [];
  let sw = 0;
  let tw = 0;
  for (const d of list) {
    const w = Number(d?.weight) || 0;
    tw += w;
    const v = facts?.[d?.cond];
    if (v !== undefined && v !== null && v !== '') { satisfied.push({ ...d, value: v }); sw += w; }
    else missing.push({ ...d });
  }
  return {
    satisfied, missing,
    requiredMissing: missing.filter((m) => m.required === true),
    coverage: tw > 0 ? sw / tw : 0,
  };
}

export function buildAdviceCard({ scenario = {}, coordinate = {}, facts = {}, redlines = [], precedents = [] } = {}) {
  const dims = Array.isArray(scenario.eval_dimensions) ? scenario.eval_dimensions : [];
  const ev = evaluateConditions(dims, facts);
  const passLine = Number(scenario.rubric_pass_line) || 0.6;
  const confidence = coordinate.confidence || 'low';
  const stage = coordinate.stage || null;

  // 档位判定顺序（2026-09-08 E2E 实测修正，勿调换顺序）：
  //  ① 无体检维度 → C 档。空集合陷阱：eval_dimensions 未加载时 requiredMissing 恒为 0，
  //     若直接判 A 档会「零条件＝全部齐备」，实测让「客户要求 8 折」拿到 A 档自治处置，违反设计 §3 红线。
  //  ② 置信度低 / required 缺失 → C 档（只补信息，不给处置）。
  //  ③ 触碰红线 → B 档（必须走审批流）。
  //  ④ HIGH 级场景（QUOTE_PRICING/SIGN_RISK，db/seed.sql:253,257 default_tier='HIGH'）→ 封顶 B 档，
  //     即使条件齐备也不得给 A 档自治处置（设计 §3「折扣/签单类一律走 B 档以上，不得自治」）。
  //     判据用 default_tier 而非 autonomous_allowed：后者表级默认 FALSE（db/schema.sql:126），
  //     若以其为判据会让 A 档永不出现，与三档设计矛盾。
  const hasRedline = Array.isArray(redlines) && redlines.length > 0;
  const highTier = String(scenario.default_tier || '').toUpperCase() === 'HIGH';
  const evidenceThin = ev.coverage < passLine;

  let tier;
  let disposition = null;
  if (hasRedline) { tier = 'B'; disposition = 'ESCALATE'; }
  else if (dims.length === 0) { tier = 'C'; disposition = null; }
  else if (confidence !== 'high') tier = 'C';
  else if (ev.requiredMissing.length > 0) tier = 'C';
  else if (evidenceThin) tier = 'C';
  else if (highTier) { tier = 'B'; disposition = 'ESCALATE'; }
  else { tier = 'A'; disposition = 'APPROVE'; }

  const gaps = [...ev.requiredMissing, ...ev.missing.filter((m) => m.required !== true)]
    .sort((a, b) => (Number(b.weight) || 0) - (Number(a.weight) || 0))
    .map((m) => ({ cond: m.cond, label: m.label, weight: Number(m.weight) || 0 }));

  // B 档红线命中 → 预填审批发起参数（系统不自动写，由销售/客户端显式发起 crm-approval-start 带 HITL token）
  const approval_prefill = (tier === 'B')
    ? buildApprovalPrefill({
        scenario_id: coordinate.scenario_id || scenario.scenario_id || null,
        deal_id: coordinate.deal_id || null,
        redlines,
      })
    : null;

  return {
    tier,
    disposition,
    scenario_id: coordinate.scenario_id || scenario.scenario_id || null,
    stage,
    headline: `${scenario.stage || coordinate.scenario_id || '未定位'}${stage ? ` · ${stage}` : ''}｜建议档位 ${tier}`,
    tier_reason:
      hasRedline ? '触碰业务红线 → 必须走审批流'
        : dims.length === 0 ? '场景条件缺失（eval_dimensions 未加载），无法体检 → 降级 C 档'
          : confidence !== 'high' ? '坐标置信度不足 → 只补信息'
            : ev.requiredMissing.length > 0 ? '必填条件缺失 → 只补信息'
              : evidenceThin ? `证据充分度 ${ev.coverage.toFixed(2)} < 及格线 ${passLine} → 只补信息`
                : highTier ? 'HIGH 级场景（报价/签单类）禁止自治 → 封顶 B 档'
                  : '条件齐备且证据充分',
    reasons: ev.satisfied.map((s) => ({ cond: s.cond, label: s.label, value: s.value })),
    gaps,
    redlines: Array.isArray(redlines) ? redlines : [],
    approval_flow: tier === 'B' ? 'CRM_APPROVAL_FLOW' : null,
    approval_prefill,
    precedents: Array.isArray(precedents) ? precedents : [],
    coverage: Number(ev.coverage.toFixed(4)),
    confidence,
  };
}
