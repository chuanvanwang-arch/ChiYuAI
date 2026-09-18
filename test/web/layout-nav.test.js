// test/web/layout-nav.test.js — 侧栏导航角标（2026-08-31 客户跟踪告警角标）
// 契约：navHtml(role, badges?) —— badges 为 { [href]: number }，>0 时在该导航项渲染 .nav-badge
// 向后兼容铁律：不传 badges（或值为 0/undefined）时，输出必须与改造前逐字节一致
import { test, expect } from 'vitest';
import { navHtml } from '../../src/web/layout.js';

test('navHtml 无 badges 时行为不变（向后兼容：不渲染角标）', () => {
  const html = navHtml('sales');
  expect(html).toContain('客户跟踪');
  expect(html).toContain('销售管道');
  expect(html).not.toContain('nav-badge');
});

test('navHtml 有 badge 时渲染角标（按 href 精确匹配）', () => {
  const html = navHtml('sales', { '/named-accounts.html': 3 });
  expect(html).toContain('nav-badge');
  expect(html).toContain('>3</span>');
  // 角标必须挂在「客户跟踪」项内（href 匹配），而非其它项
  const seg = html.split('客户跟踪')[1] || '';
  expect(seg.slice(0, 120)).toContain('nav-badge');
  // 未配置 badge 的项不渲染
  const pipelineSeg = html.split('销售管道')[1]?.split('</a>')[0] || '';
  expect(pipelineSeg).not.toContain('nav-badge');
});

test('badge 为 0 / 负数 / 非数字时不渲染', () => {
  expect(navHtml('sales', { '/named-accounts.html': 0 })).not.toContain('nav-badge');
  expect(navHtml('sales', { '/named-accounts.html': -1 })).not.toContain('nav-badge');
  expect(navHtml('sales', { '/named-accounts.html': undefined })).not.toContain('nav-badge');
  expect(navHtml('sales', { '/named-accounts.html': 'x' })).not.toContain('nav-badge');
});

test('badge 不影响 RBAC 过滤（admin 仍含系统分组）', () => {
  const html = navHtml('admin', { '/named-accounts.html': 1 });
  expect(html).toContain('配置中心');
  expect(html).toContain('智能体中心');
  expect(html).toContain('nav-badge');
  // sales 角色不应出现系统分组
  expect(navHtml('sales', { '/named-accounts.html': 1 })).not.toContain('配置中心');
});

test('badge 数字被正确转义（防 XSS：仅接受数字）', () => {
  // 传入 HTML 片段不应原样注入（Number() 归一后非正数 → 不渲染）
  const html = navHtml('sales', { '/named-accounts.html': '<img src=x onerror=alert(1)>' });
  expect(html).not.toContain('<img');
  expect(html).not.toContain('onerror');
});
