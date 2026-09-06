// src/portal/alertRuleConfigRender.js — alertRuleConfigRender.js 渲染纯函数子模块（浏览器 ESM 可加载）
// 根因修复（2026-08-27）：源 alertRuleConfig.js 顶层含 Node-only import
// （express / ../db.js / ../decision/* / ../alerts/*）→ 浏览器原生 ESM 加载报
// "Failed to resolve module specifier 'express'" → 页面脚本崩溃（列表不渲染/按钮不绑定）。
// 本文件仅含渲染纯函数（零服务端 import），浏览器与 vitest 均可直接 import。
// 服务端 router 仍保留在 alertRuleConfig.js（routes.js 继续 import 它）；页面 import 改指向本文件。

// src/portal/alertRuleConfig.js — 预警规则配置（第 21 项）
// 渲染纯函数（浏览器 + vitest 共用）。预警引擎实时事实源 = alertRegistry 内存缓存；
// DB（crm.alert_rule）为持久源，异步落库 + 启动水合（见 createAlertRuleConfigRouter / hydrateAlertRules）
export const KIND_LABELS = {
  deal_stuck: '商机停滞',
  lead_overdue: '线索逾期',
  forecast_breach: '预测缺口',
  approval_bottleneck: '审批瓶颈',
  payment_due: '回款到期',
  named_visit_overdue: '指名应访逾期',
};

export function kindLabel(k) {
  return KIND_LABELS[k] || k;
}

// check_params 阈值编辑（按 kind 渲染对应字段，通用遍历对象键）
export function renderCheckParams(kind, check_params = {}) {
  const cp = check_params || {};
  const keys = Object.keys(cp);
  if (!keys.length) return `<div class="cp empty">（无阈值）</div>`;
  const rows = keys
    .map((key) => `<label class="cp-row"><span class="cp-key">${esc(key)}</span><input type="number" class="cp-val" data-key="${esc(key)}" value="${esc(cp[key])}" /></label>`)
    .join('');
  return `<div class="cp" data-kind="${esc(kind)}">${rows}</div>`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function renderAlertRules(rules = []) {
  if (!rules.length) return `<div class="empty">尚未配置任何预警规则（crm.alert_rule）</div>`;
  const rows = rules
    .map((r) => {
      const enabledChk = r.enabled ? 'checked' : '';
      return `<tr class="rule-row" data-kind="${esc(r.kind)}">
        <td class="rkind">${esc(r.kind)}</td>
        <td class="rlabel">${esc(kindLabel(r.kind))}</td>
        <td class="renabled"><label><input type="checkbox" class="r-enabled" ${enabledChk} /> 启用</label></td>
        <td class="rcp">${renderCheckParams(r.kind, r.check_params)}</td>
        <td class="rsev"><select class="r-severity">
          <option value="">默认</option>
          <option value="low"${r.severity === 'low' ? ' selected' : ''}>低</option>
          <option value="medium"${r.severity === 'medium' ? ' selected' : ''}>中</option>
          <option value="high"${r.severity === 'high' ? ' selected' : ''}>高</option>
        </select></td>
        <td class="rrole"><select class="r-target_role">
          <option value="">默认</option>
          <option value="sales"${r.target_role === 'sales' ? ' selected' : ''}>sales</option>
          <option value="manager"${r.target_role === 'manager' ? ' selected' : ''}>manager</option>
          <option value="finance"${r.target_role === 'finance' ? ' selected' : ''}>finance</option>
          <option value="contract_admin"${r.target_role === 'contract_admin' ? ' selected' : ''}>contract_admin</option>
          <option value="presales"${r.target_role === 'presales' ? ' selected' : ''}>presales</option>
          <option value="ops"${r.target_role === 'ops' ? ' selected' : ''}>ops</option>
        </select></td>
      </tr>`;
    })
    .join('');
  return `<table class="rule-table"><thead><tr>
    <th>规则</th><th>名称</th><th>启用</th><th>阈值(check_params)</th><th>严重度</th><th>目标角色</th>
  </tr></thead><tbody>${rows}</tbody></table>`;
}

export function alertRuleSummary(rules = []) {
  const list = rules || [];
  const enabled = list.filter((r) => r.enabled).length;
  return { count: list.length, enabled };
}

// check_params 校验：必须为非空普通对象（非数组、非 null）
export function validateCheckParams(cp) {
  return !!(cp && typeof cp === 'object' && !Array.isArray(cp));
}
