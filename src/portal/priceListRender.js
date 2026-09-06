// src/portal/priceListRender.js — 基础价格表维护面渲染纯函数子模块（零服务端 import）
// 实施：docs/superpowers/plans/2026-08-28-business-master-data-impl.md Task 3
// 数据载体：CRM_PRICE_LIST 粒子（模型已完整 particleModel.js:51+，本次仅补 UI 维护面）
// 消费方：报价自动取价 priceCalc.js / quoteService.js（fillUnitPrices → getUnitPrice）
export const PRICE_LIST_FIELDS = ['name', 'valid_from', 'valid_to', 'permission', 'products', 'change_log'];
export const PERMISSIONS = ['public', 'internal', 'restricted'];

import { tenantCell } from './tenantScopeBar.js';

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function validatePriceListPatch(p = {}) {
  const keys = Object.keys(p || {});
  const unknown = keys.filter((k) => !PRICE_LIST_FIELDS.includes(k));
  if (unknown.length) return { ok: false, errors: [`不可编辑字段: ${unknown.join(', ')}（仅 ${PRICE_LIST_FIELDS.join('/')}）`] };
  if (!keys.length) return { ok: false, errors: ['无有效字段'] };
  const errors = [];
  const n = {};
  if ('name' in p) {
    if (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 128) errors.push('name 须为 1–128 字非空字符串');
    else n.name = p.name.trim();
  }
  for (const d of ['valid_from', 'valid_to']) {
    if (d in p) {
      const v = String(p[d] ?? '').trim();
      if (!v) n[d] = null;
      else if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) errors.push(`${d} 须为 YYYY-MM-DD 日期`);
      else n[d] = v;
    }
  }
  if ('permission' in p) {
    if (!PERMISSIONS.includes(p.permission)) errors.push(`permission 须为 ${PERMISSIONS.join('/')}`);
    else n.permission = p.permission;
  }
  if ('products' in p) {
    // 逗号分隔多值 → 数组（对齐 coreAttributes products: 'multi-select'）
    n.products = String(p.products ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  }
  if ('change_log' in p) n.change_log = String(p.change_log ?? '');
  if (n.valid_from && n.valid_to && n.valid_from > n.valid_to) errors.push('valid_from 不得晚于 valid_to');
  return { ok: errors.length === 0, errors, normalized: n };
}

export function renderPriceList(items = [], opts = {}) {
  const { showTenant = false, tenantMap = {} } = opts;
  if (!items.length) return '<div class="empty">暂无价格表（新建第一套）</div>';
  const rows = items
    .map((it) => {
      const stopped = (it.state || '') === 'expired';
      const badge = stopped
        ? '<span class="pl-badge pl-badge-off">已停用</span>'
        : '<span class="pl-badge pl-badge-on">启用</span>';
      const action = stopped
        ? `<crm-button class="btn" data-set="${esc(it.id)}" data-state="active">启用</crm-button>`
        : `<crm-button class="btn danger" data-set="${esc(it.id)}" data-state="expired">停用</crm-button>`;
      const prods = Array.isArray(it.payload?.products) ? it.payload.products.join('、') : (it.payload?.products || '');
      return `<tr>
        <td>${esc(it.payload?.name || '')}</td>
        <td>${esc(it.payload?.valid_from || '')} ~ ${esc(it.payload?.valid_to || '')}</td>
        <td>${esc(it.payload?.permission || '')}</td>
        <td>${esc(prods)}</td>
        <td>${badge}</td>
        ${showTenant ? tenantCell(it.tenant_id, tenantMap) : ''}
        <td>${action}</td>
      </tr>`;
    })
    .join('');
  return `<table class="bd-tbl"><thead><tr><th>名称</th><th>有效期</th><th>权限</th><th>产品</th><th>状态</th>${showTenant ? '<th>租户</th>' : ''}<th>操作</th></tr></thead><tbody>${rows}</tbody></table>`;
}

export function renderPriceListForm() {
  const sel = PERMISSIONS.map((p) => `<option value="${p}" ${p === 'internal' ? 'selected' : ''}>${p}</option>`).join('');
  return `<form id="plf" class="bd-form">
    <div class="bd-row"><label>名称</label><crm-input name="name" required maxlength="128"></crm-input></div>
    <div class="bd-row"><label>生效日</label><crm-input name="valid_from" type="date"></crm-input></div>
    <div class="bd-row"><label>失效日</label><crm-input name="valid_to" type="date"></crm-input></div>
    <div class="bd-row"><label>权限</label><crm-select name="permission">${sel}</crm-select></div>
    <div class="bd-row"><label>产品（逗号分隔）</label><crm-input name="products" placeholder="CRM 标准版,实施服务"></crm-input></div>
    <crm-button class="btn primary" type="submit">新建</crm-button>
  </form>`;
}
