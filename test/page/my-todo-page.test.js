// test/page/my-todo-page.test.js — 「我的待办」五视角成品页契约
// 设计输入：docs/2026-08-28-my-todo-merge-plan.md Task 4
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PAGE = fileURLToPath(new URL('../../src/web/my-todo.html', import.meta.url));

describe('「我的待办」成品页', () => {
  it('① 成品页存在且含标题与五视角 tab', () => {
    expect(existsSync(PAGE)).toBe(true);
    const html = readFileSync(PAGE, 'utf8');
    expect(html).toContain('我的待办');
    for (const v of ['approval', 'processing', 'initiated', 'cc', 'follow']) {
      expect(html).toContain(`data-view="${v}"`);
    }
    expect(html).toContain('待我审批');
    expect(html).toContain('待跟进');
  });
  it('② 切换调用 /api/my-todo?view=<view> + 注入渲染器 HTML + SSE + 行内审批操作', () => {
    const html = readFileSync(PAGE, 'utf8');
    expect(html).toContain('get(`/api/my-todo?view=${view}`)');
    expect(html).toContain("import { get, post } from '/portal/api.js'");
    expect(html).toContain('wb-container');
    expect(html).toContain('j.html');
    expect(html).toContain("EventSource('/events')");
    expect(html).toContain("'/api/my-todo/approve'");
    expect(html).toContain("'/api/my-todo/reject'");
    expect(html).toContain('crm-approval-approve');
    expect(html).toContain('crm-approval-reject');
  });
  it('③ 链接 tokens.css 与 common.css（前端渲染硬性依赖，缺失会样式乱码）', () => {
    const html = readFileSync(PAGE, 'utf8');
    expect(html).toContain('/portal/tokens.css');
    expect(html).toContain('/portal/common.css');
  });
});
