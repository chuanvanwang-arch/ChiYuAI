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