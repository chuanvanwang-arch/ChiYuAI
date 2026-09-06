// src/portal/detailSections.js — 7 类业务粒子专属只读视图（浏览器 + vitest 共用 ESM，无 DOM 依赖）
// 用法：particle-detail.html 经 <script type="module"> 注入 window.renderBusinessSections 后调用。
// 数据：particle={id,type,payload,state}；edges=outEdges[{edgeType,targetType,targetId,meta}]；related={[targetId]:name}

const TYPE_BY_PATH = {
  CRM_DEAL: 'deals', CRM_QUOTATION: 'quotes', CRM_CONTRACT: 'contracts',
  CRM_ORDER: 'orders', CRM_PAYMENT_PLAN: 'payments', CRM_PAYMENT_RECORD: 'payments',
  CRM_INVOICE: 'invoices', CRM_ACCOUNT: 'accounts', CRM_TECHNICAL_PROPOSAL: 'particle-detail.html?id',
};
const SUPPORTED = new Set(Object.keys(TYPE_BY_PATH).filter((t) => t.startsWith('CRM_')));
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c] || c);
const money = (n) => {
  const v = Number(n); if (!Number.isFinite(v)) return esc(n ?? '—');
  return '¥' + v.toLocaleString('zh-CN');
};
const date = (s) => (s ? esc(String(s).slice(0, 10)) : '—');

const FK = { deal_id: 'CRM_DEAL', quotation_id: 'CRM_QUOTATION', contract_id: 'CRM_CONTRACT', order_id: 'CRM_ORDER', account_id: 'CRM_ACCOUNT' };
const FK_LABEL = { deal_id: '商机', quotation_id: '报价', contract_id: '合同', order_id: '订单', account_id: '客户' };
const foreignType = (k) => FK[k];
const labelOf = (k) => FK_LABEL[k] || k;

// 关联链接：优先 outEdge.targetType→path；其次 payload 中 *_id record-reference 字段
function relatedLinks(particle, edges, related) {
  const out = (edges || [])
    .filter((e) => TYPE_BY_PATH[e.targetType])
    .map((e) => {
      const p = TYPE_BY_PATH[e.targetType];
      const href = p.startsWith('/') ? `${p}=${esc(e.targetId)}` : `/${p}/${esc(e.targetId)}`;
      const label = related?.[e.targetId] || e.targetType;
      return `<a href="${href}">${esc(label)}</a>`;
    });
  const fromPayload = Object.entries(particle.payload || {})
    .filter(([k, v]) => /_id$/.test(k) && typeof v === 'string' && v && TYPE_BY_PATH[foreignType(k)])
    .map(([k, v]) => {
      const t = foreignType(k); const p = TYPE_BY_PATH[t];
      const href = p.startsWith('/') ? `${p}=${esc(v)}` : `/${p}/${esc(v)}`;
      return `<a href="${href}">${esc(labelOf(k))} ${esc(v)}</a>`;
    });
  const all = [...out, ...fromPayload];
  return all.length ? `<div class="edge">关联：${all.join(' · ')}</div>` : '';
}

const L2C = [
  ['lead', '线索'], ['opportunity', '商机'], ['quoted', '报价'],
  ['contracted', '合同'], ['ordered', '订单'], ['paid', '回款'],
];
function dealSection(p) {
  const stage = p.payload.stage || 'lead';
  const idx = L2C.findIndex(([s]) => s === stage);
  const steps = L2C.map(([s, label], i) => {
    const cls = i < idx ? 'done' : i === idx ? 'cur' : 'todo';
    return `<span class="l2c-step ${cls}">${label}</span>`;
  }).join('<span class="l2c-sep">›</span>');
  const term = (stage === 'lost' || stage === 'disqualified')
    ? `<span class="badge b-rule">已终止（${esc(stage)}）</span>` : '';
  const facts = [
    ['金额', money(p.payload.amount)],
    ['预计成交', date(p.payload.expected_close)],
    ['状态', esc(p.state)],
  ].map(([k, v]) => `<div class="attr"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('');
  return `<div class="card" data-section="l2c"><h3>L2C 阶段进度</h3>
    <div class="l2c">${steps}</div>${term}
    <div style="margin-top:8px">${facts}</div></div>`;
}
function quotationSection(p, edges, related) {
  const items = Array.isArray(p.payload.items) ? p.payload.items : [];
  const rows = items.length ? items.map((it) => {
    const amt = (Number(it.qty) || 0) * (Number(it.unit_price) || 0);
    return `<tr><td>${esc(it.product_id)}</td><td>${esc(it.qty)}</td><td>${money(it.unit_price)}</td><td>${money(it.discount || 0)}</td><td>${money(amt)}</td></tr>`;
  }).join('') : '<tr><td colspan="5" class="none">无明细行</td></tr>';
  return `<div class="card" data-section="quotation"><h3>报价单</h3>
    <div class="attr"><span class="k">状态</span><span class="badge b-manual">${esc(p.payload.approval_status || p.state)}</span></div>
    <div class="attr"><span class="k">有效期至</span><span class="v">${date(p.payload.valid_until)}</span></div>
    <div class="attr"><span class="k">总金额</span><span class="v">${money(p.payload.amount)}</span></div>
    <table class="pg-subtable"><thead><tr><th>产品</th><th>数量</th><th>单价</th><th>折扣</th><th>小计</th></tr></thead><tbody>${rows}</tbody></table>
    ${relatedLinks(p, edges, related)}</div>`;
}
function contractSection(p, edges, related) {
  const facts = [
    ['合同号', esc(p.payload.contract_no)], ['金额', money(p.payload.amount)],
    ['生效', date(p.payload.start_date)], ['到期', date(p.payload.end_date)],
    ['审批', esc(p.payload.approval_status || p.state)],
  ].map(([k, v]) => `<div class="attr"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('');
  return `<div class="card" data-section="contract"><h3>合同</h3>${facts}${relatedLinks(p, edges, related)}</div>`;
}
function orderSection(p, edges, related) {
  const facts = [
    ['订单号', esc(p.payload.order_no)], ['金额', money(p.payload.amount)],
    ['状态', esc(p.payload.status || p.state)],
  ].map(([k, v]) => `<div class="attr"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('');
  return `<div class="card" data-section="order"><h3>订单</h3>${facts}${relatedLinks(p, edges, related)}</div>`;
}
function paymentPlanSection(p, edges, related) {
  const facts = [
    ['计划金额', money(p.payload.plan_amount)], ['到期', date(p.payload.plan_end)],
    ['状态', esc(p.payload.plan_status || p.state)],
  ].map(([k, v]) => `<div class="attr"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('');
  return `<div class="card" data-section="payment-plan"><h3>回款计划</h3>${facts}${relatedLinks(p, edges, related)}</div>`;
}
function paymentRecordSection(p, edges, related) {
  const facts = [
    ['实收金额', money(p.payload.paid_amount)], ['收款日期', date(p.payload.paid_at)],
    ['凭证', p.payload.voucher ? `<a href="${esc(p.payload.voucher)}">查看</a>` : '—'],
  ].map(([k, v]) => `<div class="attr"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('');
  return `<div class="card" data-section="payment-record"><h3>回款记录</h3>${facts}${relatedLinks(p, edges, related)}</div>`;
}
function invoiceSection(p, edges, related) {
  const facts = [
    ['发票号', esc(p.payload.invoice_no)], ['类型', esc(p.payload.invoice_type)],
    ['金额', money(p.payload.invoice_amount)], ['开票日期', date(p.payload.invoice_date)],
    ['核销', esc(p.payload.reconcile_status || p.state)],
  ].map(([k, v]) => `<div class="attr"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('');
  return `<div class="card" data-section="invoice"><h3>发票</h3>${facts}${relatedLinks(p, edges, related)}</div>`;
}

const RENDERERS = {
  CRM_DEAL: dealSection, CRM_QUOTATION: quotationSection, CRM_CONTRACT: contractSection,
  CRM_ORDER: orderSection, CRM_PAYMENT_PLAN: paymentPlanSection,
  CRM_PAYMENT_RECORD: paymentRecordSection, CRM_INVOICE: invoiceSection,
};

export function hasBusinessSection(type) {
  return SUPPORTED.has(type) && Boolean(RENDERERS[type]);
}
export function renderBusinessSections(particle, edges = [], related = {}) {
  if (!particle || !RENDERERS[particle.type]) return '';
  try {
    return RENDERERS[particle.type](particle, edges, related);
  } catch {
    return ''; // 渲染异常不阻塞通用 dump
  }
}
