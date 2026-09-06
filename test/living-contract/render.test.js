// test/living-contract/render.test.js
import { describe, it, expect } from 'vitest';
import { renderContracts } from '../../src/portal/contractsPage.js';

const DATA = { docs: [{ doc_path: 'docs/a.md', tasks: [
  { doc_path: 'docs/a.md', task: 'T-ok', agent: 'crm-copilot', skills: ['data-particle-read'], memory: ['crm-copilot'], success: 'ok',
    static: { skills_aligned: true, memory_aligned: true, skills_issues: [], memory_issues: [] },
    feedback: [], probe: null },
  { doc_path: 'docs/a.md', task: 'T-bad', agent: 'crm-copilot', skills: ['ghost'], memory: ['crm-copilot'], success: 'ok',
    static: { skills_aligned: false, memory_aligned: true, skills_issues: ['skill "ghost" 不在 crm-copilot.skillCalls'], memory_issues: [] },
    feedback: [{ gap_type: 'skill', severity: 'warn', status: 'open', observed: '缺 skill' }], probe: { type: 'http_get', path: '/api/x' } },
] }] };

describe('renderContracts', () => {
  it('对齐契约 skills chip 为 ok 类', () => {
    const html = renderContracts(DATA);
    expect(html).toContain('data-task="T-ok"');
    expect(html).toContain('class="chip ok"'); // T-ok 对齐
  });
  it('越界契约 skills chip 为 fail 类 + 反馈列表渲染', () => {
    const html = renderContracts(DATA);
    expect(html).toContain('chip fail'); // T-bad skills 越界
    expect(html).toContain('缺 skill');
    expect(html).toContain('运行探针'); // 有 probe → 显示按钮
  });
  it('无文档时显示空态', () => {
    expect(renderContracts({ docs: [] })).toContain('未解析到');
  });
});
