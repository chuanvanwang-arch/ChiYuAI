// src/portal/userManagementRender.js — userManagementRender.js 渲染纯函数子模块（浏览器 ESM 可加载）
// 根因修复（2026-08-27）：源 userManagement.js 顶层含 Node-only import
// （express / ../db.js / ../decision/* / ../alerts/*）→ 浏览器原生 ESM 加载报
// "Failed to resolve module specifier 'express'" → 页面脚本崩溃（列表不渲染/按钮不绑定）。
// 本文件仅含渲染纯函数（零服务端 import），浏览器与 vitest 均可直接 import。
// 服务端 router 仍保留在 userManagement.js（routes.js 继续 import 它）；页面 import 改指向本文件。

// src/portal/userManagement.js — 用户管理配置（第 12 项，端点 + 可编辑，含 org/角色绑定）
// 渲染纯函数（浏览器 + vitest 共用） + 表驱动 GET/POST/PUT 端点（决策第0闸 + 字段白名单 + sysadmin 权限）
// 设计输入：docs/superpowers/plans/2026-08-27-user-management-config.md
// 后端事实：crm.crm_users（db/schema.sql 326 行）；密码 crypt hash；无 updated_at 列（变更时间由 config_change 事件承载）
// 红线：密码必 hash、明文不落库不回显、sysadmin(role=admin) 权限、绝对禁 DELETE、写经决策第0闸

// 角色白名单（对齐审批流种子 role 枚举 + role_context_profile；新增 sysadmin/ten_admin）
export const ROLE_TAGS = ['sales', 'manager', 'presales', 'contract_admin', 'finance', 'admin', 'ten_admin', 'sysadmin'];
// PUT 可编辑字段白名单（user_id/username/created_at 锁定）
export const EDITABLE_FIELDS = ['display_name', 'role', 'org_id', 'password', 'enabled', 'expires_at'];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 校验 PUT body.patch；返回 { ok, errors, normalized }
export function validateUserPatch(patch = {}) {
  const keys = Object.keys(patch || {});
  const unknown = keys.filter((k) => !EDITABLE_FIELDS.includes(k));
  if (unknown.length) {
    return { ok: false, errors: [`不可编辑字段: ${unknown.join(', ')}（仅 ${EDITABLE_FIELDS.join('/')} 可改）`] };
  }
  if (!keys.length) return { ok: false, errors: ['无有效编辑字段'] };
  const errors = [];
  const n = {};
  if ('display_name' in patch) {
    if (typeof patch.display_name !== 'string' || patch.display_name.length > 64) errors.push('display_name 须为 ≤64 字字符串');
    else n.display_name = patch.display_name;
  }
  if ('role' in patch) {
    if (!ROLE_TAGS.includes(patch.role)) errors.push(`role 须为 ${ROLE_TAGS.join('/')}`);
    else n.role = patch.role;
  }
  if ('org_id' in patch) {
    if (patch.org_id !== null && typeof patch.org_id !== 'string') errors.push('org_id 须为字符串或 null');
    else n.org_id = patch.org_id;
  }
  if ('enabled' in patch) {
    if (typeof patch.enabled !== 'boolean') errors.push('enabled 须为布尔');
    else n.enabled = patch.enabled;
  }
  if ('password' in patch) {
    if (typeof patch.password !== 'string' || patch.password.length < 8) errors.push('password 须为 ≥8 字字符串');
    else n.password = patch.password;
  }
  if ('expires_at' in patch) {
    // null = 清除有效期（永久）；字符串须为合法可解析时间
    if (patch.expires_at === null) n.expires_at = null;
    else if (typeof patch.expires_at === 'string' && !Number.isNaN(Date.parse(patch.expires_at))) n.expires_at = patch.expires_at;
    else errors.push('expires_at 须为合法时间字符串或 null');
  }
  return { ok: errors.length === 0, errors, normalized: n };
}

// 校验 POST body；返回 { ok, errors, normalized }
export function validateCreateUser(body = {}) {
  const errors = [];
  const n = {};
  if (!body.username || typeof body.username !== 'string') errors.push('username 必填');
  else n.username = body.username;
  if (!body.password || typeof body.password !== 'string' || body.password.length < 8) errors.push('password 须为 ≥8 字字符串');
  else n.password = body.password;
  if (!body.role || !ROLE_TAGS.includes(body.role)) errors.push(`role 须为 ${ROLE_TAGS.join('/')}`);
  else n.role = body.role;
  if (body.display_name != null) {
    if (typeof body.display_name !== 'string' || body.display_name.length > 64) errors.push('display_name 须为 ≤64 字字符串');
    else n.display_name = body.display_name;
  }
  if (body.org_id != null) {
    if (typeof body.org_id !== 'string') errors.push('org_id 须为字符串');
    else n.org_id = body.org_id;
  }
  return { ok: errors.length === 0, errors, normalized: n };
}

function fmtExpire(v) {
  if (!v) return '永久';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '永久';
  return d.toLocaleString('zh-CN', { hour12: false });
}
function isExpired(v) {
  if (!v) return false;
  const d = new Date(v);
  return !Number.isNaN(d.getTime()) && d.getTime() < Date.now();
}
function statusCell(u) {
  if (!u.enabled) return '<span class="badge off">⛔冻结</span>';
  if (isExpired(u.expires_at)) return '<span class="badge off">⏰已过期</span>';
  return '<span class="badge ok">✅启用</span>';
}

function rowHtml(u) {
  return `<tr data-id="${esc(u.user_id || '')}">
    <td><input type="checkbox" class="ucheck" data-uid="${esc(u.user_id || '')}" /></td>
    <td>${esc(u.username || '')}</td>
    <td>${esc(u.display_name || '')}</td>
    <td><span class="role-tag">${esc(u.role || '')}</span></td>
    <td>${esc(u.org_id || '—')}</td>
    <td>${statusCell(u)}</td>
    <td>${esc(fmtExpire(u.expires_at))}</td>
    <td><button class="btn edit" data-id="${esc(u.user_id || '')}">编辑</button></td>
  </tr>`;
}

// 按租户分组的只读表格渲染（成批选择 + 有效期展示）
export function renderUsers(users = []) {
  if (!users.length) return '<div class="empty">无用户配置</div>';
  const byTenant = {};
  for (const u of users) (byTenant[u.tenant_id || 'system'] ||= []).push(u);
  return Object.entries(byTenant)
    .map(
      ([tenant, list]) => `<section class="user-group" data-tenant="${esc(tenant)}">
        <h3><input type="checkbox" class="tenant-all" data-tenant="${esc(tenant)}" /> 租户 ${esc(tenant)} <span class="cnt">${list.length}</span></h3>
        <table class="user-tbl"><thead><tr><th></th><th>用户名</th><th>显示名</th><th>角色</th><th>org</th><th>状态</th><th>有效期</th><th>操作</th></tr></thead>
        <tbody>${list.map(rowHtml).join('')}</tbody></table>
      </section>`
    )
    .join('');
}
