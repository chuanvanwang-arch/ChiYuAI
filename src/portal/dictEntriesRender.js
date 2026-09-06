// src/portal/dictEntriesRender.js — 字典值域维护面渲染纯函数子模块（零服务端 import）
// 实施：docs/superpowers/plans/2026-08-28-business-master-data-impl.md Task 5
// 数据载体：CRM_DICT_ENTRY 粒子。活跃项供 meta-attr 元模型 select 下拉消费（设计 §4 字典联动）。
// 与 CRM_KNOWLEDGE 词汇体系同源（可互查/联动）；禁删 = 软停用（state → deprecated）。
export const DICT_KEYS = ['industry', 'size', 'region', 'contact_level', 'decision_power', 'payment_method'];
export const DICT_FIELDS = ['dict_key', 'dict_value', 'sort_order', 'active'];

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

export function validateDictPatch(p = {}) {
  const keys = Object.keys(p || {});
  const unknown = keys.filter((k) => !DICT_FIELDS.includes(k));
  if (unknown.length) return { ok: false, errors: [`不可编辑字段: ${unknown.join(', ')}（仅 ${DICT_FIELDS.join('/')}）`] };
  if (!keys.length) return { ok: false, errors: ['无有效字段'] };
  const errors = [];
  const n = {};
  if ('dict_key' in p) {
    if (!DICT_KEYS.includes(p.dict_key)) errors.push(`dict_key 须为 ${DICT_KEYS.join('/')}`);
    else n.dict_key = p.dict_key;
  }
  if ('dict_value' in p) {
    if (typeof p.dict_value !== 'string' || !p.dict_value.trim() || p.dict_value.length > 64)
      errors.push('dict_value 须为 1–64 字非空字符串');
    else n.dict_value = p.dict_value.trim();
  }
  if ('sort_order' in p) {
    const v = Number(p.sort_order);
    if (!Number.isInteger(v) || v < 0 || v > 9999) errors.push('sort_order 须为 0–9999 的整数');
    else n.sort_order = v;
  }
  if ('active' in p) n.active = p.active === true || p.active === 'true' || p.active === 'on';
  return { ok: errors.length === 0, errors, normalized: n };
}

export function renderDictList(items = [], opts = {}) {
  const { showTenant = false, tenantMap = {} } = opts;
  if (!items.length) return '<div class="empty">暂无字典项（新建第一条）</div>';
  const rows = items
    .map((it) => `<tr>
      <td>${esc(it.payload?.dict_key || '')}</td>
      <td>${esc(it.payload?.dict_value || '')}</td>
      <td>${esc(it.payload?.sort_order ?? 0)}</td>
      <td>${it.payload?.active === false ? '否' : '是'}</td>
      <td>${badgeAndAction(it, { stoppedState: 'deprecated', enableState: null, prefix: 'de', stopAttr: 'data-stop' }).badge}</td>
      ${showTenant ? tenantCell(it.tenant_id, tenantMap) : ''}
      <td>${badgeAndAction(it, { stoppedState: 'deprecated', enableState: null, prefix: 'de', stopAttr: 'data-stop' }).action}</td>
    </tr>`)
    .join('');
  return `<table class="bd-tbl"><thead><tr><th>字典键</th><th>字典值</th><th>排序</th><th>启用</th><th>状态</th>${showTenant ? '<th>租户</th>' : ''}<th>操作</th></tr></thead><tbody>${rows}</tbody></table>`;
}

export function renderDictForm() {
  const sel = DICT_KEYS.map((k) => `<option value="${k}">${k}</option>`).join('');
  return `<form id="df" class="bd-form">
    <div class="bd-row"><label>字典键</label><crm-select name="dict_key">${sel}</crm-select></div>
    <div class="bd-row"><label>字典值</label><crm-input name="dict_value" required maxlength="64"></crm-input></div>
    <div class="bd-row"><label>排序</label><crm-input name="sort_order" type="number" min="0" max="9999" value="0"></crm-input></div>
    <div class="bd-row"><crm-checkbox name="active" checked>启用</crm-checkbox></div>
    <crm-button class="btn primary" type="submit">新建</crm-button>
  </form>`;
}

// 消费链（设计 §4「字典联动」）：供 meta-attr 元模型 select 下拉 / 商机·客户表单消费。
// 只取未软停用（state=registered）且 active!==false 的项，按 sort_order 升序。
export function activeDictValues(items = [], key = '') {
  return (items || [])
    .filter((it) => it.state === 'registered' && it.payload?.active !== false && (!key || it.payload?.dict_key === key))
    .sort((a, b) => (a.payload?.sort_order ?? 0) - (b.payload?.sort_order ?? 0))
    .map((it) => it.payload?.dict_value)
    .filter(Boolean);
}
