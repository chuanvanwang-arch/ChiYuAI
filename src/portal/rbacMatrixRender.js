// src/portal/rbacMatrixRender.js — rbacMatrixRender.js 渲染纯函数子模块（浏览器 ESM 可加载）
// 根因修复（2026-08-27）：源 rbacMatrix.js 顶层含 Node-only import
// （express / ../db.js / ../decision/* / ../alerts/*）→ 浏览器原生 ESM 加载报
// "Failed to resolve module specifier 'express'" → 页面脚本崩溃（列表不渲染/按钮不绑定）。
// 本文件仅含渲染纯函数（零服务端 import），浏览器与 vitest 均可直接 import。
// 服务端 router 仍保留在 rbacMatrix.js（routes.js 继续 import 它）；页面 import 改指向本文件。

// src/portal/rbacMatrix.js — RBAC 矩阵配置（第 13 项）
// 渲染纯函数（浏览器 + vitest 共用） + 表驱动 GET/PUT 端点（决策第0闸）
// 设计输入：docs/superpowers/plans/2026-08-27-rbac-matrix.md
// 载体：crm.role_context_profile.data_scope {model:'self'|'org_subtree'|'all'|'domain', domain?:[...]}
// 引擎 enforceScope(src/context/scope.js:81) 比对 data_scope.domain vs 粒子 type(全名 CRM_*)

// 业务可授权粒子（矩阵列，canonical CRM_* 名）
export const BUSINESS_PARTICLES = [
  'CRM_DEAL',
  'CRM_QUOTATION',
  'CRM_CONTRACT',
  'CRM_ORDER',
  'CRM_PAYMENT_PLAN',
  'CRM_PAYMENT_RECORD',
  'CRM_INVOICE',
  'CRM_TECHNICAL_PROPOSAL',
  'CRM_ACCOUNT',
  'CRM_CONTACT',
  'CRM_ORGANIZATION',
  'CRM_PERSON',
];

// 已知短别名 → canonical（修正种子历史不一致 payment/contract/invoice）
const DOMAIN_ALIAS = {
  payment: 'CRM_PAYMENT_RECORD',
  contract: 'CRM_CONTRACT',
  invoice: 'CRM_INVOICE',
  deal: 'CRM_DEAL',
  quotation: 'CRM_QUOTATION',
  order: 'CRM_ORDER',
  account: 'CRM_ACCOUNT',
  contact: 'CRM_CONTACT',
  organization: 'CRM_ORGANIZATION',
};

export function normalizeDomainEntry(s) {
  if (!s) return s;
  if (typeof s === 'string' && s.startsWith('CRM_')) return s;
  return DOMAIN_ALIAS[s.toLowerCase()] || s;
}

export function normalizeDomain(domain = []) {
  return (domain || []).map(normalizeDomainEntry);
}

export function scopeModelLabel(model) {
  switch (model) {
    case 'self': return '仅自身';
    case 'org_subtree': return '组织内';
    case 'all': return '全量';
    case 'domain': return '按域';
    default: return model || '—';
  }
}

// 返回单元格三态：'all'（全量禁用）| 'na'（不适用 self/org_subtree）| 'on'（domain 勾选）| 'off'（domain 未勾）
export function cellState(profile, particle) {
  const ds = profile?.data_scope || {};
  const model = ds.model;
  if (model === 'all') return 'all';
  if (model === 'self' || model === 'org_subtree') return 'na';
  if (model === 'domain') {
    const allowed = normalizeDomain(ds.domain);
    return allowed.includes(particle) ? 'on' : 'off';
  }
  return 'na';
}

function cellHtml(profile, particle) {
  const st = cellState(profile, particle);
  if (st === 'all') return `<td class="cell all"><span class="badge ok" title="全量可见可操作">✓</span></td>`;
  if (st === 'na') return `<td class="cell na"><span class="badge na" title="不适用于此范围模型">⚪</span></td>`;
  // domain：可勾选
  const checked = st === 'on' ? 'checked' : '';
  return `<td class="cell onoff">
    <input type="checkbox" class="domain-chk" data-particle="${particle}" ${checked}
      title="${st === 'on' ? '在授权域内' : '不在授权域内'}" />
  </td>`;
}

export function renderRbacMatrix(profiles = [], particles = BUSINESS_PARTICLES) {
  const list = profiles.length ? profiles : [];
  if (!list.length) {
    return `<div class="empty">尚未配置任何角色数据范围（role_context_profile.data_scope）</div>`;
  }
  const headCols = particles.map((p) => `<th class="pcol" title="${p}">${p.replace('CRM_', '')}</th>`).join('');
  const ths = `<thead><tr><th>角色</th><th>范围模型</th>${headCols}</tr></thead>`;
  const trs = list
    .map((p) => {
      const ds = p.data_scope || {};
      const model = ds.model || 'self';
      const cells = particles.map((pt) => cellHtml(p, pt)).join('');
      const disabledAttr = model === 'all' ? 'disabled' : '';
      return `<tr class="rbac-row" data-role="${p.role_tag}">
        <td class="role">${p.role_tag}</td>
        <td class="model">
          <select class="model-sel" data-role="${p.role_tag}" ${disabledAttr}>
            <option value="self" ${model === 'self' ? 'selected' : ''}>仅自身</option>
            <option value="org_subtree" ${model === 'org_subtree' ? 'selected' : ''}>组织内</option>
            <option value="all" ${model === 'all' ? 'selected' : ''}>全量</option>
            <option value="domain" ${model === 'domain' ? 'selected' : ''}>按域</option>
          </select>
        </td>
        ${cells}
      </tr>`;
    })
    .join('');
  return `<table class="rbac-table">${ths}<tbody>${trs}</tbody></table>`;
}
