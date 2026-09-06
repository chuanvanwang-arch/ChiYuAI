// src/portal/businessDataCenter.js — 业务主数据门户总览（纯函数，浏览器 + vitest 共用）
// 设计：2026-08-28-business-master-data-design.md（业务主数据配置体系）
// 实施：docs/superpowers/plans/2026-08-28-business-master-data-impl.md Task 1
// 边界铁律：与配置中心（configCenter.js，18 项平台/治理类）分离——本门户承载业务主数据。
// 载统一走 crm.particles 粒子；写经决策第 0 闸；禁删 = 软停用（state 流转）。

// 5 个 P0 配置面（对齐设计 §3.2）
export const BUSINESS_DATA_ITEMS = [
  { id: 1, name: '产品目录', group: '主数据', page: '/product-catalog.html', endpoint: '/api/particles?type=CRM_PRODUCT', note: '名称/单位/品类/目录价/状态，软停用（discontinued）' },
  { id: 2, name: '基础价格表', group: '主数据', page: '/price-list.html', endpoint: '/api/particles?type=CRM_PRICE_LIST', note: '多套定价/有效期/权限/变更日志，软停用（expired）' },
  { id: 3, name: '报价商务规则包', group: '主数据', page: '/offer-policy.html', endpoint: '/api/particles?type=CRM_OFFER_POLICY', note: '成本结构/三档价/折扣对等/毛利红线/阶梯价/变更计费' },
  { id: 4, name: '字典值域', group: '主数据', page: '/dict-entries.html', endpoint: '/api/particles?type=CRM_DICT_ENTRY', note: '行业/规模/区域/对接人级别/决策力/付款方式等值域' },
  { id: 5, name: '回款政策', group: '主数据', page: '/payment-policy.html', endpoint: '/api/particles?type=CRM_OFFER_POLICY&subtype=payment', note: '账期/催收分级（沟通·施压·法务）/预付比例' },
  { id: 6, name: '指名客户管理', group: '客户管理', page: '/named-account-manage.html', endpoint: '/api/board/named-account-manage', note: '客户×销售责任分配 + 拜访频次达标统计与告警提醒' },
];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function cardHtml(it) {
  return `<article class="cfg-card" data-id="${esc(it.id)}">
    <div class="cfg-head"><h4>${esc(it.name)}</h4></div>
    <p class="cfg-sum">${esc(it.note || '')}</p>
    <div class="cfg-act"><a class="btn" href="${esc(it.page)}">打开</a></div>
  </article>`;
}

// 门户总览渲染（同构 configCenter.js renderConfigCenter 卡片范式）
export function renderBusinessDataCenter(items = BUSINESS_DATA_ITEMS) {
  const groups = {};
  for (const it of items) (groups[it.group] ||= []).push(it);
  const sections = Object.entries(groups)
    .map(
      ([g, list]) => `<section class="cfg-group" data-group="${esc(g)}"><h3>${esc(g)} <span class="cnt">${list.length}</span></h3>
    <div class="cfg-grid">${list.map(cardHtml).join('')}</div></section>`
    )
    .join('');
  return `<div class="config-center" id="businessDataCenter">共 <b>${items.length}</b> 个配置面${sections}</div>`;
}
