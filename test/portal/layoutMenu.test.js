import { describe, it, expect } from 'vitest';
import { menuFor, ADMIN_MENU, FULL_MENU } from '../../src/portal/layoutMenu.js';

describe('menuFor 角色可见性', () => {
  it('公海池入口存在且销售可见（紧邻线索·商机，core_crm 门禁）', () => {
    const idx = FULL_MENU.findIndex((x) => x.label === '公海池');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(FULL_MENU[idx].href).toBe('/lead-pool.html');
    expect(FULL_MENU[idx - 1]?.label).toBe('线索·商机');
    // 无权益入参（null）→ 向后兼容，按角色展示
    expect(menuFor('sales').some((x) => x.label === '公海池' && x.href === '/lead-pool.html')).toBe(true);
    // 持 core_crm → 展示
    expect(menuFor('sales', new Set(['core_crm'])).some((x) => x.href === '/lead-pool.html')).toBe(true);
    // 无 core_crm → 隐藏（与 crm-lead-pick 动作权益一致）
    expect(menuFor('sales', new Set()).some((x) => x.href === '/lead-pool.html')).toBe(false);
  });
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

// ── 入口可达性（2026-09-17 实缺陷回归 · 需求②④）──────────────────────────
// 事实：channel-config.html（需求② 通道配置台）与 crm-sync-console.html（需求④ 原系统集成台）
//   此前都是**主导航零入口**——有 routes serve、有页面契约测试全绿、也有页间互链，
//   但用户从侧边栏根本到不了（入口死区）。与 discovery.html 同一形态。
//   ⚠ 只断言「页面内部有什么」的契约测试，永远发现不了「没人到得了」：
//     入口必须自身成为断言对象，否则补完入口仍会随下次重构静默脱落。
describe('入口可达性（防「页面在但没人到得了」）', () => {
  it('需求②：外部沟通接入 → /channel-config.html 有入口且销售可见', () => {
    const hit = FULL_MENU.find((m) => m.href === '/channel-config.html');
    expect(hit, 'channel-config.html 失去导航入口 → 又变孤岛').toBeTruthy();
    expect(hit.group).toBe('协同');
    expect(hit.requiresEntitlement).toEqual(['core_crm']);
    expect(menuFor('sales', new Set(['core_crm'])).some((m) => m.href === '/channel-config.html')).toBe(true);
  });

  it('需求④：原系统集成 → /crm-sync-console.html 仅 admin/sysadmin 可见（数据面 403 ADMIN only）', () => {
    const hit = ADMIN_MENU.find((m) => m.href === '/crm-sync-console.html');
    expect(hit, 'crm-sync-console.html 失去导航入口 → 又变孤岛').toBeTruthy();
    expect(hit.group).toBe('系统');
    // 不得出现在全员菜单：销售能看见入口却拿不到数据（/api/integration/providers → 403）= 误导入口
    expect(FULL_MENU.some((m) => m.href === '/crm-sync-console.html')).toBe(false);
    expect(menuFor('sales').some((m) => m.href === '/crm-sync-console.html')).toBe(false);
    expect(menuFor('admin').some((m) => m.href === '/crm-sync-console.html')).toBe(true);
  });
});
