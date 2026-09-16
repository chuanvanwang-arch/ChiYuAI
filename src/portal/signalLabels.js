// src/portal/signalLabels.js — 信号显示层单源（浏览器 + vitest 共用，纯函数零依赖）
//
// 为什么需要它（2026-09-16 用户实测反馈「表格内容看不懂」）：
//   销售自动化页此前直出 crm.signal 的内部字段 —— 类型列是 kind 原始码（info_collect_lag）、
//   严重度是英文档位（low/medium）、摘要列回落成 kind、对象列恒为「—」；
//   而非粒子锚定的聚合类信号 payload 只有裸指标键（{weekNew:0,weeklyMin:5}），表格上完全不可读。
//
// 定位：crm.signal **全部产生点**的 kind 在此收敛为中文，severity/status 同理；
//   摘要按各 kind 的真实 payload 形状生成可读句子（形状以真库 GROUP BY 实测为准，非按文档猜）。
//
// 铁律：
//   ① 单源——页面不得自建第二份映射（本文件是唯一事实源，与 tokens.css 同范式）；
//   ② 原始码不丢——中文为主，调用方在 title 中保留 kind 原始码，可溯源、可对日志；
//   ③ 未知 kind 不隐藏、不编造——原样回显原始码（禁止「假绿」式美化：看不懂的内容必须仍然是真实的）。
//
// 产生点对照（kind → 生产者）：
//   src/alerts/alertRegistry.js  DEFAULT_RULES 13 项
//   src/scheduler/salesDailyScan.js  visit_shortfall / info_collect_lag（巡检直写 metric）
//   src/signal/prospectScanner.js   s0_stale / s0p_recycle_warn / candidate_touch_window
//   src/signal/researchScheduler.js suggestion_card
//   src/signal/followupEngine.js    object_changed
//   src/signal/scheduleScanner.js   quote_approval_timeout / stage_silence / price_baseline_drift（配置驱动）

// ── 类型（kind）→ 中文名 ──
export const SIGNAL_KIND_LABELS = {
  // 规则扫描（alertRegistry DEFAULT_RULES）
  deal_stuck: '商机停滞',
  lead_overdue: '线索逾期',
  forecast_breach: '预测缺口',
  approval_bottleneck: '审批瓶颈',
  payment_due: '回款到期',
  payment_gap: '应收差额超限',
  payment_due_plan: '回款计划逾期',
  coverage_gap: '客户覆盖缺口',
  lost_contact: '客户流失警戒',
  funnel_unhealthy: '漏斗不健康',
  commit_red: '承诺兑现偏红',
  funnel_jitter: '漏斗抖动超标',
  named_visit_overdue: '指名应访逾期',
  // 三分类 A 类巡检
  visit_shortfall: '拜访量未达标',
  info_collect_lag: '信息收集落后',
  // 公海/候选池扫描
  s0_stale: '公海超期未认领',
  s0p_recycle_warn: '公海回收预警',
  candidate_touch_window: '候选触达窗口',
  // 主动研究 / 外部事件
  suggestion_card: '主动研究建议',
  object_changed: '外部对象变化',
  // 时间型（signal-schedule 配置驱动）
  quote_approval_timeout: '报价审批超时',
  stage_silence: '阶段静默超期',
  price_baseline_drift: '价格基线偏离',
};

// 中文名；未知 kind 原样回显（不隐藏真值）
export function kindLabel(kind) {
  const k = String(kind ?? '').trim();
  if (!k) return '—';
  return SIGNAL_KIND_LABELS[k] || k;
}

export const SEVERITY_LABELS = { high: '高', medium: '中', low: '低' };
export function severityLabel(severity) {
  const s = String(severity ?? '').trim();
  if (!s) return '—';
  return SEVERITY_LABELS[s] || s;
}

export const STATUS_LABELS = { open: '待处理', acked: '已确认', closed: '已否决', acted: '已成单' };
export function statusLabel(status) {
  const s = String(status ?? '').trim();
  if (!s) return '—';
  return STATUS_LABELS[s] || s;
}

// 比例型字段（0–1 语义）：渲染为百分比，避免 0.8 这类裸小数再制造一次「看不懂」
const RATIO_FIELDS = new Set([
  'commitRate', 'yellow_low', 'jitterRate', 'jitter_max',
  'salesPotential', 'health_min', 'ratio', 'breach_pct',
]);

// payload 键 → 中文（通用兜底渲染，覆盖尚未写专用摘要的 kind）
const FIELD_LABELS = {
  dailyVisits: '今日拜访', dailyTarget: '今日目标',
  weeklyVisits: '本周拜访', weeklyTarget: '本周目标',
  weekNew: '本周新增客户', weeklyMin: '周最低要求',
  daysSinceVisit: '距上次拜访', windowDays: '窗口',
  ageDays: '入池天数', followAgeDays: '跟进天数',
  overdueDays: '逾期天数', stuckDays: '停滞天数', dueDays: '距到期',
  threshold: '阈值', tier: '客户分层',
  salesPotential: '销售潜力', health_min: '健康线',
  jitterRate: '抖动率', jitter_max: '抖动上限',
  commitRate: '承诺兑现率', yellow_low: '警戒线',
  ratio: '兑现比例', breach_pct: '缺口阈值',
  named_owner: '责任人', account_id: '客户', external_id: '外部对象',
};

const num = (v) => (typeof v === 'number' ? v : Number(v));
const isNum = (v) => v != null && v !== '' && Number.isFinite(num(v));

// 单字段值渲染：比例字段 → 百分比；天数/次数 → 带单位；对象 → 原样
function fmtValue(key, v) {
  if (v == null || v === '') return '—';
  if (RATIO_FIELDS.has(key)) return isNum(v) ? `${Math.round(num(v) * 100)}%` : String(v);
  if (key === 'tier') return String(v);
  if (/Days$|^threshold$/.test(key) && isNum(v)) return `${num(v)} 天`;
  if (isNum(v)) return String(num(v));
  return String(v);
}

// 各 kind 的专用摘要（按真库实测 payload 形状编写；返回 null 表示走兜底）
const SUMMARIZERS = {
  // 巡检直写 metric 形状：{dailyVisits,dailyTarget} 或 {weeklyVisits,weeklyTarget}
  // 规则评估器形状：{dailyVisits,weeklyVisits,threshold:{daily,weekly}}
  visit_shortfall: (p) => {
    if (isNum(p.dailyTarget)) return `今日拜访 ${num(p.dailyVisits)} 次，未达目标 ${num(p.dailyTarget)} 次`;
    if (isNum(p.weeklyTarget)) return `本周拜访 ${num(p.weeklyVisits)} 次，未达目标 ${num(p.weeklyTarget)} 次`;
    const th = p.threshold || {};
    if (isNum(th.daily)) return `今日拜访 ${num(p.dailyVisits)} 次，未达目标 ${num(th.daily)} 次`;
    if (isNum(th.weekly)) return `本周拜访 ${num(p.weeklyVisits)} 次，未达目标 ${num(th.weekly)} 次`;
    return null;
  },
  info_collect_lag: (p) => {
    const min = isNum(p.weeklyMin) ? num(p.weeklyMin) : (isNum(p.threshold) ? num(p.threshold) : null);
    if (!isNum(p.weekNew) || min == null) return null;
    return `本周新增客户 ${num(p.weekNew)} 家，低于周最低要求 ${min} 家`;
  },
  coverage_gap: (p) => {
    if (!isNum(p.daysSinceVisit)) return null;
    const win = isNum(p.windowDays) ? num(p.windowDays) : (isNum(p.threshold) ? num(p.threshold) : null);
    const tier = p.tier ? `${p.tier}客户` : '客户';
    return `${tier}已 ${num(p.daysSinceVisit)} 天未拜访${win != null ? `（阈值 ${win} 天）` : ''}`;
  },
  lost_contact: (p) => (isNum(p.daysSinceVisit) ? `已 ${num(p.daysSinceVisit)} 天无任何拜访，存在流失风险` : null),
  deal_stuck: (p) => (isNum(p.stuckDays) ? `商机已停滞 ${num(p.stuckDays)} 天${isNum(p.threshold) ? `（阈值 ${num(p.threshold)} 天）` : ''}` : null),
  lead_overdue: (p) => (isNum(p.overdueDays) ? `线索已逾期 ${num(p.overdueDays)} 天${isNum(p.threshold) ? `（阈值 ${num(p.threshold)} 天）` : ''}` : null),
  named_visit_overdue: (p) => {
    if (!isNum(p.overdueDays)) return null;
    const owner = p.named_owner ? `，责任人 ${p.named_owner}` : '';
    return `窗口内应访未达标，已逾期 ${num(p.overdueDays)} 天${owner}`;
  },
  commit_red: (p) => {
    if (!isNum(p.commitRate)) return null;
    const low = isNum(p.yellow_low) ? num(p.yellow_low) : (isNum(p.threshold) ? num(p.threshold) : null);
    return `承诺兑现率 ${Math.round(num(p.commitRate) * 100)}%${low != null ? `，低于警戒线 ${Math.round(low * 100)}%` : ''}`;
  },
  funnel_unhealthy: (p) => {
    if (!isNum(p.salesPotential)) return null;
    const min = isNum(p.health_min) ? num(p.health_min) : (isNum(p.threshold) ? num(p.threshold) : null);
    return `销售潜力 ${Math.round(num(p.salesPotential) * 100)}%${min != null ? `，低于健康线 ${Math.round(min * 100)}%` : ''}`;
  },
  funnel_jitter: (p) => {
    if (!isNum(p.jitterRate)) return null;
    const max = isNum(p.jitter_max) ? num(p.jitter_max) : (isNum(p.threshold) ? num(p.threshold) : null);
    return `漏斗抖动率 ${Math.round(num(p.jitterRate) * 100)}%${max != null ? `，超过上限 ${Math.round(max * 100)}%` : ''}`;
  },
  forecast_breach: (p) => (isNum(p.ratio)
    ? `预测兑现比例 ${Math.round(num(p.ratio) * 100)}%${isNum(p.threshold) ? `，低于阈值 ${Math.round(num(p.threshold) * 100)}%` : ''}`
    : null),
  payment_due: (p) => (isNum(p.dueDays) ? `距到期 ${num(p.dueDays)} 天${isNum(p.threshold) ? `（阈值 ${num(p.threshold)} 天）` : ''}` : null),
  payment_due_plan: (p) => (isNum(p.dueDays) ? `回款计划距到期 ${num(p.dueDays)} 天${isNum(p.threshold) ? `（阈值 ${num(p.threshold)} 天）` : ''}` : null),
  s0_stale: (p) => (isNum(p.ageDays) ? `公海 S0 已 ${num(p.ageDays)} 天未认领` : null),
  s0p_recycle_warn: (p) => (isNum(p.followAgeDays) ? `已跟进 ${num(p.followAgeDays)} 天，临近回收（T-3）` : null),
  candidate_touch_window: (p) => (isNum(p.ageDays) ? `候选池已 ${num(p.ageDays)} 天未触达` : null),
};

// 可读摘要：专用摘要 → payload.subject（不含原始 kind 才算可读）→ 通用字段渲染 → 诚实占位
// 末位兜底刻意返回「暂无明细」而非 kind 名：无明细就是无明细，不拿类型名冒充摘要（禁假绿）。
export function summarizeSignal(sig) {
  const p = (sig && sig.payload) || {};
  const kind = String(sig?.kind ?? '');
  const fn = SUMMARIZERS[kind];
  if (fn) {
    const s = fn(p);
    if (s) return s;
  }
  const subject = typeof p.subject === 'string' ? p.subject.trim() : '';
  // 「s0_stale 预警」这类把原始码当人话的 subject 不算可读 → 继续走通用渲染
  if (subject && !(kind && subject.includes(kind))) return subject;
  const parts = Object.entries(p)
    .filter(([k, v]) => FIELD_LABELS[k] && v != null && v !== '')
    .map(([k, v]) => `${FIELD_LABELS[k]} ${fmtValue(k, v)}`);
  if (parts.length) return parts.join(' · ');
  return '暂无明细';
}

// 对象列：粒子锚点 → payload 内实体键 → 「全量」（不拿「—」交白卷）
const REF_KEYS = ['account_id', 'deal', 'deal_id', 'lead', 'lead_id', 'external_id'];
export function scopeRef(sig) {
  const p = (sig && sig.payload) || {};
  const direct = sig?.particle_id || null;
  if (direct) return String(direct);
  for (const k of REF_KEYS) if (p[k]) return String(p[k]);
  return null;
}

export function scopeLabel(sig) {
  const ref = scopeRef(sig);
  if (!ref) return '全量';
  return ref.length > 12 ? `${ref.slice(0, 8)}…` : ref;
}

export function scopeTitle(sig) {
  const ref = scopeRef(sig);
  return ref
    ? `对象 ${ref}`
    : '该信号针对整体范围（全部客户/商机），非单个对象';
}

// 类型列 title：中文名 + 原始码，保证可读的同时可对日志/可溯源
export function kindTitle(kind) {
  const k = String(kind ?? '').trim();
  if (!k) return '';
  const label = SIGNAL_KIND_LABELS[k];
  return label ? `${label}（${k}）` : k;
}
