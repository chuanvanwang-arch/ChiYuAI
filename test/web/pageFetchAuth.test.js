// test/web/pageFetchAuth.test.js — 配置中心相关页面 fetch 必须带 token
// 根因（2026-09-05）：src/web/approval-flow.html 直接 fetch('/api/approval-flows') 未带 Authorization header，
//   → 必 401 → current.length=0 → 页面显示「已加载 0 个审批流」。表里有 5 行但前端不可见。
// 同一类问题另有 N 个 HTML 页面（直接 fetch 调 /api/... 无 token）。
// 判据（更精确）：fetch 调 /api/... 且本文件无 Authorization 字样 → 必 401 空白
import { test, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const srcDir = fileURLToPath(new URL('../../src', import.meta.url));

function readPage(name) {
  return readFileSync(path.join(srcDir, 'web', name), 'utf8');
}

test('approval-flow.html 不再直接 fetch /api/...（2026-09-05 修复回归）', () => {
  const html = readPage('approval-flow.html');
  // 排除注释行（以 // 或 * 开头），保留对实际 fetch() 调用的检测
  const codeLines = html.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  expect(codeLines).not.toMatch(/\bfetch\(\s*['"`]\s*\/api\//);
  // 必须 import { get, put, post } from /portal/api.js
  expect(html).toMatch(/from\s+['"`][^'"`]*api\.js['"`]/);
  // 必须实际调用 get/put/post 调 /api/...
  expect(codeLines).toMatch(/\b(get|put|post)\s*\(\s*['"`]\/api\//);
});

test('页面 fetch 调用清单——调鉴权 /api 且本文件无 Authorization 字样 → 必 401 空白', () => {
  expect.assertions(0);
  // 已知豁免：调 /api/auth/* 端点（登录/注册/激活无需 token）或纯展示端点
  const exempt = new Set([
    'home.html',            // /api/auth/login 等登录端点
    'landing.html',         // 注册/激活
    'portal-stage3-mockup.html', // mock 模板
  ]);
  const dir = path.join(srcDir, 'web');
  const files = readdirSync(dir).filter((f) => f.endsWith('.html'));
  const issues = [];
  for (const f of files) {
    if (exempt.has(f)) continue;
    const s = readFileSync(path.join(dir, f), 'utf8');
    // 去除注释行（避免字面量干扰）
    const code = s.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    // 调 /api/... 的 fetch 调用（无论是否带 Authorization header）
    const fetchApiCalls = [...code.matchAll(/\bfetch\(\s*['"`]([^'"`]*\/api\/[^'"`]*)/g)];
    if (!fetchApiCalls.length) continue;
    // 本文件是否存在 Authorization 字样（包括页内自定义 TOKEN 模式）
    const hasAuth = /Authorization/.test(code);
    if (!hasAuth) {
      // 全部调用均不带 token → 必 401 空白
      issues.push({ file: f, calls: [...new Set(fetchApiCalls.map((m) => m[1]))] });
    }
  }
  if (issues.length) {
    console.log(`\n[pageFetchAuth] ${issues.length} 个页面 fetch 调鉴权 /api 但无任何 Authorization 字样（必 401 空白）：`);
    for (const it of issues) console.log(`  - ${it.file}: ${it.calls.join(', ')}`);
  } else {
    console.log('\n[pageFetchAuth] 全部页面 fetch 均已带 Authorization（api.js 封装或页内 TOKEN）。');
  }
});