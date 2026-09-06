// test/page/registry.test.js — Task 6: 受控面注册表（registerPage/getPage/allPages）
// 设计输入：docs/2026-08-26-frontend-config-pages-master-plan.md Task 6 + 蓝图 §3 逐面 schema
import { describe, it, expect, beforeEach } from 'vitest';
import { registerPage, getPage, allPages, clearPages } from '../../src/pages/registry.js';

describe('受控面注册表', () => {
  beforeEach(() => clearPages());

  it('register + get', () => {
    registerPage('S01', { type: 'dashboard', title: '登录', navigation: { to: '/home' },
      components: [{ kind: 'metric-card', title: 'x', dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [] } }] });
    expect(getPage('S01').type).toBe('dashboard');
  });

  it('allPages 非空', () => {
    registerPage('S02', { type: 'dashboard', title: '作战室', navigation: { to: '/dashboard' },
      components: [{ kind: 'metric-card', title: 'x', dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [] } }] });
    expect(allPages().length).toBeGreaterThan(0);
  });

  it('重复注册覆盖（幂等）', () => {
    registerPage('S01', { type: 'dashboard', title: '登录', navigation: { to: '/home' },
      components: [{ kind: 'metric-card', title: 'x', dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [] } }] });
    registerPage('S01', { type: 'table', title: '待办', navigation: { to: '/my-todo' },
      components: [{ kind: 'table', dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], columns: ['name', 'stage'], metrics: [] } }] });
    expect(getPage('S01').type).toBe('table');
  });

  it('未注册 → getPage 返回 null', () => {
    expect(getPage('S99')).toBeNull();
  });
});