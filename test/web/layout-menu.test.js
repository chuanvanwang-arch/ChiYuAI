// test/web/layout-menu.test.js — layoutMenu 角色过滤（admin 见系统分组，普通角色不见）
import { describe, it, expect } from 'vitest';
import { menuFor, FULL_MENU, ADMIN_MENU } from '../../src/portal/layoutMenu.js';

describe('layoutMenu 菜单单源', () => {
  // 2026-09-16 修正：本断言此前写死 7 项，但 2026-09-14 新增「公海池」后实际已是 8 项
  //   → 该测试自 09-14 起即为红（遗漏配套更新）。随 S1 新增「信号中心」校准为 9 项。
  // 2026-09-16 二次变更：原「信号中心」更名为「销售自动化」，并从「销售」组移入「协同」组、
  //   置于「我的待办」之上；项数与各分组归属不变，故总数仍为 9。
  // 2026-09-17 三次变更：新增「线索发现」→ /discovery.html（补可达性：该页此前**零导航入口**，
  //   全仓只有 routes.js serve，属「页面在但没人到得了」）。插入位置=「公海池」之后，
  //   刻意不打乱 test/portal/layoutMenu.test.js 锁着的「公海池紧邻（当时的）线索·商机」契约。
  // 2026-09-17 四次变更：新增「外部沟通接入」→ /channel-config.html（同一形态缺陷：需求②的通道
  //   配置面此前也是零导航入口）+ ADMIN_MENU 新增「原系统集成」→ /crm-sync-console.html（需求④）。
  //   插入位置=「协同」组首位（形成 接入 → 信号 → 待办 动线），不打乱「销售自动化紧邻我的待办」契约。
  // 2026-09-18 五次变更（用户指定顺序）：**「销售」组重排**为
  //   线索发现 → 公海池 → 销售管道 → 客户跟踪（口语「客户 360」）→ 销售过程看板。
  //   ⚠ 该项变更**覆盖** 2026-09-14 的「公海池紧邻线索·商机」旧契约（公海池前提为线索发现）；
  //     项数/分组归属/href/权益门禁全部不变，仅组内次序变化。
  // 2026-09-18 六次变更（用户裁定「两个改名」）：显示名 线索·商机→销售管道、销售行为看板→销售过程看板
  //   （连同落点页 title/h1 同步；「客户跟踪」保留，是 2026-08-29 合并时的定名）。href/项数/分组/门禁仍不变。
  // 2026-09-18 七次变更（用户裁定「不要放在左侧菜单里面」）：将「外部沟通接入」（→ channel-config.html）从 FULL_MENU「协同」组、
  //   及「原系统集成」（→ crm-sync-console.html）从 ADMIN_MENU「系统」组 双双移出左侧菜单。二者仍可达
  //   （channel-config 经 cross-link；crm-sync-console 经配置中心租户级 #53/#54 卡片），故非孤岛。项数：FULL_MENU 11→10、ADMIN_MENU 4→3。
  it('FULL_MENU 恰 10 项全员（报告已移入 ADMIN_MENU；09-14 公海池；09-16 销售自动化；09-17 线索发现；09-18 销售组重排 + 两项改名 + 移出外部沟通接入）', () => {
    expect(FULL_MENU.length).toBe(10);
    expect(FULL_MENU.map((m) => m.label)).toEqual([
      '线索发现', '公海池', '销售管道', '客户跟踪', '销售过程看板', '销售自动化', '我的待办', '📚 基础数据门户', '财务应收', '账单',
    ]);
    // 「销售」组顺序即用户诉求（2026-09-18）——整组按序断言，防「插项不动顺序」式静默漂移
    expect(FULL_MENU.filter((m) => m.group === '销售').map((m) => m.label))
      .toEqual(['线索发现', '公海池', '销售管道', '客户跟踪', '销售过程看板']);
    // 旧显示名不得残留（防「只改一处，菜单上出现两个同义入口/旧名回潮」）
    for (const stale of ['线索·商机', '销售行为看板', '信号中心']) {
      expect(FULL_MENU.some((m) => m.label === stale), `菜单残留旧名「${stale}」`).toBe(false);
    }
    expect(FULL_MENU.filter((m) => m.group === '销售').map((m) => m.href))
      .toEqual(['/discovery.html', '/lead-pool.html', '/pipeline.html', '/named-accounts.html', '/sales-behavior-board.html']);
    // 外部沟通接入 / channel-config.html（需求②）：2026-09-18 用户裁定移出左侧菜单（不再作为全员入口）；
    //   仍经 cross-link 可达（index/channel-adapters/onboarding/account-360/discovery-rules），故断言其**不在** FULL_MENU 内
    expect(FULL_MENU.some((m) => m.href === '/channel-config.html')).toBe(false);
    // 线索发现（2026-09-17）：core_crm 门禁（同属拓客能力），且必须紧邻公海池（发现上游 → 入池下游；
    //   2026-09-18 重排后二者仍相邻，只是先后关系由「公海池→线索发现」翻转为「线索发现→公海池」）
    const disc = FULL_MENU.find((m) => m.label === '线索发现');
    expect(disc).toMatchObject({ group: '销售', href: '/discovery.html', requiresEntitlement: ['core_crm'] });
    expect(FULL_MENU.findIndex((m) => m.label === '公海池'))
      .toBe(FULL_MENU.findIndex((m) => m.label === '线索发现') + 1);
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
  it('ADMIN_MENU 恰 3 项系统（配置中心 / 智能体中心 / 报告；原系统集成已于 2026-09-18 移出左侧菜单）', () => {
    expect(ADMIN_MENU.map((m) => m.label)).toEqual(['配置中心', '智能体中心', '报告']);
    // 原系统集成 / crm-sync-console.html（需求④）：2026-09-18 用户裁定移出左侧菜单（不再作为系统快捷项）；
    //   现由配置中心「租户级 → 智能体与运行」#53/#54 卡片承载（见 test/config/* 契约）。断言其**不在** ADMIN_MENU 内
    expect(ADMIN_MENU.some((m) => m.href === '/crm-sync-console.html')).toBe(false);
  });
  it('admin 见 10 全员 + 3 系统（含销售决策监控台「报告」+ 全员「账单」）', () => {
    const m = menuFor('admin');
    expect(m.length).toBe(13);
    expect(m.filter((x) => x.group === '系统').map((x) => x.label)).toEqual(['配置中心', '智能体中心']);
    expect(m.some((x) => x.label === '报告' && x.href === '/sales-decision-monitor')).toBe(true);
    // 洞察分组对 admin 含「账单」（全员）与「报告」（admin）
    expect(m.filter((x) => x.group === '洞察').map((x) => x.label)).toEqual(['账单', '报告']);
  });
  it('sales/manager/presales/contract_admin 不见系统分组（10 项全员去掉财务应收 = 9，含账单与原系统集成不可见）', () => {
    for (const role of ['sales', 'manager', 'presales', 'contract_admin']) {
      const m = menuFor(role);
      expect(m.some((x) => x.group === '系统')).toBe(false);
      expect(m.length).toBe(9); // 报告已不在全员；财务应收 roles:[finance,admin] 除外；账单全员可见；外部沟通接入已移出
      expect(m.some((x) => x.label === '财务应收')).toBe(false);
      expect(m.some((x) => x.label === '报告')).toBe(false);
      expect(m.some((x) => x.href === '/crm-sync-console.html')).toBe(false);
      expect(m.some((x) => x.label === '账单' && x.href === '/billing.html')).toBe(true);
    }
  });
  it('finance 见 10 项（含财务应收 + 账单，按角色可见；报告仍仅 admin）', () => {
    const m = menuFor('finance');
    expect(m.some((x) => x.group === '系统')).toBe(false);
    expect(m.length).toBe(10);
    expect(m.some((x) => x.label === '报告')).toBe(false);
    expect(m.some((x) => x.label === '账单' && x.href === '/billing.html')).toBe(true);
  });
});
