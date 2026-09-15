// src/action/whitelist.js — 对话式写入白名单 + blast-radius 分级（C2）
// 白名单内：允许经 action-confirm 对话入口自主写入（autonomous）
// 非白名单：对话入口默认拒绝，需显式 ctx.authorizedWrite=true（HITL/系统调用）才放行（human_gate）
//
// 决策记录（2026-09-11，Task 18 线索发现 ACTION 对外面）：
//   `discovery-*`（discovery-run / discovery-enrich / discovery-research）**刻意不入白名单**，
//   保持 human_gate。依据：① 三动作写主数据（CRM_ACCOUNT / CRM_CONTACT payload）且经
//   discovery-research 跨到**外联面**（Claygent 抓取 + 研究结论）；② 进白名单会使其在对话入口
//   autonomous 自主写入（无需 ctx.authorizedWrite）—— 与分析引擎铁律「跨外联走 HITL、绝不自动发信」
//   （设计 §6.2）同构。
//   闸门并非单一依赖本表：三动作另声明 `autoDecision:true` + `decisionScenario:'LEAD_FIT'` +
//   `confirm:'stage2'` + `needsApproval:true`，写通道第 0 闸（executor.js:147-149 / gateway.js:165）
//   与两阶段确认独立生效；本表只决定「是否需要在对话入口被拦」。
//   真实执行点：src/action/executor.js:149（!isWriteWhitelisted && !ctx.authorizedWrite → 拒）。
export const WRITE_WHITELIST = new Set([
  'crm-deal-advance',   // autoDecision：自身 mint decision 满足第 0 闸
  'data-particle-create', // 写创建自动补 owner_id
  'data-particle-update', // force 双闸，状态修改需显式 force
  'data-particle-attr-update', // 元模型配置变更（过第 0 闸 ATTR_SCHEMA_CHANGE）
]);

export function isWriteWhitelisted(name) {
  return WRITE_WHITELIST.has(name);
}

// blast-radius 分级：白名单内 autonomous（自主 mint/自动补 owner），非白名单 human_gate（需人工闸门）
export function writeBlastRadius(name) {
  return isWriteWhitelisted(name) ? 'autonomous' : 'human_gate';
}
