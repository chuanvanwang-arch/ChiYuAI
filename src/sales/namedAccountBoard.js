// src/sales/namedAccountBoard.js — 指名客户监测看板聚合（owner 过滤 + 四维 + 达标缺口 + 21 条行为合格线）
// 设计：docs/2026-08-29-sales-crm-integration-design-v1-full-layers.md §12.3 + §12.3bis + §13.3
// 纯函数（零 DB）：输入 accounts/deals/contracts/contacts 数组 + targetsCfg，输出表格行
import { visitTargetFor, mergedTargets } from './namedAccountTargets.js';
import { evaluateBehaviorChecklist } from './behaviorChecklist.js';
import { pickNote } from './visitNote.js';
import { readThreshold, DEFAULT_THRESHOLDS } from './salesThresholds.js';
import { namedOwnerOf, namedStateOf, namedVisitStatus } from './namedAccountAssign.js';

// 单客户四维 + 达标 + 21 条行为合格线
// thresholds：判定阈值（config_store['sales-thresholds']），缺省回退默认，保证向后兼容
export function accountRow(account, deals, contracts, targetsCfg = {}, contacts = [], thresholds = DEFAULT_THRESHOLDS) {
  const p = account.payload || {};
  // 兼容历史/测试数据把业务字段存在 payload.payload 嵌套中的情况
  const pp = p.payload || p;
  // 指名分配：named_owner 优先（指名客户管理专属字段），回退 owner_id/owner（旧数据向后兼容）
  // named_state=inactive 为软停用（禁删铁律）；无主户（named_owner/owner_id/owner 回退链全空）不算指名
  const isNamed = namedStateOf(p) === 'active' && Boolean(namedOwnerOf(p));
  const dealList = deals.filter(d => (d.payload?.account_id || '') === account.id);
  const leads = dealList.filter(d => (d.payload?.stage || d.state) === 'lead').length;
  const opps = dealList.length - leads;
  const contractList = contracts.filter(c => (c.payload?.account_id || '') === account.id);
  const tv = visitTargetFor(pp, targetsCfg);
  // 拜访明细（供详情 TAB 渲染；JSONB 数组必须 Array.isArray 判定——铁律）
  const visits = Array.isArray(pp.visit_notes) ? pp.visit_notes : [];
  // 21 条行为标准（BH-01~07）——事实源：skills/method-behavior-standard/methodology.json
  const behavior = evaluateBehaviorChecklist(pp, dealList, contacts, thresholds, targetsCfg);
  // 告警状态（对接 Task1 namedVisitStatus 纯函数：pass/红黄绿/逾期天数/应访日）——Task5 管理页契约字段
  const alertStatus = namedVisitStatus(pp, tv.tier || '潜力', targetsCfg, thresholds);
  return {
    id: account.id,
    tenant_id: account.tenant_id,
    name: p.name || account.title || account.id,
    owner: isNamed ? namedOwnerOf(p) : '未分配',
    named: isNamed,
    tier: tv.tier || '潜力',
    visits30: tv.actual,
    visitPass: tv.pass,
    visitTarget: tv.target, // 目标频率次数（供客户360目标卡文案）
    visitWindow: tv.window, // week|month|quarter（供客户360目标卡文案）
    alert: alertStatus.alert, // red|yellow|null（管理页告警列）
    overdueDays: alertStatus.overdueDays, // 逾期天数（应访日已过）
    visitDue: alertStatus.dueAt, // 应访日 ISO（管理页应访日列）
    leads,
    opps,
    contracts: contractList.length,
    gaps: gapHint(p, tv, leads, opps, contractList.length, dealList, thresholds),
    visits: visits.map(n => ({ at: n.at, objective: pickNote(n, 'objective'), result: pickNote(n, 'result'), next: pickNote(n, 'next') })),
    // 失联判定（2026-08-31 侧栏「客户跟踪」角标数据源）：仅指名客户计算，
    // 与 alertRed 统计同口径——无主户（非指名）恒 false，不引入新统计口径。
    lostContact: isNamed ? isLostContact(pp, thresholds) : false,
    lastContactDays: (isNamed
      ? (() => { const t = lastVisitAtOf(pp); return t ? Math.floor((Date.now() - t) / 86400000) : null; })()
      : null),
    behavior,
  };
}

// 最近一次拜访时间戳（毫秒；无拜访 / 全为脏数据 → null）
// DRY 提取（2026-08-31）：gapHint 的「接触流失警戒」与 accountRow 的 lostContact 判定共用同一口径，
// 消除同一逻辑两处实现导致的双源漂移（drift）风险；零 DB、可单测。
export function lastVisitAtOf(p = {}) {
  const notes = Array.isArray(p?.visit_notes) ? p.visit_notes : [];
  const ts = notes
    .map((n) => (n?.at ? new Date(n.at).getTime() : NaN))
    .filter((t) => !Number.isNaN(t));
  return ts.length ? Math.max(...ts) : null;
}

// 失联判定：距最近一次拜访 > coverage.lost_contact_days 天（默认 90，id32 后台可调，零硬编码）
// 契约：从未拜访（lastAt=null）→ false（新客户不算失联，避免误报）
export function isLostContact(p = {}, thresholds = DEFAULT_THRESHOLDS) {
  const lastAt = lastVisitAtOf(p);
  if (!lastAt) return false;
  const lostContactDays = Number(readThreshold(thresholds, 'coverage.lost_contact_days', 90));
  return (Date.now() - lastAt) > lostContactDays * 86400000;
}

function gapHint(p, tv, leads, opps, contracts, dealList, thresholds = DEFAULT_THRESHOLDS) {
  const gaps = [];
  const tier = tv.tier || '潜力';
  // 阈值一律走配置（用户 2026-08-30 原则：业务数值不硬编码）
  const pass = readThreshold(thresholds, 'bantcc.pass');
  const stuckDays = readThreshold(thresholds, 'stage.stuck_days');
  const lostContactDays = readThreshold(thresholds, 'coverage.lost_contact_days');
  // 接触流失警戒：超过 coverage.lost_contact_days 天无任何拜访（默认 90 天，3 个月不接触→大概率流失）
  // 判定复用 isLostContact（DRY：与 accountRow.lostContact 同源，口径不一致会由单测守卫捕获）
  const lastAt = lastVisitAtOf(p);
  if (lastAt && isLostContact(p, thresholds)) gaps.push(`接触流失警戒（>${lostContactDays}天无拜访）`);
  if (tier === '目标' && !tv.pass) gaps.push('覆盖率缺口（近30天无拜访）');
  if (tier === '潜力' && !tv.pass) gaps.push('温养缺口（近90天无拜访）');
  if (opps === 0 && (p.needs || p.pain_points)) gaps.push('商机过滤缺口（有需求未建商机）');
  // BANTCC 是商机级资质（见 evaluator.js bantcc_completeness）；账户级取所属商机最高齐全度
  const bantcc = bestBantcc(dealList, readThreshold(thresholds, 'bantcc.unknown'));
  if (opps > 0 && bantcc < pass) gaps.push('BANTCC 信息缺口');
  const stuck = dealList.some(d => (d.payload?.stage === 'S4' || d.payload?.stage === 'S5') && d.payload?.stage_changed_at
    && (Date.now() - new Date(d.payload.stage_changed_at).getTime()) > stuckDays * 86400000);
  if (stuck) gaps.push(`推进卡点（S4/S5 停留>${stuckDays}天）`);
  return gaps;
}

// 账户级 BANTCC 齐全度 = 所属商机 ai.bantcc_completeness 的最高值（任一商机达标即视为有资质）
// 无商机或商机未评估 → bantcc.unknown 配置值（默认 0.5，按缺口处理）
function bestBantcc(dealList = [], unknownFallback = 0.5) {
  if (!dealList || !dealList.length) return unknownFallback;
  const vals = dealList.map(d => Number(d?.payload?.ai?.bantcc_completeness?.value ?? unknownFallback));
  return Math.max(...vals);
}

// 列表组装（owner 过滤按 named_owner 派生；named_state=inactive 软停用户默认不展示——禁删铁律）
export function buildNamedAccountBoard({ accounts = [], deals = [], contracts = [], targetsCfg = {}, ownerFilter = null, contacts = [], thresholds = DEFAULT_THRESHOLDS, includeInactive = false } = {}) {
  // 内部兜底合并（防御裸 config 崩溃，同 boardSummary）
  targetsCfg = mergedTargets(targetsCfg);
  const scoped = (ownerFilter
    ? accounts.filter(a => namedOwnerOf(a.payload || {}) === ownerFilter)
    : accounts.filter(a => Boolean(namedOwnerOf(a.payload || {}))) // 无主户剔除：指名视图只展示有主账户
  ).filter(a => includeInactive || namedStateOf(a.payload || {}) === 'active');
  return scoped.map(a => accountRow(a, deals, contracts, targetsCfg, contacts, thresholds));
}

// 2026-08-31 根因修复（buildNamedAccountBoard 仅展示有 named_owner 的账户，但这些账户 AI/页面写时漏 named_owner
//   会"消失"在看板中）。导出一个 listUnassignedAccounts 纯函数供 admin/manager 视角下的"无主待分配"
//   分桶使用；零 DB、可单测。
// 过滤条件：named_owner/owner_id/owner 三键全空（与 namedAccountAssign 候选口径一致）；
// 字段映射：id + name（payload.name 优先 slug 兜底）+ tier（named_tier 优先）+ state + created_at
export function listUnassignedAccounts(accounts = []) {
  return (Array.isArray(accounts) ? accounts : [])
    .filter((a) => !(a?.payload?.named_owner || a?.payload?.owner_id || a?.payload?.owner))
    .map((a) => ({
      id: a.id,
      name: a.payload?.name || a.slug || a.id,
      tier: a.payload?.named_tier || a.payload?.tier || '潜力',
      created_at: a.created_at,
      state: a.state,
    }));
}

// 看板防呆（§5 防复发·原方案 B）：识别"未正确归属"的商机，作为兜底视图暴露（不改主数据）
//  - account_id 为空 / 指向不存在账户 → reason='account_missing'（孤儿商机）
//  - customer 名与归属账户名不一致 → reason='account_mismatch'（错绑，类王总单错绑印通）
// 纯函数（零 DB），与 buildNamedAccountBoard 同源过滤，便于单测。
function normalizeNameLocal(name) {
  return String(name == null ? '' : name).trim().replace(/\s+/g, '');
}
export function listOrphanDeals(accounts = [], deals = []) {
  const accMap = new Map((accounts || []).map((a) => [a.id, a]));
  const out = [];
  for (const d of (deals || [])) {
    const p = d?.payload || {};
    const aid = p.account_id || '';
    const acct = accMap.get(aid);
    const customer = p.customer || p.customer_name || null;
    if (!aid || !acct) {
      out.push({ deal_id: d.id, name: p.name || d.title || d.id, reason: 'account_missing', account_id: aid || null, customer });
      continue;
    }
    const an = normalizeNameLocal(acct.payload?.name || '');
    const cn = normalizeNameLocal(customer || '');
    if (cn && an && an !== cn) {
      out.push({ deal_id: d.id, name: p.name || d.title || d.id, reason: 'account_mismatch', account_id: aid, account_name: acct.payload?.name, customer });
    }
  }
  return out;
}

// 看板聚合 KPI（客户列表 TAB 顶部卡片）：目标客户数 / 今日·本周·本月拜访数 + 四维汇总
// 纯函数（零 DB），与 buildNamedAccountBoard 同源过滤，便于单测。
export function boardSummary(accounts = [], deals = [], contracts = [], targetsCfg = {}, ownerFilter = null, contacts = [], behaviorStd = {}, thresholds = DEFAULT_THRESHOLDS) {
  // 内部兜底合并（防御裸 config 崩溃：调用方未 mergedTargets 时不吃 tierOf undefined）——
  // routes.js 传入前已合并，此处仅防测试/未来调用方漏合并
  targetsCfg = mergedTargets(targetsCfg);
  const scoped = (ownerFilter
    ? accounts.filter(a => namedOwnerOf(a.payload || {}) === ownerFilter)
    : (accounts || []).filter(a => Boolean(namedOwnerOf(a.payload || {}))) // 无主户剔除（与 build 同口径）
  ).filter(a => namedStateOf(a.payload || {}) === 'active');
  // 日期窗口（本地时区：今日=本地 0 点起；本周/本月=滚动 N 天，对齐 window_days 语义）
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const t0 = startOfToday.getTime();
  const w0 = t0 - 6 * 86400000; // 近 7 天（含今日）
  const m0 = t0 - 29 * 86400000; // 近 30 天（含今日）
  // L1 销售个人行为量化目标实际值（id31）：拜访/电话按 visit_notes.type 区分（缺省='visit'）；
  // 每周拜访客户数 = 近7天有拜访的去重账户数；每周新客户数 = created_at 近7天的账户数（owner 过滤后）。
  // 窗口语义：today=本地0点；近7天=含今日滚动7天；近30天=滚动30天。
  let todayVisits = 0, weekVisits = 0, monthVisits = 0, totalVisits = 0;
  let todayCalls = 0, weekNewCustomers = 0;
  const visitedCustomerWeek = new Set();
  for (const a of scoped) {
    const ap = a.payload?.payload || a.payload || {};
    const notes = Array.isArray(ap.visit_notes) ? ap.visit_notes : [];
    totalVisits += notes.length;
    let aVisitedThisWeek = false;
    for (const n of notes) {
      const t = n?.at ? new Date(n.at).getTime() : NaN;
      if (Number.isNaN(t)) continue;
      const isCall = n?.type === 'call'; // 缺省 'visit'（向后兼容旧数据）
      if (t >= t0) { if (isCall) todayCalls++; else todayVisits++; }
      if (t >= w0) { weekVisits++; aVisitedThisWeek = true; }
      if (t >= m0) monthVisits++;
    }
    if (aVisitedThisWeek) visitedCustomerWeek.add(a.id);
    const ca = a.created_at ? new Date(a.created_at).getTime() : NaN;
    if (!Number.isNaN(ca) && ca >= w0) weekNewCustomers++;
  }
  const rows = buildNamedAccountBoard({ accounts, deals, contracts, targetsCfg, ownerFilter, contacts, thresholds });
  const opps = rows.reduce((m, r) => m + (r.opps || 0), 0);
  const contractsCount = rows.reduce((m, r) => m + (r.contracts || 0), 0);
  const gapTotal = rows.reduce((m, r) => m + (Array.isArray(r.gaps) ? r.gaps.length : 0), 0);
  const visitPassCount = rows.reduce((m, r) => m + (r.visitPass ? 1 : 0), 0);
  // 21 条行为合格率（BH-01~07）
  const behaviorPassTotal = rows.reduce((m, r) => m + (r.behavior?.pass || 0), 0);
  const behaviorTotalMax = rows.reduce((m, r) => m + (r.behavior?.total || 21), 0);
  // 销售行为量化目标（id31：每天拜访次数等）—— 看板直接对比实际 vs 目标
  const bs = behaviorStd || {};
  return {
    targetCustomers: scoped.length, // 指名客户数（当前 owner 名下）
    todayVisits,
    todayCalls,            // L1 每天电话量实际（type='call'）
    weekVisits,
    monthVisits,
    totalVisits,
    weekVisitCustomers: visitedCustomerWeek.size, // L1 每周拜访客户数实际（去重）
    weekNewCustomers,      // L1 每周新客户数实际（created_at 近7天）
    opps,
    contracts: contractsCount,
    gapTotal,
    visitPassCount,
    lostContactCount: rows.reduce((m, r) => m + (r.lostContact ? 1 : 0), 0), // 失联客户数（侧栏角标「长期失联」计数）
    namedTotal: rows.length,
    behaviorPassRate: behaviorTotalMax ? Math.round((behaviorPassTotal / behaviorTotalMax) * 100) : 0,
    // 量化目标（默认口径，配置中心 id31 可改）
    dailyVisitTarget: Number(bs.daily_visit_count ?? 2),
    weeklyVisitCustomerTarget: Number(bs.weekly_visit_customer ?? 8),
    weeklyNewCustomerTarget: Number(bs.weekly_new_customer ?? 5),
    dailyCallTarget: Number(bs.daily_call_count ?? 10),
    // 覆盖/拜访容量基准（config_store['sales-thresholds'].coverage，id32 可后台直调）——
    // 与 id31 量化目标互补：id31 是"个人目标"，coverage 是"方法标准（外部 SKILL 建议值）"。
    covDailyVisitTarget: readThreshold(thresholds, 'coverage.daily_visits_target', 3),
    covWeeklyVisitTarget: readThreshold(thresholds, 'coverage.weekly_visits_target', 15),
    covDailyVisitOptimized: readThreshold(thresholds, 'coverage.daily_visits_optimized', 4),
    covInfoCollectWeekly: readThreshold(thresholds, 'coverage.info_collect_weekly', 5),
    covCustomerCountMin: readThreshold(thresholds, 'coverage.customer_count_min', 60),
    covCustomerCountTarget: readThreshold(thresholds, 'coverage.customer_count_target', 75),
    // 达标布尔：当前 owner 视角的标准对比
    covVisitsOk: (todayVisits + todayCalls) >= readThreshold(thresholds, 'coverage.daily_visits_target', 3),
    covWeekVisitsOk: weekVisits >= readThreshold(thresholds, 'coverage.weekly_visits_target', 15),
    covCustomerOk: scoped.length >= readThreshold(thresholds, 'coverage.customer_count_min', 60),
    // 21 条合格率着色阈值（2026-08-30 三分类 B 类配置化：防硬编码 80 漂移；键已在 sales-thresholds 缺省定义）
    behaviorPassRateThreshold: readThreshold(thresholds, 'ui.behavior_pass_rate_ok', 80),
  };
}