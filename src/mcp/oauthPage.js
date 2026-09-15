// src/mcp/oauthPage.js — OAuth 授权页渲染（纯函数：无 IO、无外部资源）
// 设计：docs/2026-09-15-mcp-oauth-design.md §3.4
//
// 铁律：
//   1) 全部插值必须经 escapeHtml —— 参数直接来自 URL query，是反射型 XSS 的天然入口。
//   2) 不引任何外部 CDN / 字体 / 脚本：登录页必须在离线与受限网络下可用。
//   3) 错误页绝不 302 —— 非法 client/redirect_uri 时重定向会成为开放重定向放大器（RFC 6749 §4.1.2.1）。
const PARAM_KEYS = ['response_type', 'client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'scope'];

export function escapeHtml(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function shell(title, inner) {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root{color-scheme:light}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       background:#f5f6f8;font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:#1f2329}
  .card{width:100%;max-width:380px;background:#fff;border:1px solid #e5e6eb;border-radius:12px;
        padding:28px 26px;box-shadow:0 2px 12px rgba(0,0,0,.04)}
  h1{margin:0 0 4px;font-size:18px;font-weight:600}
  .sub{margin:0 0 20px;color:#8a8f99;font-size:12px}
  label{display:block;margin:14px 0 6px;font-size:13px;color:#4e5969}
  input[type=text],input[type=password]{width:100%;padding:9px 11px;border:1px solid #d9dbe0;
        border-radius:8px;font-size:14px;outline:none}
  input[type=text]:focus,input[type=password]:focus{border-color:#3370ff}
  button{width:100%;margin-top:22px;padding:10px;border:0;border-radius:8px;background:#3370ff;
         color:#fff;font-size:14px;font-weight:500;cursor:pointer}
  button:hover{background:#245bdb}
  .err{margin:0 0 4px;padding:9px 11px;background:#fff1f0;border:1px solid #ffccc7;
       border-radius:8px;color:#cf1322;font-size:13px}
  .foot{margin-top:18px;color:#a9aeb8;font-size:12px;text-align:center}
</style></head>
<body><div class="card">${inner}</div></body></html>`;
}

export function renderLoginPage({ params = {}, error = null } = {}) {
  const hidden = PARAM_KEYS
    .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== '')
    .map((k) => `    <input type="hidden" name="${k}" value="${escapeHtml(params[k])}">`)
    .join('\n');
  const inner = `
  <h1>连接 AI 原生销售管理助手</h1>
  <p class="sub">请使用你的 CRM 业务账号授权</p>
  ${error ? `<p class="err">${escapeHtml(error)}</p>` : ''}
  <form method="post" action="/oauth/authorize">
${hidden}
    <label for="username">账号</label>
    <input id="username" name="username" type="text" autocomplete="username" autofocus required>
    <label for="password">密码</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required>
    <button type="submit">授权并连接</button>
  </form>
  <p class="foot">admin 账号仅限 HTTP 后台，请使用业务账号</p>`;
  return shell('授权连接 · AI 原生销售管理助手', inner);
}

export function renderErrorPage(message) {
  const inner = `
  <h1>无法完成授权</h1>
  <p class="sub">授权请求未被接受</p>
  <p class="err">${escapeHtml(message)}</p>
  <p class="foot">请回到客户端重新发起连接</p>`;
  return shell('授权失败 · AI 原生销售管理助手', inner);
}
