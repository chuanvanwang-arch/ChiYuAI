// src/decision/adviseService.js — 建议编排：坐标 → 事实 → 建议卡
// 设计：docs/2026-09-08-dialog-driven-decision-advice-design.md §2、§3
// 铁律：fail-open（任何异常降级为 C 档空建议，绝不阻断业务读写）；对话原文不落库
import { query } from '../db.js';
import { resolveCoordinate } from './dialogAdvisor.js';
import { buildAdviceCard } from './adviceCard.js';
import { pickAdvisor, DEFAULT_ADVISOR_CONFIG, gatherQuoteFacts } from './scenarioAdvisors.js';
import { resolveOfferPolicy, resolveRequestedDiscount } from './offerPolicyFacts.js';
import { actorRole } from '../context/scope.js';
import { readConfig } from '../config/configStore.js';
import { buildRequirementConditions } from './requirementConditions.js';

export function buildAdvisorConfig(cfg) {
  return { ...DEFAULT_ADVISOR_CONFIG, ...(cfg || {}) };
}

// 加载场景定义（eval_dimensions / default_tier / rubric_pass_line）。
// 租户范式对齐 executor.js:26 getScenario：租户专属行优先，缺失回退 system。
// fail-open：读失败返回 null，由 adviceCard 按「维度缺失」降级 C 档，绝不阻断读写主链路。
//
// 2026-09-08 E2E 实测：本函数为补齐项——原实现从不加载场景行，导致 eval_dimensions 恒空，
// 「零条件＝全部齐备」让折扣诉求直接拿到 A 档自治处置（违反设计 §3 红线）。
export async function loadScenarioRow(scenario_id, tenantId = 'system') {
  if (!scenario_id) return null;
  try {
    const r = await query(
      `SELECT scenario_id, default_tier, autonomous_allowed, rubric_pass_line, eval_dimensions
       FROM crm.decision_scenario
       WHERE scenario_id=$1 AND (tenant_id=$2 OR tenant_id='system')
       ORDER BY (tenant_id=$2) DESC LIMIT 1`,
      [scenario_id, tenantId],
    );
    const row = r.rows[0] || null;
    // JSONB 防御：非数组一律视为未配置（记忆铁律：读 JSONB 须 Array.isArray）
    if (row && !Array.isArray(row.eval_dimensions)) row.eval_dimensions = [];
    return row;
  } catch {
    return null;
  }
}

export async function advise({ utterance = '', ctx = {}, scenario = null, deal = null, stage = null, advisorConfig = null } = {}) {
  try {
    const coordinate = resolveCoordinate({ utterance, stage });
    const scenario_id = coordinate.scenario_id || scenario?.scenario_id || null;
    const advisor = scenario_id ? pickAdvisor(scenario_id) : null;
    const tenantId = ctx?.tenantId || 'system';

    // 角色解析（缺 → null，折扣判定走 default 上限，设计 D6 降级）；ctx.role 优先，否则从 actor 解析
    const role = ctx?.role || (await actorRole(ctx).then((r) => r?.role_tag || null).catch(() => null));

    const isQuote = scenario_id === 'QUOTE_PRICING' || scenario_id === 'INVOICE_APPROVE';
    // 报价类场景解析租户政策与授权矩阵（fail-open：解析失败退 null，退回出厂下限）
    const offerPolicy = isQuote
      ? await resolveOfferPolicy(tenantId, { dealId: deal?.id || null }).catch(() => null)
      : null;
    const discountMatrix = isQuote
      ? await readConfig('price-authority', { tenantId }).then((r) => r?.value || null).catch(() => null)
      : null;
    const requestedDiscountPct = deal ? resolveRequestedDiscount(deal) : null;

    const gathered = advisor && deal
      ? advisor(deal, { advisorConfig: buildAdvisorConfig(advisorConfig), ctx: { ...ctx, role }, offerPolicy, discountMatrix, requestedDiscountPct })
      : { facts: {}, redlines: [] };

    // 红线跨场景复用：review/sign 场景持 deal 时也并算报价红线（设计 T8）——覆盖租户政策与折扣权限
    if (deal && !isQuote) {
      const q = gatherQuoteFacts(deal, { advisorConfig: buildAdvisorConfig(advisorConfig), ctx: { ...ctx, role }, offerPolicy, discountMatrix, requestedDiscountPct });
      for (const rl of q.redlines) if (!gathered.redlines.some((x) => x.cond === rl.cond)) gathered.redlines.push(rl);
    }

    // MUST 需求维度注入体检（未确认 → requiredMissing → C 档降级）
    const scenarioRow = await loadScenarioRow(scenario_id, tenantId);
    const reqc = deal ? await buildRequirementConditions(deal.id, tenantId) : { evalDimensions: [], facts: {} };
    const mergedScenario = {
      ...(scenarioRow || {}), ...(scenario || {}), scenario_id,
      eval_dimensions: [...(scenarioRow?.eval_dimensions || []), ...reqc.evalDimensions],
    };

    const card = buildAdviceCard({
      scenario: mergedScenario,
      coordinate: { ...coordinate, scenario_id, deal_id: deal?.id || null },
      facts: { ...(gathered.facts || {}), ...reqc.facts },
      redlines: gathered.redlines || [],
    });

    const hits = coordinate.candidates?.[0]?.hits || [];
    return { ok: true, advice: { ...card, hits } };
  } catch (e) {
    return {
      ok: true,
      advice: { tier: 'C', disposition: null, scenario_id: null, stage: stage || null, gaps: [], redlines: [], reasons: [] },
      degraded: { reason: String(e?.message || e) },
    };
  }
}
