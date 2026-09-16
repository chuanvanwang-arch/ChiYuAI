// test/web/layout-menu.test.js — layoutMenu 角色过滤（admin 见系统分组，普通角色不见）
import { describe, it, expect } from 'vitest';
import { menuFor, FULL_MENU, ADMIN_MENU } from '../../src/portal/layoutMenu.js';

describe('layoutMenu 菜单单源', () => {
  // 2026-09-16 修正：本断言此前写死 7 项，但 2026-09-14 新增「公海池」后实际已是 8 项
  //   → 该测试自 09-14 起即为红（遗漏配套更新）。随 S1 新增「信号中心」校准为 9 项。
  // 2026-09-16 二次变更：原「信号中心」更名为「销售自动化」，并从「销售」组移入「协同」组、
  //   置于「我的待办」之上；项数与各分组归属不变，故总数仍为 9。
  it('FULL_MENU 恰 9 项全员（报告已移入 ADMIN_MENU，仅 admin 可见；09-14 新增公海池；09-16 信号中心 → 销售自动化）', () => {
    expect(FULL_MENU.length).toBe(9);
    expect(FULL_MENU.map((m) => m.label)).toEqual([
      '线索·商机', '公海池', '客户跟踪', '销售行为看板', '销售自动化', '我的待办', '📚 基础数据门户', '财务应收', '账单',
    ]);
    // 账单挂在「洞察」分组、全员可见、无角色限制
    const bill = FULL_MENU.find((m) => m.label === '账单');
    expect(bill).toMatchObject({ group: '洞察', href: '/billing.html' });
    expect(bill.roles).toBeUndefined();
    // 销售自动化（主动运行时 S1，原「信号中心」）：core_crm 权益门禁；href 保持稳定标识不变
    const sig = FULL_MENU.find((m) => m.label === '销售自动化');
    expect(sig).toMatchObject({ group: '协同', href: '/signal-center.html', requiresEntitlement: ['core_crm'] });
    // 旧名不得残留（防「改了一处、菜单与 ⌘K 面板显示两个入口」）
    expect(FULL_MENU.some((m) => m.label === '信号中心')).toBe(false);
    // 位置契约（用户诉求：放入「协同」、排在「我的待办」上面）
    const labels = FULL_MENU.map((m) => m.label);
    expect(FULL_MENU.findIndex((m) => m.label === '销售自动化'))
      .toBe(FULL_MENU.findIndex((m) => m.label === '我的待办') - 1);
    const coop = FULL_MENU.filter((m) => m.group === '协同').map((m) => m.label);
    expect(coop).toEqual(['销售自动化', '我的待办']);
    expect(labels.indexOf('销售自动化')).toBeGreaterThan(labels.indexOf('销售行为看板'));
  });
  // 分组顺序 = 各分组首次出现的次序（layout.js navHtml 按此渲染），本次变更不得打乱既有分组次序
  it('分组次序保持：销售 → 协同 → 基础数据 → 财务 → 洞察', () => {
    expect([...new Set(FULL_MENU.map((m) => m.group))])
      .toEqual(['销售', '协同', '基础数据', '财务', '洞察']);
  });
  it('ADMIN_MENU 恰 3 项系统（含销售决策监控台，2026-09-03 从全员收敛为 admin 独享）', () => {
    expect(ADMIN_MENU.map((m) => m.label)).toEqual(['配置中心', '智能体中心', '报告']);
  });
  it('admin 见 9 全员 + 3 系统（含销售决策监控台「报告」+ 全员「账单」）', () => {
    const m = menuFor('admin');
    expect(m.length).toBe(12);
    expect(m.filter((x) => x.group === '系统').map((x) => x.label)).toEqual(['配置中心', '智能体中心']);
    expect(m.some((x) => x.label === '报告' && x.href === '/sales-decision-monitor')).toBe(true);
    // 洞察分组对 admin 含「账单」（全员）与「报告」（admin）
    expect(m.filter((x) => x.group === '洞察').map((x) => x.label)).toEqual(['账单', '报告']);
  });
  it('sales/manager/presales/contract_admin 不见系统分组（9 项全员去掉财务应收 = 8，含账单）', () => {
    for (const role of ['sales', 'manager', 'presales', 'contract_admin']) {
      const m = menuFor(role);
      expect(m.some((x) => x.group === '系统')).toBe(false);
      expect(m.length).toBe(8); // 报告已不在全员；财务应收 roles:[finance,admin] 除外；账单全员可见
      expect(m.some((x) => x.label === '财务应收')).toBe(false);
      expect(m.some((x) => x.label === '报告')).toBe(false);
      expect(m.some((x) => x.label === '账单' && x.href === '/billing.html')).toBe(true);
    }
  });
  it('finance 见 9 项（含财务应收 + 账单，按角色可见；报告仍仅 admin）', () => {
    const m = menuFor('finance');
    expect(m.some((x) => x.group === '系统')).toBe(false);
    expect(m.length).toBe(9);
    expect(m.some((x) => x.label === '报告')).toBe(false);
    expect(m.some((x) => x.label === '账单' && x.href === '/billing.html')).toBe(true);
  });
});
