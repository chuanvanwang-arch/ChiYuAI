// test/http/legacy-redirect.test.js — 旧待办 URL 301 重定向到 /my-todo.html
// 设计输入：docs/2026-08-28-my-todo-merge-plan.md Task 5
// 说明：routes.js 不便在单元测试中直接实例化（依赖大量中间件/PG），故以源码断言锁定
//       重定向语义；集成层面的实际 301 响应由 T7 真浏览器验证覆盖。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = readFileSync(fileURLToPath(new URL('../../src/http/routes.js', import.meta.url)), 'utf8');

describe('旧待办 URL 301 重定向', () => {
  it('/workbench.html 与 /todo.html 均 301 重定向到 /my-todo.html', () => {
    expect(SRC).toMatch(/res\.redirect\(301,\s*'\/my-todo\.html'\)/);
  });
  it('旧别名 /workbench 与 /todo 也 301 重定向', () => {
    const hits = (SRC.match(/res\.redirect\(301,\s*'\/my-todo\.html'\)/g) || []).length;
    // workbench.html + workbench + todo.html + todo = 4 处 301
    expect(hits).toBe(4);
  });
  it('/my-todo.html 自身注册 sendFile 服务且 /my-todo 别名可访问', () => {
    expect(SRC).toContain("app.get('/my-todo.html',");
    expect(SRC).toMatch(/new URL\('..\/web\/my-todo\.html',\s*import\.meta\.url\)/);
    expect(SRC).toContain("app.get('/my-todo',");
  });
});
