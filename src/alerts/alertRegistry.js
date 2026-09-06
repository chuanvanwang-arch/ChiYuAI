// src/alerts/alertRegistry.js — 预警规则内存注册表（对齐 DB crm.alert_rule 镜像）
// 设计输入：docs/2026-08-25-alert-feedback-loop-design.md §B（5 类业务告警）+ §C（alert_rule 表结构）
// 种子对齐 §B：kind/match/check_params/enabled/version；payment_due T3-8 INVOICE 粒子落地后启用（stage3 收口）
import { evaluateAlertRule } from './ruleEvaluator.js';

// 默认种子（对齐 DB crm.alert_rule 镜像；DB 读表留 PG 环境，本地用内存镜像）
const DEFAULT_RULES = [
  {
    kind: 'deal_stuck',
    match: { particleTypes: ['CRM_DEAL'], actions: ['stage_update', 'advance'] },
    check_params: { stuck_days: 30 },
    enabled: true,
    version: 1,
  },
  {
    kind: 'lead_overdue',
    // 线索 = DEAL 的 lead 阶段（01 设计 line13：不新建 CRM_LEAD 粒子）→ 匹配 CRM_DEAL + lead 阶段动作
    match: { particleTypes: ['CRM_DEAL'], actions: ['lead-picked', 'lead-recycled', 'followup', 'update'] },
    check_params: { overdue_days: 30 },
    enabled: true,
    version: 1,
  },
  {
    kind: 'forecast_breach',
    match: { particleTypes: ['CRM_DEAL'], actions: ['forecast_update', 'amount_update'] },
    check_params: { breach_pct: 1.0 }, // 预测缺口：销售潜力 < 1.0（=100%）触发；阈值经 config_store['sales-thresholds'].funnel.forecast_breach_ratio 可调
    enabled: true,
    version: 1,
  },
  {
    kind: 'approval_bottleneck',
    match: { particleTypes: ['*'], actions: ['approval_create'] },
    check_params: { bottleneck_count: 5 },
    enabled: true,
    version: 1,
  },
  {
    kind: 'payment_due',
    match: { particleTypes: ['CRM_INVOICE'], actions: ['invoice_create', 'payment_create'] },
    check_params: { due_days: 7 },
    enabled: true, // T3-8 INVOICE 粒子落地 + T3-7 payment_due 事件源 → 启用（stage3 收口，对齐 §B）
    version: 1,
  },
  {
    // S05 T4：应收差额超阈值预警（合同维 Σplan−Σpaid 占比）；聚合端点显式触发（非粒子写事件驱动）
    kind: 'payment_gap',
    match: { particleTypes: ['CRM_PAYMENT_PLAN', 'CRM_PAYMENT_RECORD'], actions: ['payment_gap_check'] },
    check_params: { gap_threshold_pct: 5 },
    enabled: true,
    version: 1,
  },
  {
    // S05 T6：PAYMENT_PLAN 逾期告警（时间推移触发，checkOverdueAndEmit 第二维事件源）
    // 阈值运行时可被 config_store['finance-receivables'].payment_overdue_days 覆盖（financeAlertHook 动态读）
    kind: 'payment_due_plan',
    match: { particleTypes: ['CRM_PAYMENT_PLAN'], actions: ['payment_overdue_plan'] },
    check_params: { due_days: 7 }, // 缺省 7 天；financeAlertHook 读 config_store 覆盖
    enabled: true,
    version: 1,
  },
  // ── 三分类 A 类规则（2026-08-30；出厂建议值，运行时被 config_store['sales-thresholds'] 覆盖）──
  {
    // 覆盖缺口：目标客户 >target_days / 潜力客户 >potential_days 未拜访
    kind: 'coverage_gap',
    match: { particleTypes: ['CRM_ACCOUNT'], actions: ['daily_scan'] },
    check_params: { target_days: 30, potential_days: 90 },
    severity: 'medium',
    target_role: 'sales',
    enabled: true,
    version: 1,
  },
  {
    // 接触流失警戒：>lost_days 无任何拜访（3 个月不接触 → 大概率流失）
    kind: 'lost_contact',
    match: { particleTypes: ['CRM_ACCOUNT'], actions: ['daily_scan'] },
    check_params: { lost_days: 90 },
    severity: 'high',
    target_role: 'sales',
    enabled: true,
    version: 1,
  },
  {
    // 漏斗不健康：销售潜力 < health_min（滚动 2 Q 达标线 ≥100%）
    kind: 'funnel_unhealthy',
    match: { particleTypes: ['CRM_DEAL'], actions: ['daily_scan', 'forecast_update'] },
    check_params: { health_min: 1.0 },
    severity: 'high',
    target_role: 'exec',
    enabled: true,
    version: 1,
  },
  {
    // 承诺准确率红带：< yellow_low（下月承诺兑现 <80%）
    kind: 'commit_red',
    match: { particleTypes: ['CRM_DEAL'], actions: ['daily_scan', 'forecast_update'] },
    check_params: { yellow_low: 0.8 },
    severity: 'medium',
    target_role: 'sales',
    enabled: true,
    version: 1,
  },
  {
    // 漏斗抖动率：> jitter_max（季度/月抖动超标 ≤30%）
    kind: 'funnel_jitter',
    match: { particleTypes: ['CRM_DEAL'], actions: ['daily_scan', 'forecast_update'] },
    check_params: { jitter_max: 0.3 },
    severity: 'medium',
    target_role: 'exec',
    enabled: true,
    version: 1,
  },
  {
    // 指名客户应访逾期（2026-08-30 指名客户管理）：窗口内未达应访次数，经 namedVisitStatus 判红
    // 阈值 100% 走 config_store['sales-thresholds'].coverage.named_visit_alert_days（默认 2 天）
    // 触发源：timers named-visit-scan（时间推移驱动，非粒子写事件）
    kind: 'named_visit_overdue',
    match: { particleTypes: ['CRM_ACCOUNT'], actions: ['named_visit_scan'] },
    check_params: { alert_days: 2 },
    severity: 'high',
    target_role: 'sales',
    enabled: true,
    version: 1,
  },
];

// 深拷贝规则（match/check_params 独立副本）——防止 setRuleEnabled 改共享引用污染种子
const cloneRule = (r) => ({
  ...r,
  match: { ...r.match },
  check_params: { ...r.check_params },
});

const DEFAULT_TENANT = 'system';

// ── 内存规则表（DB 镜像；per-tenant 映射，2026-09-05 G3 租户化）──
// 语义对齐 configStore autoSeed：租户缺省 → 继承 system 模板（_inherited 只读标记，不落副本）；
//   租户显式 updateAlertRule → 深拷贝 system 模板落租户副本（此后自持，不污染 system/他租户）。
let rulesByTenant = new Map(); // tenantId -> rules[]

function cloneWithTenant(rule, tenantId, inherited) {
  return { ...cloneRule(rule), tenant_id: tenantId, ...(inherited ? { _inherited: true } : {}) };
}

// 取租户规则表（缺省 → 从 system 模板生成继承视图；只读不落副本）
function ensureTenant(tenantId) {
  const t = tenantId || DEFAULT_TENANT;
  if (!rulesByTenant.has(t)) {
    // 从 system 模板构建继承视图（若 system 本身也未初始化，用 DEFAULT_RULES）
    const sys = rulesByTenant.has(DEFAULT_TENANT) ? rulesByTenant.get(DEFAULT_TENANT) : DEFAULT_RULES.map((r) => cloneWithTenant(r, DEFAULT_TENANT, false));
    if (t === DEFAULT_TENANT) {
      rulesByTenant.set(DEFAULT_TENANT, sys);
      return sys;
    }
    rulesByTenant.set(t, sys.map((r) => cloneWithTenant(r, t, true)));
  }
  return rulesByTenant.get(t);
}

// 租户是否已拥有独立副本（显式改过）
function hasOwn(tenantId) {
  const t = tenantId || DEFAULT_TENANT;
  return rulesByTenant.has(t) && t !== DEFAULT_TENANT && !rulesByTenant.get(t).some((r) => r._inherited);
}

export function listAlertRules({ tenantId = DEFAULT_TENANT } = {}) {
  return ensureTenant(tenantId).map(r => ({ ...r }));
}

// 启停：kind 不存在 → {ok:false, error:'rule_not_found'}（按租户）
export function setRuleEnabled(kind, enabled, { tenantId = DEFAULT_TENANT } = {}) {
  const rs = ensureTenant(tenantId);
  const rule = rs.find(r => r.kind === kind);
  if (!rule) return { ok: false, error: 'rule_not_found' };
  rule.enabled = enabled;
  return { ok: true, rule: { ...rule } };
}

// 测试/重建用重置（对齐子系统三 resetRegistry 范式；深拷贝种子回落）
export function resetAlertRegistry() {
  rulesByTenant = new Map();
}

// 供 T4 写时接线使用：取启用规则列表（按租户）
export function enabledAlertRules({ tenantId = DEFAULT_TENANT } = {}) {
  return ensureTenant(tenantId).filter(r => r.enabled).map(r => ({ ...r }));
}

// 供 T4/内部用：对事件跑全量启用规则 → 命中列表（按租户）
export function evaluateForEvent(event, { tenantId = DEFAULT_TENANT } = {}) {
  const hits = [];
  for (const rule of enabledAlertRules({ tenantId })) {
    const r = evaluateAlertRule(rule, event);
    if (r.hit) hits.push({ rule, payload: r.payload });
  }
  return hits;
}

// 配置页写入口（item 21）：同步改内存缓存（引擎热路径实时读）；DB 落库由 Router 异步旁路负责。
// 不 import db.js —— 保持热路径同步、零阻塞。check_params 非空对象校验在此。
// 2026-09-05 G3：租户显式写 → 深拷贝 system 模板落租户副本（first-write 复制语义，对齐 autoSeed）
export function updateAlertRule(kind, patch = {}, { tenantId = DEFAULT_TENANT } = {}) {
  const t = tenantId || DEFAULT_TENANT;
  // 校验 check_params 合法性（早于落副本）
  if (patch.check_params !== undefined && (!patch.check_params || typeof patch.check_params !== 'object' || Array.isArray(patch.check_params)))
    return { ok: false, error: 'invalid_check_params' };
  const rs = ensureTenant(t);
  let rule = rs.find((r) => r.kind === kind);
  if (!rule) return { ok: false, error: 'rule_not_found' };
  // first-write 复制：租户还在继承态 → 转为独立副本（去掉 _inherited，深拷贝）
  if (rule._inherited) {
    const own = rs.map((r) =>
      r.kind === kind
        ? { ...cloneRule(r), tenant_id: t, _inherited: undefined }
        : { ...r }
    );
    rulesByTenant.set(t, own);
    rule = own.find((r) => r.kind === kind);
  }
  if (patch.enabled !== undefined) rule.enabled = !!patch.enabled;
  if (patch.check_params !== undefined) rule.check_params = { ...rule.check_params, ...patch.check_params };
  if (patch.severity !== undefined) rule.severity = patch.severity || null;
  if (patch.target_role !== undefined) rule.target_role = patch.target_role || null;
  return { ok: true, rule: { ...rule } };
}