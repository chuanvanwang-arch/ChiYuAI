// src/feedback/discoveryMetrics.js — feedback-loop（P0#4）指标模板 + evaluator + Token 对账
// 权威来源：docs/2026-09-10-lead-discovery-design.md §9.11；方法论：ai-feedback-loop SKILL（七要素 + 三档阈值）
// 纪律：纯函数 + 常量（零 DB import）；落库经注入式 recorder（缺省复用既有 tokenAccounting，禁自造表）
import { recordTokens } from '../alerts/tokenAccounting.js';

// 七要素（ai-feedback-loop SKILL.md:143 权威定义，禁增删改名）
export const SEVEN_KEYS = Object.freeze(['direction', 'formula', 'target', 'alert', 'owner_agent', 'evaluator_skill', 'adjust_actions']);

export const METRIC_TEMPLATES = Object.freeze({
  discovered_to_won_rate: Object.freeze({
    direction: 'up',
    formula: 'COUNT(DEAL lead→closed-won)/COUNT(DEAL lead)',
    target: 0.15, alert: 0.08,
    owner_agent: 'decision-retro',
    evaluator_skill: 'method-decision-enrich',
    adjust_actions: Object.freeze(['recalibrate lead-fit scenario', 'rollback icp_draft']),
  }),
  enrichment_coverage: Object.freeze({
    direction: 'up',
    formula: '已补字段/应补字段',
    target: 0.8, alert: 0.5,
    owner_agent: 'decision-retro',
    evaluator_skill: 'method-decision-enrich',
    adjust_actions: Object.freeze(['add adapter', 'enable provider']),
  }),
  // 【C3 接入 · 设计文档 §9.11 冻结 target=0.9】持续监控闭环活跃度
  monitorAccount_refresh_rate: Object.freeze({
    direction: 'up',
    formula: '已监控账户重评分次数/应监控账户数',
    target: 0.9, alert: 0.7,
    owner_agent: 'decision-retro',
    evaluator_skill: 'method-decision-enrich',
    adjust_actions: Object.freeze(['reschedule monitor pass', 'backfill account_memory']),
  }),
});
export const METRIC_KEYS = Object.freeze(Object.keys(METRIC_TEMPLATES));
// 文档锚点：Token-业务对账的真实设施（防再自造不存在的成本台账表）
export const RECONCILE_FACILITY = 'token_accounting+reconcileTokenToBusiness';

const clamp01 = (n) => Math.max(0, Math.min(1, Number(n) || 0));

// 三档判定（纯函数；闭区间下界：value===target → green，value===alert → yellow）
export function verdictOf(template, value) {
  const v = Number(value) || 0, t = Number(template.target) || 0, a = Number(template.alert) || 0;
  if (template.direction === 'down') {            // down：越小越好
    if (v <= t) return 'green';
    if (v <= a) return 'yellow';
    return 'red';
  }
  if (v >= t) return 'green';                     // up：越大越好
  if (v >= a) return 'yellow';
  return 'red';
}

// evaluator（纯函数）：返回 { score, verdict }（test-plan 权威形状；未知指标 fail-closed）
export function evaluate(metric, value) {
  const t = METRIC_TEMPLATES[metric];
  if (!t) throw new Error(`unknown metric: ${metric}`);
  const v = Number(value) || 0;
  const score = t.direction === 'down'
    ? clamp01(v > 0 ? t.target / v : 1)
    : clamp01(t.target > 0 ? v / t.target : 0);
  return { score, verdict: verdictOf(t, v) };
}

// 红档动作（回滚草稿而非仅熔断 —— 设计文档 §9.11 硬要求）
export function actionsFor(metric, verdict) {
  const t = METRIC_TEMPLATES[metric];
  if (!t) throw new Error(`unknown metric: ${metric}`);
  return verdict === 'red' ? [...t.adjust_actions] : [];
}

// Token-业务因果对账（复用既有 token_accounting；account 维度由返回记录承载 + decision_id 关联）
export async function ledgerCost({
  accountId = null, provider = 'unknown', cost = 0, tokensIn = 0, tokensOut = 0,
  tenantId = 'system', decisionId = null, recorder = null, ts = null,
} = {}) {
  const record = recorder || recordTokens;
  await record({
    actor: 'discovery',
    action: `discovery:${provider}`,
    tokensIn, tokensOut,
    source: 'discovery-provider',
    decision_id: decisionId,
    tenantId,
    module: 'discovery',
  });
  return {
    account_id: accountId,
    provider,
    cost,
    tokens: { in: Number(tokensIn) || 0, out: Number(tokensOut) || 0 },
    decision_id: decisionId,
    tenant_id: tenantId,
    ts: ts || new Date().toISOString(),
  };
}
