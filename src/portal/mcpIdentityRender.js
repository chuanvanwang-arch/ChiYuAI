// src/portal/mcpIdentityRender.js — mcpIdentityRender.js 渲染纯函数子模块（浏览器 ESM 可加载）
// 根因修复（2026-08-27）：源 mcpIdentity.js 顶层含 Node-only import
// （express / ../db.js / ../decision/* / ../alerts/*）→ 浏览器原生 ESM 加载报
// "Failed to resolve module specifier 'express'" → 页面脚本崩溃（列表不渲染/按钮不绑定）。
// 本文件仅含渲染纯函数（零服务端 import），浏览器与 vitest 均可直接 import。
// 服务端 router 仍保留在 mcpIdentity.js（routes.js 继续 import 它）；页面 import 改指向本文件。

// src/portal/mcpIdentity.js — 连接器/MCP 身份配置（第 27 项）
// 零信任：token 仅存哈希（crm.mcp_identity.token_hash），明文仅创建时一次性返回前端

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function roleOptions(roles = []) {
  return (roles || [])
    .map((r) => `<option value="${esc(r)}">${esc(r)}</option>`)
    .join('');
}

// 状态徽标：启用 / 已吊销 / 过期（过期 = enabled 且 expires_at < now）
export function statusBadge(row = {}) {
  if (row.revoked_at) return `<span class="badge revoked">已吊销</span>`;
  if (row.enabled && row.expires_at && new Date(row.expires_at) < new Date()) return `<span class="badge expired">过期</span>`;
  return row.enabled ? `<span class="badge enabled">启用</span>` : `<span class="badge disabled">停用</span>`;
}

export function renderScopes(scopes = {}) {
  const s = scopes || {};
  if (!Object.keys(s).length) return `<span class="scopes empty">（全量）</span>`;
  const deny = Array.isArray(s.deny_domains) && s.deny_domains.length ? s.deny_domains.join(', ') : '';
  return `<span class="scopes">${deny ? `拒绝域: ${esc(deny)}` : esc(JSON.stringify(s))}</span>`;
}

export function renderMcpIdentities(rows = [], roles = []) {
  const list = rows || [];
  if (!list.length) return `<div class="empty">尚未配置任何 MCP 身份（crm.mcp_identity）</div>`;
  const roleOpts = roleOptions(roles);
  const trs = list
    .map((r) => `<tr class="mcp-row" data-id="${esc(r.id)}">
      <td class="m-actor"><input class="f-actor" value="${esc(r.actor)}" /></td>
      <td class="m-role"><select class="role-tag-select">${roleOpts}</select></td>
      <td class="m-scopes">${renderScopes(r.scopes)}</td>
      <td class="m-status">${statusBadge(r)}</td>
      <td class="m-exp">${r.expires_at ? esc(r.expires_at) : '—'}</td>
      <td class="m-ops">
        <button class="save-row">保存</button>
        <button class="revoke-row" ${r.revoked_at ? 'disabled' : ''}>吊销</button>
      </td>
    </tr>`)
    .join('');
  return `<table class="mcp-table"><thead><tr>
    <th>接入方(actor)</th><th>角色</th><th>域范围</th><th>状态</th><th>过期</th><th>操作</th>
  </tr></thead><tbody>${trs}</tbody></table>`;
}

export function mcpIdentitySummary(rows = []) {
  const list = rows || [];
  const enabled = list.filter((r) => r.enabled && !r.revoked_at).length;
  const revoked = list.filter((r) => r.revoked_at).length;
  return { count: list.length, enabled, revoked };
}
