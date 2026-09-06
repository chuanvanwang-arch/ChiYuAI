// src/portal/offerPolicyRender.js — 报价商务规则包维护面渲染纯函数子模块（零服务端 import）
// 实施：docs/superpowers/plans/2026-08-28-business-master-data-impl.md Task 4
// 数据载体：CRM_OFFER_POLICY 粒子。嵌套结构（cost_structure/price_bands）以 JSON 文本存放于
// payload（JSONB 可任意存），UI 用 textarea 编辑，提交时 JSON.parse 校验（设计 §7 风险处理策略）。
export const OFFER_POLICY_FIELDS = ['name', 'subtype', 'cost_structure', 'price_bands', 'discount_conditions', 'margin_redline', 'tier_discount', 'change_billing', 'valid_from', 'valid_to'];
export const OFFER_SUBTYPES = ['standard', 'payment'];

import { tenantCell } from './tenantScopeBar.js';
// 允许 JSON 结构的字段（以 { 或 [ 开头时做 JSON.parse 校验，纯文本亦放行）
const JSON_FIELDS = ['cost_structure', 'price_bands', 'tier_discount', 'discount_conditions', 'change_billing'];

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

// 返回 null=空（不存）；undefined=错误（已 push errors）；字符串=合法值
function jsonField(v, label, errors) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (/^[{[]/.test(s)) {
    try { JSON.parse(s); } catch (e) { errors.push(`${label} 不是合法 JSON：${e.message}`); return undefined; }
  }
  return s;
}

export function validateOfferPolicyPatch(p = {}) {
  const keys = Object.keys(p || {});
  const unknown = keys.filter((k) => !OFFER_POLICY_FIELDS.includes(k));
  if (unknown.length) return { ok: false, errors: [`不可编辑字段: ${unknown.join(', ')}（仅 ${OFFER_POLICY_FIELDS.join('/')}）`] };
  if (!keys.length) return { ok: false, errors: ['无有效字段'] };
  const errors = [];
  const n = {};
  if ('name' in p) {
    if (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 128) errors.push('name 须为 1–128 字非空字符串');
    else n.name = p.name.trim();
  }
  if ('subtype' in p) {
    if (!OFFER_SUBTYPES.includes(p.subtype)) errors.push(`subtype 须为 ${OFFER_SUBTYPES.join('/')}`);
    else n.subtype = p.subtype;
  }
  for (const f of JSON_FIELDS) {
    if (f in p) {
      const r = jsonField(p[f], f, errors);
      if (r !== undefined && r !== null) n[f] = r;
    }
  }
  if ('margin_redline' in p) {
    const v = Number(p.margin_redline);
    if (!isFinite(v) || v < 0) errors.push('margin_redline 须为 ≥0 的数值');
    else n.margin_redline = v;
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

export function renderOfferPolicyList(items = [], opts = {}) {
  const { showTenant = false, tenantMap = {} } = opts;
  if (!items.length) return '<div class="empty">暂无商务规则包（新建第一个）</div>';
  const rows = items
    .map((it) => `<tr>
      <td>${esc(it.payload?.name || '')}</td>
      <td>${esc(it.payload?.subtype || '')}</td>
      <td>${esc(it.payload?.margin_redline ?? '')}</td>
      <td>${esc(it.payload?.valid_from || '')} ~ ${esc(it.payload?.valid_to || '')}</td>
      <td>${badgeAndAction(it, { stoppedState: 'expired', enableState: 'active', prefix: 'op' }).badge}</td>
      ${showTenant ? tenantCell(it.tenant_id, tenantMap) : ''}
      <td>${badgeAndAction(it, { stoppedState: 'expired', enableState: 'active', prefix: 'op' }).action}</td>
    </tr>`)
    .join('');
  return `<table class="bd-tbl"><thead><tr><th>名称</th><th>类型</th><th>毛利红线</th><th>有效期</th><th>状态</th>${showTenant ? '<th>租户</th>' : ''}<th>操作</th></tr></thead><tbody>${rows}</tbody></table>`;
}

export function renderOfferPolicyForm() {
  const sel = OFFER_SUBTYPES.map((s) => `<option value="${s}" ${s === 'standard' ? 'selected' : ''}>${s}</option>`).join('');
  return `<form id="opf" class="bd-form">
    <div class="bd-row"><label>名称</label><crm-input name="name" required maxlength="128"></crm-input></div>
    <div class="bd-row"><label>类型</label><crm-select name="subtype">${sel}</crm-select></div>
    <div class="bd-row"><label>成本结构 cost_structure（JSON 或文本）</label><crm-textarea name="cost_structure" rows="3" placeholder='[{"item":"实施服务","cost":8000}]'></crm-textarea></div>
    <div class="bd-row"><label>三档价 price_bands（JSON 或文本）</label><crm-textarea name="price_bands" rows="3" placeholder='{"open":120000,"target":100000,"floor":85000}'></crm-textarea></div>
    <div class="bd-row"><label>折扣对等条件</label><crm-textarea name="discount_conditions" rows="2"></crm-textarea></div>
    <div class="bd-row"><label>毛利红线</label><crm-input name="margin_redline" type="number" min="0" step="0.01"></crm-input></div>
    <div class="bd-row"><label>阶梯价</label><crm-textarea name="tier_discount" rows="2"></crm-textarea></div>
    <div class="bd-row"><label>变更计费</label><crm-input name="change_billing"></crm-input></div>
    <div class="bd-row"><label>生效日</label><crm-input name="valid_from" type="date"></crm-input></div>
    <div class="bd-row"><label>失效日</label><crm-input name="valid_to" type="date"></crm-input></div>
    <crm-button class="btn primary" type="submit">新建</crm-button>
  </form>`;
}

// —— 消费链（设计 §4）：报价毛利透视 / 三级报价决策（QUOTE_PRICING）取数 ——
// price_bands 可能以对象或 JSON 字符串存放（payload JSONB 自由形态），统一解析为对象。
export function resolvePriceBands(policy) {
  const raw = policy?.payload?.price_bands;
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  const s = String(raw).trim();
  if (!/^[{[]/.test(s)) return null;
  try { return JSON.parse(s); } catch { return null; }
}

// cost_structure 汇总（成本可透视：DEMO 案例 A）
export function costTotal(policy) {
  const raw = policy?.payload?.cost_structure;
  let items = raw;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return null;
    try { items = JSON.parse(s); } catch { return null; }
  }
  if (!Array.isArray(items)) return null;
  return items.reduce((sum, it) => sum + (Number(it?.cost) || 0), 0);
}

// 毛利透视：给定成交价，返回 { cost, margin, marginRate, pass }（pass = 不低于毛利红线）
export function marginView(policy, dealPrice) {
  const bands = resolvePriceBands(policy);
  const cost = costTotal(policy);
  const price = Number(dealPrice);
  if (!isFinite(price) || cost == null) return null;
  const margin = price - cost;
  const marginRate = price > 0 ? margin / price : 0;
  const redline = Number(policy?.payload?.margin_redline);
  const pass = isFinite(redline) ? marginRate >= redline : true;
  return { cost, margin, marginRate, floor: bands?.floor ?? null, redline: isFinite(redline) ? redline : null, pass };
}
