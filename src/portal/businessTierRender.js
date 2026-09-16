// src/portal/businessTierRender.js — businessTierRender.js 渲染纯函数子模块（浏览器 ESM 可加载）
// 根因修复（2026-08-27）：源 businessTier.js 顶层含 Node-only import
// （express / ../db.js / ../decision/* / ../alerts/*）→ 浏览器原生 ESM 加载报
// "Failed to resolve module specifier 'express'" → 页面脚本崩溃（列表不渲染/按钮不绑定）。
// 本文件仅含渲染纯函数（零服务端 import），浏览器与 vitest 均可直接 import。
// 服务端 router 仍保留在 businessTier.js（routes.js 继续 import 它）；页面 import 改指向本文件。

// src/portal/businessTier.js — 业务分级配置（第 18 项）
// 渲染纯函数（浏览器 + vitest 共用） + 表驱动 GET/PUT 端点（决策第0闸）
// 设计输入：docs/superpowers/plans/2026-08-27-business-tier-config.md
// tier 取值：LEAD / NORMAL / HIGH；引擎 computeBusinessTier 按两维取高风险优先
//
// ⚠ 术语边界（E2，2026-09-16）——本文件出现的三组三值符号互不相同，禁止混读：
//   ① 维度名          = customer | project                （VALID_DIMENSIONS）
//   ② 维度取值        = 客户维 STRATEGIC/KEY/NORMAL；项目维 A/B/C   ← 「取值」列，业务分类
//   ③ **自主分级(tier)** = LEAD | NORMAL | HIGH            ← 「自主分级」列，**自主边界**（本模块真正配置的东西）
//   另有对话建议档 A/B/C（decision/adviceCard.js，轴 ADVICE_MATURITY），**方向与②相反**：建议档 C=禁止处置，
//   而项目分级 C=低风险可自治。②③ 经 computeBusinessTier 关联；对话建议档与本模块无直接映射关系。

export const TIER_RANK = { LEAD: 1, NORMAL: 2, HIGH: 3 };
export const VALID_DIMENSIONS = ['customer', 'project'];
export const VALID_TIERS = ['LEAD', 'NORMAL', 'HIGH'];

export function tierRank(tier) {
  return TIER_RANK[tier] || 0;
}

export function tierBadge(tier) {
  const cls = (tier || '').toLowerCase();
  return `<span class="tier-badge tier-${cls}">${tier || '—'}</span>`;
}

// A4（2026-09-16）：状态派生 —— 单一事实源 = revoked_at / expires_at（表上刻意不设 status 列）。
// revoked 优先于 expired：两者同时成立时说"已撤回"更准确（撤回是主动行为，过期是时间流逝）。
export function tierStatus(row, now = new Date()) {
  if (row?.revoked_at) return 'revoked';
  if (row?.expires_at && new Date(row.expires_at) <= now) return 'expired';
  return 'active';
}

export function statusBadge(status) {
  const label = { active: '生效', revoked: '已撤回', expired: '已过期' }[status] || status;
  return `<span class="tier-status status-${status}">${label}</span>`;
}

// HTML 转义：dimension_value 直接来自 PUT body（用户输入）→ 原实现裸插值 = 存储型 XSS。
// 顺带修掉既有隐患（不是新增行为，是补上本该有的转义）。
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function shortTime(t) {
  if (!t) return '—';
  const d = new Date(t);
  return Number.isNaN(d.getTime())
    ? '—'
    : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 撤回行照样渲染（不过滤）：零 DELETE 原则下撤回的行是审计证据，不能在列表里"消失"——
// 灰显 + "已撤回"标记表达"仍在册但不生效"。真正决定是否参与判定的是 computeBusinessTier 的过滤。
export function renderBusinessTier(rows = []) {
  if (!rows.length) {
    return `<div class="empty">尚未配置任何分级规则（DEAL=客户维×项目维 → 驱动自主边界）</div>`;
  }
  const trs = rows
    .map((r) => {
      const st = tierStatus(r);
      const title = st === 'revoked'
        ? `已撤回${r.revoked_reason ? '：' + esc(r.revoked_reason) : ''}（${shortTime(r.revoked_at)}）`
        : (r.expires_at ? `到期：${shortTime(r.expires_at)}` : '');
      const action = st === 'active'
        ? `<button class="btn-revoke" data-dimension="${esc(r.dimension)}" data-value="${esc(r.dimension_value)}">撤回</button>`
        : '';
      return `<tr class="business-tier-row${st === 'active' ? '' : ' row-inactive'}" title="${esc(title)}">
        <td>${esc(r.dimension)}</td>
        <td>${esc(r.dimension_value)}</td>
        <td>${tierBadge(r.tier)}</td>
        <td>${statusBadge(st)}</td>
        <td>${esc(r.approved_by || '—')}</td>
        <td>${action}</td>
      </tr>`;
    })
    .join('');
  return `<table class="tier-table">
    <thead><tr><th>维度</th><th>取值</th><th>分级</th><th>状态</th><th>批准人</th><th>操作</th></tr></thead>
    <tbody>${trs}</tbody>
  </table>`;
}
