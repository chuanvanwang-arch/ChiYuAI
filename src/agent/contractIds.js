// src/agent/contractIds.js — 契约闭环 JOIN 键单一事实源（2026-09-01 D2 修复）
//
// 背景：契约合规矩阵用「契约块 task 标题」JOIN 运行期 episode（contractMonitor.js JOIN_KEY='task'），
//       而调度器产出的是 `intake:<uuid>:<level>:<agent>` —— 两者永不相等，真实运行 episode 无法进入矩阵，
//       矩阵长期只反映开发期手工演示数据（契约监控形同虚设）。
//
// 修复：契约块增稳定短键 `contract_task_id`，与此处映射一一对应；
//       双向一致性由 scripts/validate-contract.mjs 断言拦截（契约文档 ↔ 本文件）。
//
// 约定：key = agentSpecs 的 agent key；value = 契约键（写入 episode.context_facts.contract_task_id）
export const CONTRACT_IDS = Object.freeze({
  'intake-router': 'ct-intake-route',
  'quote-engine': 'ct-quote-calc',
  'followup-agent': 'ct-followup',
  'review-gate': 'ct-review-gate',
  'decision-retro': 'ct-retro-decision',
  'decision-agent': 'ct-decision',
});

// 调度器用：targetAgent → 契约键；未登记 agent 回退 null（调用方决定是否降级）
export function contractIdForAgent(agent) {
  return CONTRACT_IDS[agent] || null;
}

// 全部契约键（供 validate-contract 双向断言）
export function allContractIds() {
  return Object.values(CONTRACT_IDS);
}
