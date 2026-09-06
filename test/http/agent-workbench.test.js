// test/http/agent-workbench.test.js — S03 智能体工作台经渲染器出片（真实数据：kanban tasks + agent 装配）
// 设计输入：docs/2026-08-26-frontend-config-pages-master-plan.md Task 后续（复刻 S02 Task 11 范式）
// 契约：GET /api/page/agent-workbench → { schema:S03, data, html }；html 为 renderPage 产物（pg-page 顶层）
//       html 含真实历史任务（kanban tasks）+ result-card（非 pg-unknown）
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createApp } from '../../src/http/server.js';
import { createTask } from '../../src/kanban/kanban.js';

let app;
beforeAll(() => { app = createApp(); });

// 组件树递归查找（兼容 tabs 嵌套结构：2026-08-29 S03 重构为两 TAB，goal-form 等已嵌套进 tabs[].components）
function findKind(components, kind) {
  if (!Array.isArray(components)) return false;
  for (const c of components) {
    if (c.kind === kind) return true;
    if (c.kind === 'tabs' && Array.isArray(c.tabs)) {
      for (const t of c.tabs) if (findKind(t.components, kind)) return true;
    }
    if (Array.isArray(c.components) && findKind(c.components, kind)) return true;
  }
  return false;
}

beforeEach(async () => {
  // kanban tasks 独立表（不被粒子 TRUNCATE 清）；造一条可断言的历史任务
  await createTask({ tenantId: 'system', step: 'eval', title: '测试任务', actionName: 'crm-deal-advance' });
});

describe('S03 智能体工作台经渲染器出片（/api/page/agent-workbench）', () => {
  it('返回 renderPage 产物（pg-page + workspace + table 含真实任务 + result-card）', async () => {
    const res = await app.fetch('/api/page/agent-workbench');
    expect(res.status).toBe(200);
    const j = await res.json();
    // 契约：schema = S03（type=workspace，含 goal-form）
    expect(j.schema.type).toBe('workspace');
    expect(findKind(j.schema.components, 'goal-form')).toBe(true);
    // 契约：html 为 renderPage 唯一出口（pg-page 顶层）
    expect(j.html).toContain('pg-page');
    expect(j.html).toContain('data-page-type="workspace"');
    // 契约：历史任务表含真实 kanban 任务（action_name → type 列）
    expect(j.html).toContain('pg-table');
    expect(j.html).toContain('crm-deal-advance');
    // 契约：result-card 已受支持（不再 pg-unknown）
    expect(j.html).toContain('pg-result-card');
    expect(j.html).not.toContain('pg-unknown');
  });

  it('页面注入容器骨架（id=agent-root，S03 即渲染于此）', async () => {
    const res = await app.fetch('/agent-workbench.html');
    const html = await res.text();
    expect(html).toContain('id="agent-root"');
    expect(html).toContain('data-schema="S03"');
  });
});
