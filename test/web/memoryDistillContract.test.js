// test/web/memoryDistillContract.test.js — 契约：memory.html「30 天蒸馏」区按钮调用契约
// 背景（2026-09-05 死区修复）：前端"预检"按钮 fetch 默认 GET，但后端端点仅注册 POST
//   → 404 + HTML 错误页 → await r.json() 抛 SyntaxError → async 监听器无 .catch 静默吞错
//   → 用户看到「点了没反应」。本测试锁死：① fetch 必须 method:'POST' ② async 监听器有错误兜底。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const src = fileURLToPath(new URL('../../src/web/memory.html', import.meta.url));
const html = readFileSync(src, 'utf8');

describe('memory.html 蒸馏区前端契约', () => {
  it('脚本内 fetch /api/memory/distill 必须显式 method:"POST"（防默认 GET 撞 404 死区）', () => {
    // 提取所有包含 /api/memory/distill 的 fetch 调用
    const re = /fetch\(\s*['"`]\/api\/memory\/distill[^'"`]*['"`]\s*,\s*\{([\s\S]*?)\}\s*\)/g;
    const matches = [...html.matchAll(re)];
    expect(matches.length, 'memory.html 必须有 /api/memory/distill 的 fetch 调用').toBeGreaterThan(0);
    for (const m of matches) {
      const init = m[1];
      expect(init, `fetch 调用必须 method:'POST'，实际：${init}`).toMatch(/method\s*:\s*['"`]POST['"`]/);
    }
  });

  it('crm-button click handler 包 try/catch（防 SyntaxError 静默吞掉 → 用户看不到反馈）', () => {
    // 抓出 bind() 函数体内两个 addEventListener 的 async 回调，断言都被 try 包裹
    const bindBody = html.match(/function bind\(\)\s*\{([\s\S]*?)\n    \}/);
    expect(bindBody, 'bind() 必须存在').toBeTruthy();
    const body = bindBody[1];
    // 两个 click 回调分别被 try 包裹
    const tryCount = (body.match(/\btry\s*\{/g) || []).length;
    expect(tryCount, `bind() 内 try 块数 ≥ 2，实际 ${tryCount}`).toBeGreaterThanOrEqual(2);
    const catchCount = (body.match(/\bcatch\s*\(/g) || []).length;
    expect(catchCount, `bind() 内 catch 数 ≥ 2，实际 ${catchCount}`).toBeGreaterThanOrEqual(2);
  });

  it('crm-button id="dry" 和 id="run" 必须存在于静态 HTML', () => {
    expect(html).toMatch(/<crm-button\s+id="dry">/);
    expect(html).toMatch(/<crm-button\s+id="run"[^>]*>执行蒸馏<\/crm-button>/);
  });

  it('蒸馏区容器的 getElementById 引用 id 必须存在于静态 HTML（防 missingId 死区）', () => {
    const ids = ['dry', 'run', 'dres'];
    for (const id of ids) {
      const ref = new RegExp(`getElementById\\(\\s*['"\`]${id}['"\`]\\s*\\)`);
      expect(html.match(ref), `${id} 必须被 getElementById 引用`).toBeTruthy();
      const def = new RegExp(`id=["'\`]${id}["'\`]`);
      expect(html.match(def), `${id} 必须在 HTML 中定义`).toBeTruthy();
    }
  });
});