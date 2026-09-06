// src/portal/paymentPolicyRender.js — 回款政策维护面渲染纯函数子模块（零服务端 import）
// 实施：docs/superpowers/plans/2026-08-28-business-master-data-impl.md Task 6
// 数据载体：复用 CRM_OFFER_POLICY 粒子，subtype='payment'（设计 §3.2 第 5 面"或独立粒子"的复用分支）。
// 消费方：财务应收 → 回款政策（账期/分级）→ 催收建议（设计 §4 第 5 行，预警触发已有 #21，本面补业务参数）。
export const PAYMENT_FIELDS = ['name', 'subtype', 'payment_term', 'collection_tier', 'prepay_ratio', 'valid_from', 'valid_to'];
export const COLLECTION_TIERS = ['沟通', '施压', '法务'];
export const PAYMENT_SUBTYPE = 'payment';

import { tenantCell } from './tenantScopeBar.js';

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 软停用状态 → 徽章 + 操作按钮（crm-button，修 ui-lint R4）
// stoppedState: 停用态值；enableState: 启用态值（null=不提供启用按钮，仅停用）
function badgeAndAction(it, { stoppedState, enableState, prefix, stopAttr = 'data-set' }) {
  const stopped = (it.state || '') === stoppedState;
  const badge = stopped
    ? `<span class="${prefix}-badge ${prefix}-badge-off">已停用</span>`
    : `<span class="${prefix}-badge ${prefix}-badge-on">启用</span>`;
  let action;
  if (stopped && enableState) action = `<crm-button class="btn" ${stopAttr}="${esc(it.id)}" data-state="${enableState}">启用</crm-button>`;
  else if (stopped) action = '<span class="tag-stopped">已停用</span>';
  else action = `<crm-button class="btn danger" ${stopAttr}="${esc(it.id)}" data-state="${stoppedState}">停用</crm-button>`;
  return { badge, action };
}

export function validatePaymentPatch(p = {}) {
  const keys = Object.keys(p || {});
  const unknown = keys.filter((k) => !PAYMENT_FIELDS.includes(k));
  if (unknown.length) return { ok: false, errors: [`不可编辑字段: ${unknown.join(', ')}（仅 ${PAYMENT_FIELDS.join('/')}）`] };
  if (!keys.length) return { ok: false, errors: ['无有效字段'] };
  const errors = [];
  const n = {};
  if ('name' in p) {
    if (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 128) errors.push('name 须为 1–128 字非空字符串');
    else n.name = p.name.trim();
  }
  if ('subtype' in p) {
    if (p.subtype !== PAYMENT_SUBTYPE) errors.push(`subtype 须为 ${PAYMENT_SUBTYPE}`);
    else n.subtype = p.subtype;
  }
  if ('payment_term' in p) {
    const v = Number(p.payment_term);
    if (!Number.isInteger(v) || v < 0 || v > 365) errors.push('payment_term 须为 0–365 的整数（天）');
    else n.payment_term = v;
  }
  if ('collection_tier' in p) {
    if (!COLLECTION_TIERS.includes(p.collection_tier)) errors.push(`collection_tier 须为 ${COLLECTION_TIERS.join('/')}`);
    else n.collection_tier = p.collection_tier;
  }
  if ('prepay_ratio' in p) {
    const v = Number(p.prepay_ratio);
    if (!isFinite(v) || v < 0 || v > 100) errors.push('prepay_ratio 须为 0–100 的数值（百分比）');
    else n.prepay_ratio = v;
  }
  for (const d of ['valid_from', 'valid_to']) {
    if (d in p) {
      const v = String(p[d] ?? '').trim();
      if (!v) n[d] = null;
      else if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) errors.push(`${d} 须为 YYYY-MM-DD 日期`);
      else n[d] = v;
    }
  }
  if (n.valid_from && n.valid_to && n.valid_from > n.valid_to) errors.push('valid_from 不得晚于 valid_to');
  return { ok: errors.length === 0, errors, normalized: n };
}

export function renderPaymentList(items = [], opts = {}) {
  const { showTenant = false, tenantMap = {} } = opts;
  if (!items.length) return '<div class="empty">暂无回款政策（新建第一条）</div>';
  const rows = items
    .map((it) => `<tr>
      <td>${esc(it.payload?.name || '')}</td>
      <td>${esc(it.payload?.payment_term ?? '')}</td>
      <td>${esc(it.payload?.collection_tier || '')}</td>
      <td>${esc(it.payload?.prepay_ratio ?? '')}</td>
      <td>${esc(it.payload?.valid_from || '')} ~ ${esc(it.payload?.valid_to || '')}</td>
      <td>${badgeAndAction(it, { stoppedState: 'expired', enableState: 'active', prefix: 'pp' }).badge}</td>
      ${showTenant ? tenantCell(it.tenant_id, tenantMap) : ''}
      <td>${badgeAndAction(it, { stoppedState: 'expired', enableState: 'active', prefix: 'pp' }).action}</td>
    </tr>`)
    .join('');
  return `<table class="bd-tbl"><thead><tr><th>名称</th><th>账期(天)</th><th>催收分级</th><th>预付比例(%)</th><th>有效期</th><th>状态</th>${showTenant ? '<th>租户</th>' : ''}<th>操作</th></tr></thead><tbody>${rows}</tbody></table>`;
}

export function renderPaymentForm() {
  const sel = COLLECTION_TIERS.map((t) => `<option value="${t}" ${t === '沟通' ? 'selected' : ''}>${t}</option>`).join('');
  return `<form id="ppf" class="bd-form">
    <div class="bd-row"><label>名称</label><crm-input name="name" required maxlength="128"></crm-input></div>
    <div class="bd-row"><label>账期（天）</label><crm-input name="payment_term" type="number" min="0" max="365" value="30"></crm-input></div>
    <div class="bd-row"><label>催收分级</label><crm-select name="collection_tier">${sel}</crm-select></div>
    <div class="bd-row"><label>预付比例（%）</label><crm-input name="prepay_ratio" type="number" min="0" max="100" step="0.1" value="0"></crm-input></div>
    <div class="bd-row"><label>生效日</label><crm-input name="valid_from" type="date"></crm-input></div>
    <div class="bd-row"><label>失效日</label><crm-input name="valid_to" type="date"></crm-input></div>
    <crm-button class="btn primary" type="submit">新建</crm-button>
  </form>`;
}
