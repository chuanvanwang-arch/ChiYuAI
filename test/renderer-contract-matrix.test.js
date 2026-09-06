// test/renderer-contract-matrix.test.js
import { describe, it, expect } from 'vitest';
import { renderPage } from '../src/page/renderer.js';
import { schema as S03 } from '../src/pages/S03.schema.js';

const rows = [
  { task: 'T-DEMO', agent: 'crm-copilot', skill_ok: true, memory_ok: true, success: 'pending' },
  { task: 'T-GAP', agent: 'crm-copilot', skill_ok: false, memory_ok: false, success: 'fail' },
];

describe('contract-matrix 渲染', () => {
  it('renderer 输出三列 + 标记按钮', () => {
    const { html } = renderPage(S03, { components: { 'contract-matrix': { rows } } });
    expect(html).toContain('SKILL');
    expect(html).toContain('记忆/知识');
    expect(html).toContain('T-DEMO');
    expect(html).toContain('T-GAP');
    expect(html).toContain('data-action="POST /api/agent-monitor/success"');
  });
  it('schema 含 contract-matrix 组件且校验通过', () => {
    // S03 两 TAB 重构后 contract-matrix 嵌套于 tabs>monitor>components（2026-08-29）
    const flat = (cs) => cs.flatMap((c) => c.kind === 'tabs' ? flat(c.tabs.flatMap((t) => t.components)) : [c]);
    expect(flat(S03.components).some((c) => c.kind === 'contract-matrix')).toBe(true);
  });
});
