// src/portal/layoutMenu.js — 导航菜单单源（FULL_MENU 全员 10 项 + ADMIN_MENU 系统分组仅 admin，3 项）
// 角色过滤：menuFor(role)；FULL_MENU/ADMIN_MENU 供 layout.js 与单测引用
// 客户深度洞察 + 指名客户监测合并为客户跟踪（S13 合并入口，画像/洞察 TAB 并入 named-accounts.html）
// ⚠ 「销售」组顺序 = 用户指定序列（2026-09-18 指令，覆盖 2026-09-14 的「公海池紧邻线索·商机」旧契约）：
//   线索发现 → 公海池 → 销售管道 → 客户跟踪（用户口语「客户 360」）→ 销售过程看板。
//   动线：找线索（发现）→ 入池/认领（公海池）→ 推进（管道）→ 客户经营（360）→ 行为复盘（看板）。
//   顺序即契约：test/portal/layoutMenu.test.js 逐步锁定，勿在中间插项而不动断言。
// ⚠ 显示名同步（2026-09-18 用户裁定「两个改名」）：菜单「线索·商机」→「销售管道」、
//   「销售行为看板」→「销售过程看板」，且**落点页自身 title/h1 同期对齐**（避免「点进去名字不一样」）；
//   菜单名 ↔ 页面标题的跨层一致性由 test/portal/layoutMenu.test.js 的「菜单名 = 落点页名」守卫锁定。
//   未改：「客户跟踪」（2026-08-29 深度洞察 + 指名客户监测合并时的定名，用户口头称「客户 360」）。
export const FULL_MENU = [
  // 线索发现工作台（2026-09-17 补可达性）：页面早已存在（routes.js:570 有 serve，test/web/discoveryPage.test.js 有契约），
  //   但**全仓零导航入口**——菜单/配置中心/其他页面均无链接指向它（仅本文件外无引用）=「页面在、但没人到得了」。
  //   2026-09-18 起置于「销售」组首位 = 线索链路的**最上游**：发现（外部找线索 + 按邮箱/公司名/域名定点补全画像）
  //   → 公海池（S0 入池/认领）。
  //   权益门禁与公海池同档 core_crm（同属拓客能力；无权益时整体隐藏入口，避免「能看不能用」的误导）。
  { group: '销售', label: '线索发现', href: '/discovery.html', requiresEntitlement: ['core_crm'] },
  // 公海池（2026-09-14）：公海 S0 待领取线索明细 + 认领闭环；销售角色可见。
  //   2026-09-18 起紧邻「线索发现」（发现→入池动线），不再紧邻线索·商机。
  // 权益门禁 core_crm：与 crm-lead-pick 动作权益一致（无 core_crm 仅能看不能领，故整体隐藏入口避免误导）。
  { group: '销售', label: '公海池', href: '/lead-pool.html', requiresEntitlement: ['core_crm'] },
  // 销售管道（2026-09-18 由「线索·商机」改名；页面 title 早已是「CRM 销售管道」，改名即让菜单与落点页同名）：商机推进主视图
  { group: '销售', label: '销售管道', href: '/pipeline.html' },
  // 客户 360（菜单名沿用「客户跟踪」，2026-08-29 深度洞察 + 指名客户监测合并决议）：受 customer_360 权益门禁（配置驱动，免费档不展示）
  { group: '销售', label: '客户跟踪', href: '/named-accounts.html', requiresEntitlement: ['customer_360'] },
  // 销售过程看板（2026-09-18 由「销售行为看板」改名；页面 title/h1 同步由「销售个人行为看板」改为本名）：S13 三层行为体系的过程面
  { group: '销售', label: '销售过程看板', href: '/sales-behavior-board.html' },
  // 销售自动化（2026-09-16 主动运行时 S1，原名「信号中心」）：统一信号收口（crm.signal 明细/确认/否决）。
  //   2026-09-16 决议：更名为「销售自动化」并从「销售」组移入「协同」组、置于「我的待办」之上
  //   （信号是待办的上游输入，同组相邻便于「信号 → 待办」动线）。
  //   href/页面文件名/路由/端点均不改（/signal-center.html 为稳定标识，仅显示名与分组变化）。
  // 外部沟通接入 / 通道配置台 channel-config.html（需求②）：2026-09-17 曾补此左侧菜单入口（入口死区修复），
  //   2026-09-18 用户裁定「不要放在左侧菜单里面」→ 移出。页面仍可经 cross-link 到达：index.html「或进入通道配置台」、
  //   channel-adapters.html / onboarding-guide.html 接入向导 / account-360.html / discovery-rules.html 面板。
  //   租户隔离由页面 ?tenant_id= 透传（缺省 'system'），故不进配置中心租户级卡片（避免 ten_admin 直开看到 platform 通道实例）。
  { group: '协同', label: '销售自动化', href: '/signal-center.html', requiresEntitlement: ['core_crm'] },
  { group: '协同', label: '我的待办', href: '/my-todo.html' },
  // 业务主数据门户（2026-08-28 实施计划）：与配置中心（admin 独享）边界分离，业务角色可见；
  // 5 个维护面只放在门户总览内，左侧菜单不再展开，避免臃肿。
  { group: '基础数据', label: '📚 基础数据门户', href: '/business-data.html' },
  // S05 财务应收闭环（T2）：finance 专属导航；admin 也可达（系统侧）
  { group: '财务', label: '财务应收', href: '/receivables.html', roles: ['finance', 'admin'] },
  // 多租户计费（T6）：全员可见；数据面按租户隔离（API 经 applyTenantOverride/scopeTenant 强制本租户）
  { group: '洞察', label: '账单', href: '/billing.html' },
  // 渠道门户（2026-09-18 经销商联邦 T8→当日归位）：用户裁定「放后台配置、前台叫渠道门户」。
  //   ★不再占左侧菜单（与 channel-config / crm-sync-console 同范式——入口死区修复后归位配置中心）。
  //   ★承载位置 = 配置中心「系统级 → 平台与访问」#57 经销商门户开关卡片（深链 /channel-admin.html#overview）。
  //   ★页面自身仍可经 #57 卡片 deep-link 到达（防孤岛：test/portal/layoutMenu.test.js 入口可达性守卫锁定）。
  //   ★落点页 src/web/channel-admin.html title/h1=「渠道门户」（前台名，与 Buddy 模式 channel 同名）。
];
export const ADMIN_MENU = [
  { group: '系统', label: '配置中心', href: '/config' },
  // 智能体中心：AI 智能体能力入口 → 受 ai_agents 权益门禁
  { group: '系统', label: '智能体中心', href: '/agent-workbench.html', requiresEntitlement: ['ai_agents'] },
  // 原系统集成 / CRM 同步配置 crm-sync-console.html（需求④）：2026-09-17 曾补此 ADMIN_MENU 入口（入口死区修复），
  //   2026-09-18 先租户级归位（删除系统级连接清单区）、再裁定「不要放在左侧菜单里面」→ 移出。
  //   页面现由配置中心「租户级 → 智能体与运行」#53/#54 卡片承载（租户级同步字段映射/信任档/同步状态），
  //   不再需要侧边栏快捷项；数据按租户隔离（scopeTenant/scopeOf 后端强制）。
  // 销售决策监控台：治理/审计类页面，仅 admin（销售员无需此权限，2026-09-03 收敛）
  // 决策监控 = 决策自治层能力 → 受 decision_autonomy 权益门禁（配置驱动）
  { group: '洞察', label: '报告', href: '/sales-decision-monitor', requiresEntitlement: ['decision_autonomy'] },
  // 平台套餐管理不再占侧边栏（2026-09-05 用户决议）：入口收敛到配置中心「系统级 → 平台与访问」#41 卡片（深链 /admin-billing-console.html#plans）
];
// 菜单过滤：按角色 + 按套餐权益（2026-09-06 补齐权益门禁）
//   entitlements 缺省（null）→ 只按角色过滤，保持既有调用点行为不变（向后兼容，避免误伤未知调用方）；
//   传入 Set 时，声明 requiresEntitlement 的菜单项必须全部命中才展示（与 Action 第 1.7 闸同一口径）。
export function menuFor(role, entitlements = null) {
  const sys = (role === 'admin' || role === 'sysadmin') ? ADMIN_MENU : [];
  const entOk = (m) => {
    if (!Array.isArray(m.requiresEntitlement) || !m.requiresEntitlement.length) return true;
    if (!entitlements) return true;
    return m.requiresEntitlement.every((k) => entitlements.has(k));
  };
  const base = FULL_MENU.filter((m) => (!m.roles || m.roles.includes(role)) && entOk(m));
  return [...base, ...sys.filter(entOk)];
}