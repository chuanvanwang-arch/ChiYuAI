// src/context/particleTypes.js — 业务粒子类型清单（治理写范围 exclude 清单；单一事实源）
//
// 独立模块的原因：原清单定义在 scope.js 并由 roleProfiles.js 在模块求值期（top-level）引用，
// 而 scope.js 又反向 import roleProfiles.js（loadProfile），形成 roleProfiles ↔ scope 循环依赖。
// 当 MCP 通道的 import 链先求值 scope.js 时，roleProfiles.js:26 在 scope.js 尚未定义该 const 时读取，
// 触发 ESM 暂时性死区（TDZ）ReferenceError，导致 src/mcp/server.js 启动即崩。
// 抽到无依赖的独立模块后，循环依赖消除，TDZ 不再发生。
export const BUSINESS_PARTICLE_TYPES = [
  'CRM_DEAL', 'CRM_ACCOUNT', 'CRM_CONTACT',
  'CRM_TECHNICAL_PROPOSAL', 'CRM_INVOICE', 'CRM_PAYMENT_RECORD',
  'CRM_CONTRACT', 'CRM_QUOTATION', 'CRM_ORDER',
];
