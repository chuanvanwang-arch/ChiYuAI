// test/web/layout.test.js — layout.js 导航/头像菜单渲染（纯函数部分）
// 2026-08-29 同步：客户深度洞察 + 指名客户监测合并为客户跟踪；导航 3 全员 + 系统 2 项
import { describe, it, expect } from 'vitest';
import { navHtml, userMenuHtml } from '../../src/web/layout.js';

describe('layout.js 导航渲染', () => {
  it('navHtml(admin) 含 4 全员 + 系统分组 2 项', () => {
    const h = navHtml('admin');
    for (const label of ['线索·商机', '客户跟踪', '销售行为看板', '我的待办', '报告', '配置中心', '智能体中心']) {
      expect(h).toContain(label);
    }
    expect(h).not.toContain('客户深度洞察');
    expect(h).not.toContain('指名客户监测');
    expect(h).not.toContain('审批'); // 审批已并入「我的待办」
    // 旧「待办」独立导航项已消失（「我的待办」是子串，故用独立项判定而非裸子串）
    expect(h).not.toContain('href="/todo.html"');
    expect(h).not.toContain('href="/workbench.html"');
  });
  it('navHtml(sales) 不含系统分组 且含我的待办', () => {
    const h = navHtml('sales');
    expect(h).not.toContain('配置中心');
    expect(h).not.toContain('智能体中心');
    expect(h).toContain('我的待办');
    expect(h).not.toContain('审批');
  });
});

describe('layout.js 头像用户菜单', () => {
  it('userMenuHtml(sales) 含我的审批/我的任务/工作台/我的 API Key/退出，不含系统项', () => {
    const h = userMenuHtml('sales');
    for (const label of ['我的审批', '我的任务', '工作台', '我的 API Key', '退出登录']) expect(h).toContain(label);
    expect(h).toContain('href="/my-api-keys.html"'); // 方案 A：个人「我的 API Key」入口（全员）
    expect(h).not.toContain('配置中心');
    expect(h).not.toContain('智能体中心');
  });
  it('userMenuHtml(admin) 含配置中心/智能体中心', () => {
    const h = userMenuHtml('admin');
    expect(h).toContain('配置中心');
    expect(h).toContain('智能体中心');
    expect(h).toContain('我的 API Key');
  });
});