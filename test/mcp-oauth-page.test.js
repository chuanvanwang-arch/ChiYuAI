// test/mcp-oauth-page.test.js — OAuth 登录页 / 错误页渲染（纯函数）
// 设计：docs/2026-09-15-mcp-oauth-design.md §3.4
import { describe, it, expect } from 'vitest';
import { renderLoginPage, renderErrorPage, escapeHtml } from '../src/mcp/oauthPage.js';

const P = {
  response_type: 'code', client_id: 'oauth_abc',
  redirect_uri: 'workbuddy://workbuddy/mcp/connector:x/oauth/callback',
  state: 'st1', code_challenge: 'chal', code_challenge_method: 'S256', scope: 'mcp',
};

describe('escapeHtml', () => {
  it('转义 & < > " \'', () => {
    expect(escapeHtml(`<img src=x onerror="alert('1')">&`))
      .toBe('&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt;&amp;');
  });
  it('非字符串归一为空串', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });
});

describe('renderLoginPage', () => {
  it('表单 POST 到 /oauth/authorize 且 hidden 回传全部协议参数', () => {
    const html = renderLoginPage({ params: P });
    expect(html).toContain('method="post"');
    expect(html).toContain('action="/oauth/authorize"');
    for (const [k, v] of Object.entries(P)) {
      expect(html).toContain(`name="${k}"`);
      expect(html).toContain(`value="${v}"`);
    }
  });

  it('账号密码字段存在且密码为 password 类型', () => {
    const html = renderLoginPage({ params: P });
    expect(html).toContain('name="username"');
    expect(html).toMatch(/name="password"[^>]*type="password"|type="password"[^>]*name="password"/);
  });

  it('错误提示经转义注入（XSS 防护）', () => {
    const html = renderLoginPage({ params: P, error: '<script>alert(1)</script>' });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('无外部资源引用（内联样式，不引 CDN）', () => {
    const html = renderLoginPage({ params: P });
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).toContain('<style>');
  });

  it('参数中的引号被转义，不破坏 hidden 属性', () => {
    const html = renderLoginPage({ params: { ...P, state: 'a"b<c' } });
    expect(html).toContain('value="a&quot;b&lt;c"');
  });

  it('空值参数不渲染 hidden 字段（避免空 state 覆盖）', () => {
    const html = renderLoginPage({ params: { ...P, state: '' } });
    expect(html).not.toContain('name="state"');
  });
});

describe('renderErrorPage', () => {
  it('渲染错误文案，且不做任何客户端跳转', () => {
    const html = renderErrorPage('redirect_uri 与注册值不匹配');
    expect(html).toContain('redirect_uri 与注册值不匹配');
    expect(html).not.toContain('location.href');
    expect(html).not.toContain('window.location');
  });

  it('错误文案同样转义', () => {
    expect(renderErrorPage('<b>x</b>')).not.toContain('<b>x</b>');
  });
});
