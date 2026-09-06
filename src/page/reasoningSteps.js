// src/page/reasoningSteps.js — reasoning-trace 服务端算真状态判定内核（T1）
// 设计输入：docs/specs/2026-08-29-dead-info-revive-design.md §3.1（方案 B：7 页 reasoning-trace 由 handler
//           按真实 facts 算 status，不再回传 schema 写死的状态）
// 契约：label → (facts) => status 判定表；未命中规则保留原 status（不丢信息）；label 永远保留。
// 判定状态四态对齐 renderer 语义：ok（绿）/ warn（黄）/ pending（进行中）/ idle（未触发）。
// 调用方：routes.js 各 handler + controlledConfigPages.js（S30 工厂注入）。

// 每页 label → 状态计算（facts 由 handler 按真实数据组装）
const RULES = {
  // S02 作战室：任务队列驱动
  '意图解析': (f) => (f.hasTasks ? 'ok' : 'idle'),
  '上下文装配': (f) => (f.tasksHasContext ? 'ok' : 'idle'),
  '切入建议': (f) => (f.hasActionableTask ? 'ok' : 'idle'),
  // S06 客户360：画像/七维/洞察
  '画像装配': (f) => (f.profileFilled ? 'ok' : 'idle'),
  '七维校验': (f) => (f.sevenDimCovered ? 'ok' : 'warn'),
  '洞察建议': (f) => (f.tasksNonEmpty ? 'ok' : 'idle'),
  // S07 商机：MEDDICC/决策历史/推进
  'MEDDICC 评估': (f) => (f.meddiccFilled ? 'ok' : 'warn'),
  '决策历史': (f) => (f.hasDecisionHistory ? 'ok' : 'warn'),
  '推进建议': (f) => (f.hasFollowupTask ? 'ok' : 'idle'),
  // S09 合同：条款/回款风险/修订
  '条款解析': (f) => (f.hasClause ? 'ok' : 'idle'),
  '回款风险': (f) => (f.hasOverduePlan ? 'warn' : 'ok'),
  '修订建议': (f) => (f.hasOverduePlan ? 'pending' : 'idle'),
  // S14 决策图：决策/关联/因果
  '决策加载': (f) => (f.hasDecision ? 'ok' : 'idle'),
  '关联展开': (f) => (f.hasEdges ? 'ok' : 'idle'),
  '因果链': (f) => (f.hasTrace ? 'ok' : 'idle'),
  // S30 决策市场：覆盖/先例/偏差
  '覆盖度加载': (f) => (f.hasDecision ? 'ok' : 'idle'),
  '先例匹配': (f) => (f.hasPrecedent ? 'ok' : 'idle'),
  '偏差分析': (f) => (f.hasException ? 'warn' : 'idle'),
  // S35 客户洞察：聚合/裁剪/建议
  '聚合四源数据': (f) => (f.timelineNonEmpty ? 'ok' : 'idle'),
  '权限裁剪': (f) => (f.roleHasPerm ? 'ok' : 'idle'),
  '生成下一步建议': (f) => (f.tasksNonEmpty ? 'ok' : 'idle'),
};

/**
 * 按真实 facts 重算 schema 写死 steps 的 status。
 * @param {Array<{status?:string, label:string}>} schemaSteps schema 中写死的 steps
 * @param {object} facts handler 组装的真实判定输入
 * @returns {Array<{status:string, label:string}>}
 */
export function buildReasoningSteps(schemaSteps, facts) {
  return (schemaSteps || []).map((s) => {
    const calc = RULES[s.label];
    if (!calc) return { status: s.status, label: s.label }; // 未命中规则 → 保持原 status
    return { status: calc(facts || {}), label: s.label };
  });
}