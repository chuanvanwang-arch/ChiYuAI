// src/portal/systemSettingsRender.js — 系统设置渲染纯函数子模块（浏览器 ESM 可加载）
// 架构纪律（2026-08-27 QA 教训）：源 systemSettings.js 顶层含 Node-only import
// （express / ../db.js / ../decision/* / ../http/auth.js）→ 浏览器原生 ESM 加载报
// "Failed to resolve module specifier 'express'" → 页面脚本崩溃。
// 本文件仅含渲染/校验纯函数（零服务端 import），浏览器与 vitest 均可直接 import。
// 服务端 router 仍保留在 systemSettings.js（routes.js 继续 import 它并从本文件 re-export）；
// 页面 import 指向本文件。

// 可编辑字段白名单（S33 蓝图：站点名/默认主题/会话超时/安全策略）
export const SYSTEM_FIELDS = ['site_name', 'default_theme', 'session_timeout', 'security_policy'];
export const THEMES = ['light', 'dark'];
// 安全策略键白名单（防任意 JSON 注入）
export const SECURITY_KEYS = ['password_min_len', 'mfa_required', 'allow_external_login'];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 校验 PUT body.value（系统设置字段白名单）；返回 { ok, errors, normalized }
export function validateSystemSettingsPatch(value = {}) {
  const keys = Object.keys(value || {});
  const unknown = keys.filter((k) => !SYSTEM_FIELDS.includes(k));
  if (unknown.length) {
    return { ok: false, errors: [`不可编辑字段: ${unknown.join(', ')}（仅 ${SYSTEM_FIELDS.join('/')} 可改）`] };
  }
  if (!keys.length) return { ok: false, errors: ['无有效设置字段'] };
  const errors = [];
  const n = {};
  if ('site_name' in value) {
    if (typeof value.site_name !== 'string' || !value.site_name.trim() || value.site_name.length > 64)
      errors.push('site_name 须为 1–64 字非空字符串');
    else n.site_name = value.site_name.trim();
  }
  if ('default_theme' in value) {
    if (!THEMES.includes(value.default_theme)) errors.push(`default_theme 须为 ${THEMES.join('/')}`);
    else n.default_theme = value.default_theme;
  }
  if ('session_timeout' in value) {
    const t = value.session_timeout;
    if (!Number.isInteger(t) || t < 60 || t > 1440) errors.push('session_timeout 须为 60–1440 的整数（分钟）');
    else n.session_timeout = t;
  }
  if ('security_policy' in value) {
    const p = value.security_policy;
    if (!p || typeof p !== 'object' || Array.isArray(p)) errors.push('security_policy 须为对象');
    else {
      const badKeys = Object.keys(p).filter((k) => !SECURITY_KEYS.includes(k));
      if (badKeys.length) errors.push(`security_policy 未知键: ${badKeys.join(', ')}（仅 ${SECURITY_KEYS.join('/')}）`);
      else n.security_policy = { ...p };
    }
  }
  return { ok: errors.length === 0, errors, normalized: n };
}

// 只读表单渲染（当前设置值）
export function renderSystemSettings(s) {
  if (!s || !s.site_name) return '<div class="empty">系统设置未配置（首次 PUT 后生效）</div>';
  const sp = s.security_policy || {};
  return `<form id="sf">
    <label>站点名</label><input name="site_name" value="${esc(s.site_name || '')}" maxlength="64" required />
    <label>默认主题</label>
    <select name="default_theme">
      <option value="light" ${s.default_theme === 'light' ? 'selected' : ''}>light</option>
      <option value="dark" ${s.default_theme === 'dark' ? 'selected' : ''}>dark</option>
    </select>
    <label>会话超时（分钟）</label><input name="session_timeout" type="number" min="60" max="1440" value="${esc(s.session_timeout ?? 120)}" />
    <label>安全策略</label>
    <div class="sec-grid">
      <label><input type="checkbox" name="password_min_len_set" ${sp.password_min_len ? 'checked' : ''}/> 密码最小长度（≥8）</label>
      <label><input type="checkbox" name="mfa_required" ${sp.mfa_required ? 'checked' : ''}/> 强制 MFA</label>
      <label><input type="checkbox" name="allow_external_login" ${sp.allow_external_login ? 'checked' : ''}/> 允许外部登录</label>
    </div>
    <button class="btn" type="submit">保存</button>
  </form>`;
}

// 审计日志只读表格（decision_event config_change 直查）
export function renderAuditLogs(logs = []) {
  if (!logs.length) return '<div class="empty">无审计日志（尚无系统配置变更）</div>';
  const rows = logs
    .map(
      (l) => `<tr>
        <td>${esc(new Date(l.created_at).toLocaleString?.() || '')}</td>
        <td>${esc(l.payload?.type || l.event_type || '')}</td>
        <td>${esc(l.payload?.fields?.join(', ') || '—')}</td>
        <td class="mono">${esc(String(l.event_id || '').slice(0, 8))}</td>
      </tr>`
    )
    .join('');
  return `<table class="audit-tbl"><thead><tr><th>时间</th><th>类型</th><th>字段</th><th>事件</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}