import { test, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const web = join(process.cwd(), 'src/web');
const htmls = readdirSync(web).filter((f) => f.endsWith('.html'));

// 批0 修复验收：UI 重构前 7 个配置子页误引用 /web/nav.js（路径 404，导航不显示）。
// 修复后必须全部切换为 /portal/layout.js + injectLayout()，且全仓 html 不得再出现该错误路径。
test('no html page references broken /web/nav.js (404) path', () => {
  const bad = [];
  for (const f of htmls) {
    const src = readFileSync(join(web, f), 'utf8');
    if (src.includes('/web/nav.js')) bad.push(f);
  }
  expect(bad, `仍引用 /web/nav.js 的页: ${bad.join(', ')}`).toEqual([]);
});

// 批1 修复验收：11 个旧 /portal/nav.js 顶条页（非 module 直接操作 DOM 的协作/决策/智能体页）
// 全部切换到统一 layout.js 壳（injectLayout 用 appendChild 迁移 body 节点，保留已绑定事件）。
// 防御：全仓 html 不得再出现 /portal/nav.js 旧顶条引用（legacy，已被 layout 壳取代）。
test('no html page references legacy /portal/nav.js topbar', () => {
  const bad = [];
  for (const f of htmls) {
    const src = readFileSync(join(web, f), 'utf8');
    if (src.includes('/portal/nav.js')) bad.push(f);
  }
  expect(bad, `仍引用 /portal/nav.js 的页: ${bad.join(', ')}`).toEqual([]);
});

// 全量断言：除登录页(home)、演示原型(portal-stage3-mockup)与对外公开页外，所有 html 必须切到统一 layout.js 壳。
// 登录页/演示原型是独立全屏页，故意不接全局壳（避免双顶栏/双侧栏冲突）。
// 2026-09-06 新增对外公开页：landing.html（官网落地页，未登录可访问）、buddy-crm-portal.html（对外门户原型）——
//   这类页面接 app shell 会在未登录态弹登录/侧栏，与「公开可访问」定位冲突，故纳入排除。
const EXCLUDED = new Set(['home.html', 'portal-stage3-mockup.html', 'landing.html', 'buddy-crm-portal.html']);
test('all non-excluded pages switched to layout.js shell', () => {
  const missing = [];
  for (const f of htmls) {
    if (EXCLUDED.has(f)) continue;
    const src = readFileSync(join(web, f), 'utf8');
    if (!src.includes("from '/portal/layout.js'") || !src.includes('injectLayout()')) {
      missing.push(f);
    }
  }
  expect(missing, `未正确切到 layout.js 壳的页: ${missing.join(', ')}`).toEqual([]);
});
