// src/portal/tenantScopeBar.js — 浏览器侧租户作用域条（admin/sysadmin 专属）
// 普通用户：scopeTenant 返回自身租户，前端无筛选器、列表无租户列（隔离由后端强制）。
// admin/sysadmin：渲染「租户」下拉（全部租户 + 各租户），选择经 sessionStorage 持久，切页保持；
//   列表附加「租户」列，便于区分跨租户合并数据的归属。
const KEY = 'crm_tenant_scope';
let _me = null;
let _tenants = null;

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

export async function fetchMe() {
  if (_me) return _me;
  try {
    const r = await fetch('/api/auth/me');
    _me = r.ok ? await r.json() : { role: 'user' };
  } catch {
    _me = { role: 'user' };
  }
  return _me;
}

async function fetchTenants() {
  if (_tenants) return _tenants;
  try {
    const r = await fetch('/api/tenants');
    const j = r.ok ? await r.json() : { tenants: [] };
    _tenants = j.tenants || [];
  } catch {
    _tenants = [];
  }
  return _tenants;
}

export function isAdminScope() {
  return !!(_me && (_me.role === 'admin' || _me.role === 'sysadmin'));
}

// 当前保存的租户选择（'all' = 全量）
export function savedTenant() {
  return sessionStorage.getItem(KEY) || 'all';
}

// 拼到 fetch URL 的查询串（普通用户返回 ''，因为后端忽略其 ?tenant）
export function tenantQuery() {
  const t = savedTenant();
  return t && t !== 'all' ? `&tenant=${encodeURIComponent(t)}` : '';
}

// 挂载筛选器到 el；仅 admin/sysadmin 渲染；onChange(tenantId) 触发调用方 reload
export async function mountTenantScopeBar(el, onChange) {
  const me = await fetchMe();
  if (!isAdminScope()) return; // 普通用户不渲染
  const tenants = await fetchTenants();
  const cur = savedTenant();
  el.innerHTML = `<label class="ts-label">租户</label>
    <select class="ts-select" id="ts-select">
      <option value="all">全部租户</option>
      ${tenants.map((t) => `<option value="${esc(t.tenant_id)}" ${t.tenant_id === cur ? 'selected' : ''}>${esc(t.name || t.tenant_id)}</option>`).join('')}
    </select>`;
  const sel = el.querySelector('#ts-select');
  if (sel) {
    sel.onchange = (e) => {
      sessionStorage.setItem(KEY, e.target.value);
      if (onChange) onChange(e.target.value);
    };
  }
}

// tenant_id → name 映射（供列表渲染租户列）
export async function tenantMap() {
  const ts = await fetchTenants();
  return Object.fromEntries(ts.map((t) => [t.tenant_id, t.name || t.tenant_id]));
}

export function tenantCell(tenantId, map) {
  return `<td class="ts-cell">${esc((map && map[tenantId]) || tenantId || 'system')}</td>`;
}

export function tenantHead() {
  return '<th>租户</th>';
}
