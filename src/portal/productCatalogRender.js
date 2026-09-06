// src/portal/productCatalogRender.js — 产品目录维护面渲染纯函数子模块（零服务端 import）
// 架构纪律（2026-08-27 QA）：浏览器 ESM 可加载，禁止 express/db import。
// 实施：docs/superpowers/plans/2026-08-28-business-master-data-impl.md Task 2
// 数据载体：CRM_PRODUCT 粒子（crm.particles + payload JSONB）；写经 POST /api/particles（决策第0闸）
export const PRODUCT_FIELDS = ['name', 'unit', 'category', 'list_price', 'status'];

import { tenantCell } from './tenantScopeBar.js';

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 校验新建/编辑 payload；返回 { ok, errors, normalized }
export function validateProductPatch(p = {}) {
  const keys = Object.keys(p || {});
  const unknown = keys.filter((k) => !PRODUCT_FIELDS.includes(k));
  if (unknown.length) return { ok: false, errors: [`不可编辑字段: ${unknown.join(', ')}（仅 ${PRODUCT_FIELDS.join('/')}）`] };
  if (!keys.length) return { ok: false, errors: ['无有效字段'] };
  const errors = [];
  const n = {};
  if ('name' in p) {
    if (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 128) errors.push('name 须为 1–128 字非空字符串');
    else n.name = p.name.trim();
  }
  if ('unit' in p) n.unit = String(p.unit ?? '');
  if ('category' in p) n.category = String(p.category ?? '');
  if ('list_price' in p) {
    const v = Number(p.list_price);
    if (!isFinite(v) || v < 0) errors.push('list_price 须为 ≥0 的数值');
    else n.list_price = v;
  }
  if ('status' in p) n.status = String(p.status ?? 'on_sale');
  return { ok: errors.length === 0, errors, normalized: n };
}

// 列表渲染（含软停用操作，禁物理删除）
// opts.showTenant（仅 admin/sysadmin 为 true）：附加「租户」列，opts.tenantMap 提供 tenant_id→name
export function renderProductList(items = [], opts = {}) {
  const { showTenant = false, tenantMap = {} } = opts;
  if (!items.length) return '<div class="empty">暂无产品（新建第一条）</div>';
  const rows = items
    .map((it) => {
      const state = it.state || it.payload?.status || 'on_sale';
      const stopped = state === 'discontinued';
      const badge = stopped
        ? '<span class="pc-badge pc-badge-off">已停用</span>'
        : '<span class="pc-badge pc-badge-on">在售</span>';
      const action = stopped
        ? '<span class="tag-stopped">已停用</span>'
        : `<crm-button class="btn danger" data-stop="${esc(it.id)}">停用</crm-button>`;
      return `<tr data-state="${esc(state)}">
        <td>${esc(it.payload?.name || '')}</td>
        <td>${esc(it.payload?.unit || '')}</td>
        <td>${esc(it.payload?.category || '')}</td>
        <td>${esc(it.payload?.list_price ?? '')}</td>
        <td>${badge}</td>
        ${showTenant ? tenantCell(it.tenant_id, tenantMap) : ''}
        <td>${action}</td>
      </tr>`;
    })
    .join('');
  return `<table class="bd-tbl"><thead><tr><th>名称</th><th>单位</th><th>品类</th><th>目录价</th><th>状态</th>${showTenant ? '<th>租户</th>' : ''}<th>操作</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// 新建表单（crm-* 组件，满足 ui-lint R4）
export function renderProductForm() {
  return `<form id="pf" class="pf">
    <div class="pf-row"><label>名称</label><crm-input name="name" required maxlength="128" placeholder="产品名称"></crm-input></div>
    <div class="pf-row"><label>单位</label><crm-input name="unit" placeholder="件 / 套 / 个"></crm-input></div>
    <div class="pf-row"><label>品类</label><crm-input name="category" placeholder="品类"></crm-input></div>
    <div class="pf-row"><label>目录价</label><crm-input name="list_price" type="number" min="0" step="0.01" placeholder="0.00"></crm-input></div>
    <div class="pf-row"><label>状态</label><crm-select name="status"><option value="on_sale" selected>on_sale</option><option value="discontinued">discontinued</option></crm-select></div>
    <crm-button type="submit" class="btn primary">新建</crm-button>
  </form>`;
}
