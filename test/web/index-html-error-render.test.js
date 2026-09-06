// test/web/index-html-error-render.test.js
// 守卫（2026-09-05）：AI 作战室 NL 提交失败时，前端必须读后端 notes 给出真引导，
//   而非统一塞「请检查网络连接或登录状态」误导用户。
// 触发根因：用户在 AI 作战室输入「涂料新品配方需要特种润湿分散助剂…」→
//   nlParser 14 词未命中 → parse_empty + notes=['实体未识别', ...]，
//   但前端 catch 一律渲染「网络/登录」误导文案，已修。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const indexHtml = readFileSync(resolve(here, '../../src/web/index.html'), 'utf8');

describe('web/index.html · AI 作战室 NL 错误展示读后端 notes', () => {
  it('catch 块读 e.body.notes（不再统一塞「网络/登录」误导）', () => {
    // 关键三件套：body 取 notes + body.error 优先 + 兜底分支才显示「网络/登录」
    expect(indexHtml).toMatch(/body\s*=\s*e\s*&&\s*e\.body\s*\?\s*e\.body\s*:\s*\{\}/);
    expect(indexHtml).toMatch(/body\.error\s*\|\|/);
    expect(indexHtml).toMatch(/notes\.length/);
  });

  it('当 notes 非空时，提示改为「请按引导补充业务对象词」', () => {
    expect(indexHtml).toMatch(/请按上方引导补充业务对象词后重试/);
  });

  it('不再写死「请检查网络连接或登录状态，或简化指令后重试」误导文案', () => {
    // 修复前 bug：把 parse_empty / schema_invalid / render_rejected 一律说成网络问题
    expect(indexHtml).not.toMatch(/请检查网络连接或登录状态，或简化指令后重试/);
  });

  it('渲染 notesHtml 列表项 + 整体 error banner', () => {
    expect(indexHtml).toMatch(/notesHtml/);
    expect(indexHtml).toMatch(/生成失败/);
  });
});
