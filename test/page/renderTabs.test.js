import { test, expect } from 'vitest';
import { renderPage } from '../../src/page/renderer.js';
import { schema as S03_SCHEMA } from '../../src/pages/S03.schema.js';

const data = {
  components: {
    'goal-form': {},
    'task-monitor': { rows: [
      { task_id: 'T1', title: '跟进商机', action: 'followup', status: 'running', owner: 'host-a', updated_at: '2026-08-29 14:00' },
    ] },
    'reasoning-trace': { steps: [ { label: '意图解析' }, { label: '上下文装配' }, { label: '动作编排' } ] },
    'result-card': { items: [ { label: '智能体', value: '4 个' } ] },
    'contract-matrix': { rows: [] },
    'attr-field': {},
  },
};

test('S03 渲染出两 TAB + 任务行 + live 三段', () => {
  const { html, warnings } = renderPage(S03_SCHEMA, data);
  expect(warnings).toEqual([]);
  expect(html).toContain('pg-tab-btn');
  expect(html).toContain('data-tab-panel="monitor"');
  expect(html).toContain('data-tab-panel="detail"');
  expect(html).toContain('data-task-id="T1"');
  expect(html).toContain('data-step="intent"');
  expect(html).toContain('data-step="context"');
  expect(html).toContain('data-step="action"');
});
