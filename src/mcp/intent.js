// src/mcp/intent.js — 意图校正：在角色基线合法域内按本次操作数据域聚焦（只聚焦、不升权）
// 设计输入：docs/superpowers/specs/2026-08-26-mcp-role-binding-design.md §5
// 纪律：绝不放大权限（effective_role 恒等于 baseRole）；越域仅标记 over_scope 供展示，
//       拒绝仍由既有第 1.5 闸按 action.rbac_roles 决定（本引擎不替代安全闸）。
import { getAction } from '../action/registry.js';
import { loadProfile } from '../context/roleProfiles.js';

// 域标签归一（Action 侧 CRM_* 大写前缀 ↔ profile 侧小写；仅桥接，不新增业务域）
// 覆盖 seed-actions.js:628/643/662/675 全部 data_scope_domains + roleProfiles.js 各 profile domain
export const DOMAIN_ALIAS = {
  CRM_CUSTOMER: 'customer',
  CRM_DEAL: 'CRM_DEAL',
  CRM_CONTRACT: 'contract',
  CRM_INVOICE: 'invoice',
  CRM_PAYMENT_RECORD: 'payment',
  CRM_TECHNICAL_PROPOSAL: 'CRM_TECHNICAL_PROPOSAL',
};
export const norm = (d) => DOMAIN_ALIAS[d] || d;

// 基线角色的合法数据域（来自 role_context_profile.data_scope）
// model: all → 'ALL'；domain → 归一后的域数组；self/org_subtree → 'ALL'（由 Action 自身 owner 过滤，域聚焦无意义）
async function baseDomains(baseRole) {
  const p = await loadProfile(baseRole);
  if (!p) return [];
  const m = p.data_scope?.model || p.data_scope?.modelType;
  if (m === 'all') return 'ALL';
  if (m === 'domain') return (p.data_scope.domain || []).map(norm);
  return 'ALL';
}

// 返回 { effective_role, focus_domain, over_scope, denied_domains }
// 不修改 role；越域不放大权限，仅标记 over_scope 供展示（第 1.5 闸按 rbac_roles 决定拒绝）
export async function resolveEffectiveRole(baseRole, actionName, scopes = {}) {
  const def = getAction(actionName);
  const actionDomains = (def?.data_scope_domains || []).map(norm);
  const denied = (scopes?.deny_domains || []).map(norm);
  const base = await baseDomains(baseRole);

  if (base === 'ALL' || !Array.isArray(base) || base.length === 0) {
    const focus = actionDomains.filter(d => !denied.includes(d));
    return { effective_role: baseRole, focus_domain: focus, over_scope: false, denied_domains: denied };
  }
  const focus = actionDomains.filter(d => base.includes(d) && !denied.includes(d));
  const over_scope = actionDomains.some(d => !base.includes(d));
  return { effective_role: baseRole, focus_domain: focus, over_scope, denied_domains: denied };
}