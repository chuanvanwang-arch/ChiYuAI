// src/portal/followReminder.js — 客户跟踪告警复用渲染纯函数（浏览器 + vitest 共用，零 DB / 零服务端 import）
// 复用范式：alertRuleConfigRender.js（仅渲染纯函数，页面经 /portal/followReminder.js ESM 加载）
// 数据契约：GET /api/board/named-account-manage → { rows, followReminders, lostContactCount }
//   rows[].{ id, name, owner, tier, alert('red'|'yellow'|null), overdueDays, visitDue,
//            visitTarget, visits30, lostContact, lastContactDays }
// 色值一律走 tokens 语义变量（--err / --ok / --ink / --mut / --panel / --line），零硬编码。

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 4 张 KPI 摘要卡（工作台客户跟踪业务区顶部）
// 语义：>0 染色 + 跳链；0/无数据退化为达标灰
export function renderFollowKpis(j = {}) {
  const rows = Array.isArray(j.rows) ? j.rows : [];
  const redCount = rows.filter((r) => r.alert === 'red').length;
  const lostCount = Number(j.lostContactCount || 0);
  const overdues = rows.filter((r) => r.alert === 'red').map((r) => Number(r.overdueDays || 0));
  const maxOverdue = overdues.length ? Math.max(...overdues) : 0;
  const card = (icon, label, val, cls, href) =>
    `<a class="fkpi ${cls}" ${href ? `href="${href}"` : ''}>` +
      `<div class="k-label">${icon} ${esc(label)}</div>` +
      `<div class="k-val">${esc(val)}</div>` +
    `</a>`;
  return [
    card('🔴', '应访未访', redCount, redCount > 0 ? 'warn' : '', '/named-account-manage.html'),
    card('🟠', '长期失联', lostCount, lostCount > 0 ? 'warn' : '', '/named-account-manage.html'),
    card('⏰', '最近逾期', maxOverdue > 0 ? maxOverdue + ' 天' : '无', maxOverdue > 0 ? 'warn' : '', '/named-account-manage.html'),
    `<a class="fkpi" href="/named-accounts.html"><div class="k-label">📋 查看完整</div><div class="k-val" style="font-size:14px">前往 →</div></a>`,
  ].join('');
}

// 完整告警表格（两类子表：🔴 应访未访 / 🟠 长期失联）
// 去重：既逾期又失联只进红（与端点 followReminders 去重口径一致）
export function renderFollowTable(rows = []) {
  const list = Array.isArray(rows) ? rows : [];
  const reds = list.filter((r) => r.alert === 'red');
  const losts = list.filter((r) => r.lostContact && r.alert !== 'red');
  if (!reds.length && !losts.length) return '<div class="muted">暂无逾期 / 失联提醒</div>';
  const rowHtml = (r, kind) => `<tr>
    <td><a href="/account-360.html?id=${esc(r.id)}">${esc(r.name)}</a></td>
    <td>${esc(r.owner)}</td>
    <td>${kind === 'red'
      ? `<span class="warn">逾期 ${r.overdueDays != null ? esc(r.overdueDays) + ' 天' : '—'}</span>`
      : `<span class="warn">失联 ${r.lastContactDays != null ? esc(r.lastContactDays) + ' 天无拜访' : '—'}</span>`}</td>
    <td>${r.visitDue ? new Date(r.visitDue).toLocaleDateString('zh-CN') : '—'}</td>
    <td>${r.visitTarget != null ? esc(r.visitTarget) + ' 次' : '—'} / 实际 ${r.visits30 ?? 0}</td>
    <td><a href="/account-360.html?id=${esc(r.id)}">去拜访 →</a></td>
  </tr>`;
  const table = (title, items, kind) => (items.length
    ? `<h4 class="muted" style="margin:14px 0 6px">${title}（${items.length}）</h4>
       <table><thead><tr><th>客户</th><th>销售</th><th>状态</th><th>应访日</th><th>应访/实际</th><th>操作</th></tr></thead>
       <tbody>${items.map((r) => rowHtml(r, kind)).join('')}</tbody></table>`
    : '');
  return table('🔴 应访未访', reds, 'red') + table('🟠 长期失联', losts, 'lost');
}
