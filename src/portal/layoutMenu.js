// src/portal/layoutMenu.js — 导航菜单单源（FULL_MENU 全员 9 项 + ADMIN_MENU 系统分组仅 admin）
// 角色过滤：menuFor(role)；FULL_MENU/ADMIN_MENU 供 layout.js 与单测引用
// 客户深度洞察 + 指名客户监测合并为客户跟踪（S13 合并入口，画像/洞察 TAB 并入 named-accounts.html）
export const FULL_MENU = [
  { group: '销售', label: '线索·商机', href: '/pipeline.html' },
  // 公海池（2026-09-14）：公海 S0 待领取线索明细 + 认领闭环；紧邻线索·商机，销售角色可见。
  // 权益门禁 core_crm：与 crm-lead-pick 动作权益一致（无 core_crm 仅能看不能领，故整体隐藏入口避免误导）。
  { group: '销售', label: '公海池', href: '/lead-pool.html', requiresEntitlement: ['core_crm'] },
  // 线索发现工作台（2026-09-17 补可达性）：页面早已存在（routes.js:570 有 serve，test/web/discoveryPage.test.js 有契约），
  //   但**全仓零导航入口**——菜单/配置中心/其他页面均无链接指向它（仅本文件外无引用）=「页面在、但没人到得了」。
  //   与「公海池」构成线索链路的上游→下游：发现（外部找线索 + 按邮箱/公司名/域名定点补全画像）→ 公海池（S0 入池/认领）。
  //   权益门禁与公海池同档 core_crm（同属拓客能力；无权益时整体隐藏入口，避免「能看不能用」的误导）。
  //   ⚠ 位置刻意排在「公海池」**之后**：test/portal/layoutMenu.test.js 锁着「公海池紧邻线索·商机」契约（2026-09-14 用户诉求）。
  { group: '销售', label: '线索发现', href: '/discovery.html', requiresEntitlement: ['core_crm'] },
  // 客户跟踪：客户 360 洞察入口 → 受 customer_360 权益门禁（配置驱动，免费档不展示）
  { group: '销售', label: '客户跟踪', href: '/named-accounts.html', requiresEntitlement: ['customer_360'] },
  { group: '销售', label: '销售行为看板', href: '/sales-behavior-board.html' },
  // 销售自动化（2026-09-16 主动运行时 S1，原名「信号中心」）：统一信号收口（crm.signal 明细/确认/否决）。
  //   2026-09-16 决议：更名为「销售自动化」并从「销售」组移入「协同」组、置于「我的待办」之上
  //   （信号是待办的上游输入，同组相邻便于「信号 → 待办」动线）。
  //   href/页面文件名/路由/端点均不改（/signal-center.html 为稳定标识，仅显示名与分组变化）。
  // 外部沟通接入（2026-09-17 补可达性 · 需求②）：通道配置台 channel-config.html。
  //   与「线索发现」同一形态缺陷：routes 有 serve（routes.js 通道挂载）、
  //   test/web/channelConfigPage.test.js 有契约、页面互链也做了（discovery-rules 面板 + 360 + 接入台），
  //   但**主导航零入口** ⇒ 用户从侧边栏根本到不了「接通邮箱/日历/会议/微信」的配置面
  //   （页面在、链路通、没人到得了 = 入口死区）。补此入口后：接入（本项）→ 信号（销售自动化）→ 待办 成一条动线。
  //   权益门禁同 core_crm（与公海池/线索发现/销售自动化同档，均属 CRM 核心能力）。
  { group: '协同', label: '外部沟通接入', href: '/channel-config.html', requiresEntitlement: ['core_crm'] },
  { group: '协同', label: '销售自动化', href: '/signal-center.html', requiresEntitlement: ['core_crm'] },
  { group: '协同', label: '我的待办', href: '/my-todo.html' },
  // 业务主数据门户（2026-08-28 实施计划）：与配置中心（admin 独享）边界分离，业务角色可见；
  // 5 个维护面只放在门户总览内，左侧菜单不再展开，避免臃肿。
  { group: '基础数据', label: '📚 基础数据门户', href: '/business-data.html' },
  // S05 财务应收闭环（T2）：finance 专属导航；admin 也可达（系统侧）
  { group: '财务', label: '财务应收', href: '/receivables.html', roles: ['finance', 'admin'] },
  // 多租户计费（T6）：全员可见；数据面按租户隔离（API 经 applyTenantOverride/scopeTenant 强制本租户）
  { group: '洞察', label: '账单', href: '/billing.html' },
];
export const ADMIN_MENU = [
  { group: '系统', label: '配置中心', href: '/config' },
  // 智能体中心：AI 智能体能力入口 → 受 ai_agents 权益门禁
  { group: '系统', label: '智能体中心', href: '/agent-workbench.html', requiresEntitlement: ['ai_agents'] },
  // 原系统集成（2026-09-17 补可达性 · 需求④）：一次性抽取 / 定时增量 / MCP 回写 的控制台。
  //   同「线索发现」「外部沟通接入」形态：routes 有 serve（/crm-sync-console.html）、
  //   页面测试存在、配置中心有卡片，但**主导航零入口**；且该页数据面仅 ADMIN/sysadmin 可管
  //   （/api/integration/providers → 403「接入数据源仅 ADMIN/sysadmin 可管理（§15.1）」），
  //   故登记在 ADMIN_MENU「系统」组——放在销售侧菜单会变成「进得去、拿不到数据」的误导入口。
  { group: '系统', label: '原系统集成', href: '/crm-sync-console.html' },
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