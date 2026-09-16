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
    // E2（2026-09-16）跨轴保守投影 —— 建议档(ADVICE_MATURITY, A/B/C) → 落库分级(LEAD/NORMAL/HIGH)。
    //
    // ⚠ 两轴方向相反（声明见 adviceCard.js 顶部）：建议档 A=证据齐备(可放手) ≈ 项目分级 C=低风险(可放手)。
    //   故**不得按字面同值映射**。投影规则（保守优先）：
    //     建议档 A（证据齐备且场景非 HIGH 级）→ NORMAL（唯一可自主放行的来源）
    //     建议档 B（红线/HIGH 级场景，须审批）+ C（证据不足，禁止处置）→ **一律 HIGH**（升级给人）
    //
    // 修正记录：历史实现为 `advice.tier === 'B' ? 'HIGH' : 'NORMAL'`，把 **C 档投影成 NORMAL（=可自主）**，
    //   而 C 档恰是"证据不足、只补信息"最不该自主的一档 —— 语义反转。本文件当前零生产调用
    //   （唯一调用者是 test/decision/advice-store.test.js），故修正不改变任何运行时行为。
    //
    // ⚠ 接线前置（T19/建议落库任务须遵守）：锚点**不得**以建议档冒充业务分级。真正接线时应让调用方
    //   用 computeBusinessTier(customer, project) 取真实 A 轴分级；本字段仅为建议落库时的兜底投影。
    business_tier: advice.tier === 'A' ? 'NORMAL' : 'HIGH',
    state: ADVISED_STATE,
    tenantId,
  };
}
