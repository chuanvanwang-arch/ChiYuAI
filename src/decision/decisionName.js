// 决策可读名称推导（纯函数，零依赖）——【C 方案 2026-09-03】根治「名称」列空白的单一事实源。
// 被 src/decision/decisionRepo.js 的 createDecision 与 scripts/backfill-decision-display-name.mjs 复用，
// 保证「写时生成」与「历史回填」使用同一套规则，避免双轨漂移。
//
// 优先级：
//   ① trigger_context.name（历史兼容：早期 LEAD_FOLLOW_UP 手工数据已带此字段）
//   ② 场景标签 + deal_id/action/customer 拼接（覆盖 QUOTE_PRICING / LOSS_REVIEW 等未填 .name 的场景）

export const SCENARIO_LABELS = {
  LEAD_FOLLOW_UP: '线索',
  OPP_QUALIFY: '商机确认',
  SOLUTION_VALUE: '方案价值',
  QUOTE_PRICING: '报价',
  SIGN_RISK: '签约风险',
  POST_CONTRACT: '履约',
  LOSS_REVIEW: '失单回顾',
  DEAL_REOPEN: '商机重开',
  CALIBRATION_CHANGE: '校准变更',
};

export function deriveDisplayName(scenario_id, trigger_context = {}) {
  const tc = trigger_context && typeof trigger_context === 'object' ? trigger_context : {};
  if (typeof tc.name === 'string' && tc.name.trim()) return tc.name.trim();

  const label = SCENARIO_LABELS[scenario_id] || scenario_id || '决策';
  const parts = [label];
  if (tc.deal_id) parts.push('#' + String(tc.deal_id).slice(0, 8));
  const extra = tc.customer || tc.project || tc.action || tc.reason || tc.to || null;
  if (typeof extra === 'string' && extra.trim()) parts.push(extra.trim());
  return parts.join(' · ');
}
