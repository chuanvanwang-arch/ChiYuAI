// src/decision/adviseService.js — 建议编排：坐标 → 事实 → 建议卡
// 设计：docs/2026-09-08-dialog-driven-decision-advice-design.md §2、§3
// 铁律：fail-open（任何异常降级为 C 档空建议，绝不阻断业务读写）；对话原文不落库
import { resolveCoordinate } from './dialogAdvisor.js';
import { buildAdviceCard } from './adviceCard.js';
import { pickAdvisor, DEFAULT_ADVISOR_CONFIG } from './scenarioAdvisors.js';

export function buildAdvisorConfig(cfg) {
  return { ...DEFAULT_ADVISOR_CONFIG, ...(cfg || {}) };
}

export async function advise({ utterance = '', ctx = {}, scenario = null, deal = null, stage = null, advisorConfig = null } = {}) {
  try {
    const coordinate = resolveCoordinate({ utterance, stage });
    const scenario_id = coordinate.scenario_id || scenario?.scenario_id || null;
    const advisor = scenario_id ? pickAdvisor(scenario_id) : null;
    const gathered = advisor && deal ? advisor(deal, { advisorConfig: buildAdvisorConfig(advisorConfig), ctx }) : { facts: {}, redlines: [] };
    const card = buildAdviceCard({
      scenario: { ...(scenario || {}), scenario_id },
      coordinate: { ...coordinate, scenario_id },
      facts: gathered.facts || {},
      redlines: gathered.redlines || [],
    });
    // 命中关键词随建议卡返回：① 供前端解释「为什么定位到该场景」；② 供 adviceStore 生成结构化锚点摘要
    //   （不落对话原文，只落关键词，符合 D2）
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
