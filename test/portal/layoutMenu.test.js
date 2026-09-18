import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { menuFor, ADMIN_MENU, FULL_MENU } from '../../src/portal/layoutMenu.js';

describe('menuFor 角色可见性', () => {
  it('公海池入口存在且销售可见（core_crm 门禁；位于线索发现之后 = 发现→入池动线）', () => {
    const idx = FULL_MENU.findIndex((x) => x.label === '公海池');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(FULL_MENU[idx].href).toBe('/lead-pool.html');
    // 2026-09-18 用户指定顺序：公海池前一项 = 线索发现
    //   （2026-09-14 的「紧邻线索·商机」旧契约已被该指令取代）
    expect(FULL_MENU[idx - 1]?.label).toBe('线索发现');
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

// ── 「销售」组顺序契约（2026-09-18 用户指定）────────────────────────────
// 诉求原文：「销售里面的顺序为：线索发现-公海池-销售管道-客户360-销售过程看板」
// 名称 ↔ 稳定标识映射（2026-09-18 二次裁定「两个改名」后，菜单显示名已与用户词汇对齐）：
//   线索发现            = /discovery.html
//   公海池              = /lead-pool.html
//   销售管道            = /pipeline.html             （原名「线索·商机」）
//   客户 360            = 菜单「客户跟踪」/named-accounts.html（保留 2026-08-29 合并定名，本次未改）
//   销售过程看板        = /sales-behavior-board.html （原名「销售行为看板」）
// ⚠ 顺序即契约：断言「实际渲染出的销售组次序」，而非只看 FULL_MENU 数组——
//   渲染走 layout.js 的分组聚合（groups[m.group] 按 push 次序），任何中间层重排都会被这条抓住。
// ⚠ 改名即契约：旧名残留与「菜单名 ≠ 落点页名」都有独立断言（见文件末 describe），
//   因为这两类缺陷都**不会**让「按 href 断言」的用例变红（两侧各自都"没错"）。
const SALES_ORDER = ['/discovery.html', '/lead-pool.html', '/pipeline.html', '/named-accounts.html', '/sales-behavior-board.html'];

describe('「销售」组顺序（用户指定序列）', () => {
  it('FULL_MENU 销售组按序 = 线索发现 → 公海池 → 销售管道 → 客户 360 → 销售过程看板', () => {
    expect(FULL_MENU.filter((m) => m.group === '销售').map((m) => m.href)).toEqual(SALES_ORDER);
  });
  it('渲染层同序：menuFor 输出的销售组次序与 FULL_MENU 一致（含权益全开）', () => {
    const full = new Set(['core_crm', 'customer_360', 'decision_autonomy', 'ai_agents']);
    expect(menuFor('sales', full).filter((m) => m.group === '销售').map((m) => m.href)).toEqual(SALES_ORDER);
    expect(menuFor('manager', full).filter((m) => m.group === '销售').map((m) => m.href)).toEqual(SALES_ORDER);
  });
  it('权益裁剪后仍保序：无 customer_360 时客户 360 消失，其余四项相对次序不变', () => {
    expect(menuFor('sales', new Set(['core_crm'])).filter((m) => m.group === '销售').map((m) => m.href))
      .toEqual(['/discovery.html', '/lead-pool.html', '/pipeline.html', '/sales-behavior-board.html']);
  });
});

// ── 菜单名 = 落点页名（跨层一致性守卫 · 2026-09-18 改名时补）────────────────
// 病灶：改名前的缺陷形态是**两层各叫各的** —— 菜单「线索·商机」/ 页面 title「CRM 销售管道」；
//   菜单「销售行为看板」/ 页面 h1「销售个人行为看板」。用户从侧栏点进去看到的名字与入口不一致。
// ⚠ 「按 href 断言顺序」的用例抓不到这种不一致：两层各自都"没错"，只有**跨层相等**本身是缺陷对象。
//   故此处把「菜单名 ∈ 落点页 title/h1」设为断言，新增销售项若不同步页面名会直接红。
describe('「销售」组菜单名 = 落点页名（跨层一致）', () => {
  const PAGE = {
    '/discovery.html': 'discovery.html',
    '/lead-pool.html': 'lead-pool.html',
    '/pipeline.html': 'pipeline.html',
    '/named-accounts.html': 'named-accounts.html',
    '/sales-behavior-board.html': 'sales-behavior-board.html',
  };
  const readPage = (f) => fs.readFileSync(new URL(`../../src/web/${f}`, import.meta.url), 'utf8');
  const names = (html) => ({
    title: (html.match(/<title>([^<]*)<\/title>/) || [])[1] || '',
    h1: (html.match(/<h1[^>]*>([^<]*)<\/h1>/) || [])[1] || '',
  });
  // 否定断言剥离注释：只在「真实渲染文本」上判旧名是否残留，避免注释里的历史沿革被误判为残留
  const codeOnly = (html) => html.replace(/<!--[\s\S]*?-->/g, '');

  it('五项菜单名都出现在其落点页的 title 或 h1 中', () => {
    for (const m of FULL_MENU.filter((x) => x.group === '销售')) {
      const file = PAGE[m.href];
      expect(file, `${m.href} 未登记落点页（新增销售项请同步 PAGE 表）`).toBeTruthy();
      const { title, h1 } = names(readPage(file));
      expect(`${title} ${h1}`, `菜单「${m.label}」≠ 落点页「${title} / ${h1}」`).toContain(m.label);
    }
  });

  it('页面侧旧名已清除（销售个人行为看板 → 销售过程看板）', () => {
    const html = codeOnly(readPage('sales-behavior-board.html'));
    expect(html).toContain('销售过程看板');
    expect(html).not.toContain('销售个人行为看板');
  });

  it('销售管道页标题含新名（pipeline.html：「CRM 销售管道」→ 含「销售管道」）', () => {
    const { title } = names(readPage('pipeline.html'));
    expect(title).toContain('销售管道');
  });
});
