// src/portal/businessClosureRender.js — L2C 业务闭环看板渲染纯函数子模块
// QA 安全范式（本会话根因 A 教训）：渲染与 Router 分文件，浏览器可原生 ESM 加载；
// 本文件零 express/db.js/服务端 import；服务端逻辑在 businessBoard.js。
// 设计输入：docs/2026-08-28-business-closure-design.md

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ¥ 千分位格式化；null/undefined/NaN → 「—」
function fmtMoney(n) {
  if (n == null || (typeof n === 'number' && Number.isNaN(n))) return '—';
  const num = Number(n);
  if (!Number.isFinite(num)) return '—';
  return '¥' + num.toLocaleString('zh-CN');
}

// 条目下钻 URL（对齐设计 §3.4，复用现有 detail 页）
function drillUrl(item) {
  const id = esc(item.id || '');
  switch (item.type) {
    case 'CRM_DEAL': return `/deal-detail.html?id=${id}`;
    case 'CRM_QUOTATION': return `/quotation-detail.html?id=${id}`;
    case 'CRM_CONTRACT': return `/contract-detail.html?id=${id}`;
    case 'CRM_ORDER': return `/order-detail.html?id=${id}`;
    case 'CRM_PAYMENT_PLAN':
    case 'CRM_PAYMENT_RECORD':
    case 'CRM_INVOICE': return `/payment-detail.html?id=${id}`;
    case 'CRM_ACCOUNT': return `/particle-detail.html?type=CRM_ACCOUNT&id=${id}`;
    default: return '#';
  }
}

// 单阶段卡
function renderStageCard(stage) {
  if (!stage) return '';
  const items = Array.isArray(stage.items) ? stage.items.slice(0, 5) : [];
  const rows = items.map((it) => `
      <a class="pg-row" href="${drillUrl(it)}">
        <span class="pg-row-title">${esc(it.title || it.id || '未命名')}</span>
        <span class="pg-row-amt">${fmtMoney(it.amount)}</span>
      </a>`).join('');
  const empty = items.length === 0 ? '<div class="pg-empty">暂无数据</div>' : '';
  return `<div class="pg-card" id="stage-${esc(stage.key)}">
    <h3><a href="#${esc(stage.key)}">${esc(stage.label)}</a></h3>
    <div class="pg-meta">
      <span class="pg-badge">${stage.count || 0} 条</span>
      <span class="pg-amt">${fmtMoney(stage.totalAmount)}</span>
    </div>
    <div class="pg-rows">${rows}${empty}</div>
  </div>`;
}

// 主渲染：data = { stages, publicPool, privateLeads, total }
// 2026-09-11 T9：原 leadPool 单列拆为 公海(S0) + 私海线索(S0P/S1) 两列。
export function renderBusinessClosure(data) {
  const d = data || {};
  const stages = Array.isArray(d.stages) ? d.stages : [];
  if (stages.length === 0) {
    return `<div class="pg-page"><div class="pg-empty">暂无业务数据</div></div>`;
  }
  const cards = stages.map(renderStageCard).join('');
  const publicPool = d.publicPool || { count: 0, note: '' };
  // 向后兼容：老响应只有 leadPool 时降级读它，避免灰度期渲染空白
  const privateLeads = d.privateLeads != null ? d.privateLeads : (d.leadPool?.count || 0);
  const total = d.total || { dealAmount: 0, contractAmount: 0, receivedAmount: 0 };
  return `<div class="pg-page">
    <div class="portal-head">
      <h2>🎯 L2C 业务闭环</h2>
      <div class="pg-leadpool">🎣 公海 ${publicPool.count || 0} 条 · 🧭 私海线索 ${privateLeads} 条 · ${esc(publicPool.note || '')}</div>
    </div>
    <div class="pg-grid">${cards}</div>
    <div class="pg-total">
      <span>商机总额 ${fmtMoney(total.dealAmount)}</span>
      <span>合同总额 ${fmtMoney(total.contractAmount)}</span>
      <span>已回款 ${fmtMoney(total.receivedAmount)}</span>
    </div>
  </div>`;
}

export { esc, fmtMoney, drillUrl };
