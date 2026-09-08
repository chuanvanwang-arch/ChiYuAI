// 入口接入静态契约（对话驱动决策建议 T7）
// 静态断言而非集成测试：入口改动面涉及第 0 闸与 HTTP 路由，集成成本高；
// 此处锁定「已接入」与「只在阻断分支接入一次」两条不变式，防止后续改动静默回退。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('入口接入静态契约', () => {
  it('/api/page/from-nl 返回值附加 advice', () => {
    const src = readFileSync(new URL('../../src/http/routes.js', import.meta.url), 'utf8');
    const i = src.indexOf("app.post('/api/page/from-nl'");
    expect(i).toBeGreaterThan(-1);
    expect(src.slice(i, i + 2500)).toContain('advice');
  });
  it('executor 第 0 闸阻断返回附加 advice', () => {
    const src = readFileSync(new URL('../../src/action/executor.js', import.meta.url), 'utf8');
    expect(src).toContain("gate: 'decision_required'");
    expect(src).toContain('advice');
  });
  it('advise 仅在阻断分支调用一次（合规写路径零侵入）', () => {
    const src = readFileSync(new URL('../../src/action/executor.js', import.meta.url), 'utf8');
    expect((src.match(/await advise\(/g) || []).length).toBe(1);
  });
});
