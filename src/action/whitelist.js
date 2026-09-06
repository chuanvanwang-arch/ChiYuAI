// src/action/whitelist.js — 对话式写入白名单 + blast-radius 分级（C2）
// 白名单内：允许经 action-confirm 对话入口自主写入（autonomous）
// 非白名单：对话入口默认拒绝，需显式 ctx.authorizedWrite=true（HITL/系统调用）才放行（human_gate）
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
