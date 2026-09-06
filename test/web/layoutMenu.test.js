// test/web/layoutMenu.test.js
import { expect, test } from 'vitest';
import { FULL_MENU, ADMIN_MENU, menuFor } from '../../src/portal/layoutMenu.js';

test('menuFor 按权益过滤：无 decision_autonomy 租户看不到「报告」', () => {
  const ents = new Set(['core_crm']);
  const items = menuFor('admin', ents);
  const labels = items.map((m) => m.label);
  expect(labels).not.toContain('报告'); // 报告 requiresEntitlement decision_autonomy
});

test('有 decision_autonomy 则可见', () => {
  const items = menuFor('admin', new Set(['core_crm', 'decision_autonomy']));
  expect(items.map((m) => m.label)).toContain('报告');
});
