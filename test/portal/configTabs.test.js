// test/portal/configTabs.test.js — T5 纯函数：非 ADMIN 系统级 TAB 占位、不泄露条目明细
import { test, expect } from 'vitest';
import { buildLevelTabs } from '../../src/portal/configTabs.js';

test('ADMIN：系统级/租户级/传播 均可见且非占位', () => {
  const tabs = buildLevelTabs({ level: 'ADMIN' });
  const sys = tabs.find((t) => t.level === 'system');
  expect(sys.visible).toBe(true);
  expect(sys.placeholder).toBe(false);
  expect(tabs.find((t) => t.level === 'tenant').placeholder).toBe(false);
});

test('sysadmin：系统级可见但占位（不可点），租户级正常', () => {
  const tabs = buildLevelTabs({ level: 'SYSADMIN' });
  const sys = tabs.find((t) => t.level === 'system');
  expect(sys.visible).toBe(true);
  expect(sys.placeholder).toBe(true);          // 关键：看得见但不可点
  expect(tabs.find((t) => t.level === 'tenant').placeholder).toBe(false);
  expect(tabs.find((t) => t.level === 'propagation').placeholder).toBe(true);
});

test('ten_admin：系统级占位、租户级正常', () => {
  const tabs = buildLevelTabs({ level: 'TAN_ADMIN' });
  expect(tabs.find((t) => t.level === 'system').placeholder).toBe(true);
  expect(tabs.find((t) => t.level === 'tenant').placeholder).toBe(false);
});
