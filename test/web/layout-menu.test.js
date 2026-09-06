// test/web/layout-menu.test.js — layoutMenu 角色过滤（admin 见系统分组，普通角色不见）
import { describe, it, expect } from 'vitest';
import { menuFor, FULL_MENU, ADMIN_MENU } from '../../src/portal/layoutMenu.js';

describe('layoutMenu 菜单单源', () => {
  it('FULL_MENU 恰 7 项全员（报告已移入 ADMIN_MENU，仅 admin 可见；新增销售行为看板 + 账单）', () => {
    expect(FULL_MENU.length).toBe(7);
    expect(FULL_MENU.map((m) => m.label)).toEqual([
      '线索·商机', '客户跟踪', '销售行为看板', '我的待办', '📚 基础数据门户', '财务应收', '账单',
    ]);
    // 账单挂在「洞察」分组、全员可见、无角色限制
    const bill = FULL_MENU.find((m) => m.label === '账单');
    expect(bill).toMatchObject({ group: '洞察', href: '/billing.html' });
    expect(bill.roles).toBeUndefined();
  });
  it('ADMIN_MENU 恰 3 项系统（含销售决策监控台，2026-09-03 从全员收敛为 admin 独享）', () => {
    expect(ADMIN_MENU.map((m) => m.label)).toEqual(['配置中心', '智能体中心', '报告']);
  });
  it('admin 见 7 全员 + 3 系统（含销售决策监控台「报告」+ 全员「账单」）', () => {
    const m = menuFor('admin');
    expect(m.length).toBe(10);
    expect(m.filter((x) => x.group === '系统').map((x) => x.label)).toEqual(['配置中心', '智能体中心']);
    expect(m.some((x) => x.label === '报告' && x.href === '/sales-decision-monitor')).toBe(true);
    // 洞察分组对 admin 含「账单」（全员）与「报告」（admin）
    expect(m.filter((x) => x.group === '洞察').map((x) => x.label)).toEqual(['账单', '报告']);
  });
  it('sales/manager/presales/contract_admin 不见系统分组（7 项全员去掉财务应收 = 6，含账单）', () => {
    for (const role of ['sales', 'manager', 'presales', 'contract_admin']) {
      const m = menuFor(role);
      expect(m.some((x) => x.group === '系统')).toBe(false);
      expect(m.length).toBe(6); // 报告已不在全员；财务应收 roles:[finance,admin] 除外；账单全员可见
      expect(m.some((x) => x.label === '财务应收')).toBe(false);
      expect(m.some((x) => x.label === '报告')).toBe(false);
      expect(m.some((x) => x.label === '账单' && x.href === '/billing.html')).toBe(true);
    }
  });
  it('finance 见 7 项（含财务应收 + 账单，按角色可见；报告仍仅 admin）', () => {
    const m = menuFor('finance');
    expect(m.some((x) => x.group === '系统')).toBe(false);
    expect(m.length).toBe(7);
    expect(m.some((x) => x.label === '报告')).toBe(false);
    expect(m.some((x) => x.label === '账单' && x.href === '/billing.html')).toBe(true);
  });
});
