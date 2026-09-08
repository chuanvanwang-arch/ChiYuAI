// src/decision/adviceStore.js — 建议落锚点（对话原文零落库，只存结构化坐标与摘要）
// 设计：docs/2026-09-08-dialog-driven-decision-advice-design.md §5
// 铁律：禁删；state='ADVISED' 不进 DISPOSABLE_STATES，不污染 escalate 统计；**不存对话原文**
//
// 2026-09-08 设计纠偏（执行期发现）：原计划「摘要 = utterance 前 120 字」与已批准前提 D2
//   （对话原文不落库）直接冲突——截断原文仍是原文片段。此处改为结构化摘要：
//   只落「场景@阶段 + 命中关键词」，函数签名不接受 utterance，杜绝误落库。
export const ADVISED_STATE = 'ADVISED';
const SUMMARY_MAX = 120;

// 结构化诉求摘要：不含任何对话原文
export function buildStructuredSummary(advice = {}) {
  const hits = Array.isArray(advice.hits) && advice.hits.length ? advice.hits.join('/') : '无关键词命中';
  return `${advice.scenario_id || '未定位'}@${advice.stage || 'S?'}｜诉求关键词:${hits}`.slice(0, SUMMARY_MAX);
}

export function buildAdviceAnchor({ advice = {}, summary = null, tenantId = 'system' } = {}) {
  if (!advice.scenario_id) return null;
  return {
    scenario_id: advice.scenario_id,
    trigger_context: {
      scenario_id: advice.scenario_id,
      stage: advice.stage || null,
      tier: advice.tier || null,
      summary: String(summary || buildStructuredSummary(advice)).slice(0, SUMMARY_MAX),
      source: 'dialog-advisor',
    },
    involved_entities: [],
    conditions_evaluated: (advice.reasons || []).concat(advice.gaps || []),
    disposition: advice.disposition || 'ESCALATE',
    decider_type: 'AGENT_ADVICE',
    rationale: `对话建议 ${advice.tier || 'C'} 档（覆盖率 ${advice.coverage ?? 0}）`,
    business_tier: advice.tier === 'B' ? 'HIGH' : 'NORMAL',
    state: ADVISED_STATE,
    tenantId,
  };
}
