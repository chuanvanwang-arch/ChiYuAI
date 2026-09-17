// src/web/api.js — 统一数据读取封装（自动 Authorization、JSON、401 跳登录、错误抛掷）
const TOKEN_KEY = 'crm_token';
export function token() { return localStorage.getItem(TOKEN_KEY); }
export async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (token()) headers.Authorization = `Bearer ${token()}`;
  if (opts.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const init = { ...opts, headers };
  const r = await fetch(path, init);
  if (r.status === 401) {
    localStorage.clear();
    location.href = '/home.html';
    throw new Error('未登录');
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(j.error || `HTTP ${r.status}`);
    e.status = r.status;
    e.body = j; // 透传完整响应体（notes/needsClarification 等辅助字段供调用方渲染引导）
    throw e;
  }
  return j;
}
export function get(path) { return api(path); }
export function post(path, body) { return api(path, { method: 'POST', body: JSON.stringify(body || {}) }); }
export function put(path, body) { return api(path, { method: 'PUT', body: JSON.stringify(body || {}) }); }
export function me() { return api('/api/auth/me').catch(() => ({ ok: false })); }

// ── 租户级配置页的角色判定（§15.1 租户级三角色）────────────────────────────
// canonical 落库名 = ten_admin（userManagement ROLE_TAGS 写入的真实值）；
// 历史别名 tan_admin / tan-admin / tenant-admin 由后端 rbac.normalizeRole 归一
// （权威定义见 src/http/middleware/rbac.js 的 canWriteTenantConfig）。
//
// ⚠ 单点定义（2026-09-17 收敛）：所有租户级配置页的 guard 一律用 canEditTenantConfig()，
//   不要各自再写 `r?.role !== 'admin' && r?.role !== 'sysadmin'` ——
//   4 处页面曾各自复制该裸比较并漏掉 ten_admin，导致「后端 level 闸已放行、前端仍整页显示
//   『无权限』」的**界面级伪隔离**（后端修好、用户仍用不了）。
export const TENANT_CONFIG_ROLES = [
  'admin', 'ADMIN',
  'sysadmin', 'SYSADMIN', 'sys-admin',
  'ten_admin', 'tan_admin', 'tan-admin', 'tenant-admin', 'TAN_ADMIN',
];
export function canEditTenantConfig(role) {
  return TENANT_CONFIG_ROLES.includes(role);
}