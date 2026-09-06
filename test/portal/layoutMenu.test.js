import { describe, it, expect } from 'vitest';
import { menuFor, ADMIN_MENU } from '../../src/portal/layoutMenu.js';

describe('menuFor 角色可见性', () => {
  it('sysadmin 可见配置中心；套餐入口已收敛进配置中心（不占侧边栏）', () => {
    const m = menuFor('sysadmin');
    expect(m.some(x => x.label === '配置中心')).toBe(true);
    // 2026-09-05 用户决议：侧边栏不再有独立「平台套餐管理」项，入口=配置中心系统级 #41 卡片
    expect(m.some(x => x.href === '/admin-billing-console.html#plans')).toBe(false);
    expect(ADMIN_MENU.some(x => x.label === '平台套餐管理')).toBe(false);
  });
  it('ten_admin 不可见系统菜单（不越权）', () => {
    const m = menuFor('ten_admin');
    expect(m.some(x => x.label === '配置中心')).toBe(false);
    expect(m.some(x => x.href === '/admin-billing-console.html#plans')).toBe(false);
  });
  it('配置中心注册表 #41 平台套餐管理为 system 级深链（入口收敛的落点）', async () => {
    const { CONFIG_ITEMS } = await import('../../src/portal/configCenter.js');
    const it41 = CONFIG_ITEMS.find(x => x.id === 41);
    expect(it41).toBeTruthy();
    expect(it41.level).toBe('system');
    expect(it41.page).toBe('/admin-billing-console.html#plans');
  });
});
