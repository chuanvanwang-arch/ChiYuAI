// src/sales/behaviorChecklist.js — 21 条行为标准合格线（可执行事实源）
// 设计输入：skills/method-behavior-standard/methodology.json + core/checklist.md
// 原则：21 条是合格线（有/无判定），不设评分阈值；判定必须有可观察证据
// 输出：{ pass, total:21, gaps:[], items:{ '01-01': true, ... } }

import { pickNote } from './visitNote.js';
import { readThreshold, deriveRhythmDays, DEFAULT_THRESHOLDS } from './salesThresholds.js';

const nowMs = () => Date.now();

function lastNote(p) {
  const notes = Array.isArray(p.visit_notes) ? p.visit_notes : [];
  if (!notes.length) return null;
  return notes[notes.length - 1] || null;
}

function daysAgo(t, days) {
  return t >= (nowMs() - days * 86400000);
}

function hasRecentVisit(p, days) {
  const notes = Array.isArray(p.visit_notes) ? p.visit_notes : [];
  return notes.some(n => n?.at && daysAgo(new Date(n.at).getTime(), days));
}

function bestBantcc(deals = [], unknownFallback = 0) {
  if (!deals.length) return unknownFallback;
  const vals = deals.map(d => {
    const ai = d?.payload?.ai || {};
    const v = ai.bantcc_completeness;
    return typeof v === 'object' ? Number(v.value ?? unknownFallback) : Number(v ?? unknownFallback);
  });
  return Math.max(...vals);
}

/**
 * 21 条行为标准合格线判定（纯函数，零 DB）。
 * 所有业务阈值一律经 readThreshold 从配置读取——禁止在本文件内写死数值。
 * @param {object} [thresholds] - 判定阈值（config_store['sales-thresholds']，缺省回退 DEFAULT_THRESHOLDS）
 * @param {object} [targetsCfg] - id30 客户目标配置；接触窗口天数由其 window_days 派生（消除双源漂移）
 */
export function evaluateBehaviorChecklist(
  accountPayload = {},
  deals = [],
  contacts = [],
  thresholds = DEFAULT_THRESHOLDS,
  targetsCfg = {},
) {
  const p = accountPayload;
  const seg = p.account_segment || 'potential';
  const last = lastNote(p) || {};
  const notes = Array.isArray(p.visit_notes) ? p.visit_notes : [];
  // 所有业务阈值一律经 readThreshold 读取，禁止在此文件内写死数值（用户 2026-08-30 原则）
  const T = {
    bantccPass: readThreshold(thresholds, 'bantcc.pass'),
    bantccUnknown: readThreshold(thresholds, 'bantcc.unknown'),
    minCustomerTypes: readThreshold(thresholds, 'behavior.min_customer_types'),
    minContacts: readThreshold(thresholds, 'behavior.min_contacts'),
    recentVisitDays: readThreshold(thresholds, 'behavior.recent_visit_days'),
  };
  // 接触窗口天数从 id30 window_days 派生（quarter→潜力、month→目标），未配时回退 90/30
  const rhythm = deriveRhythmDays(targetsCfg, thresholds);
  // 02-01「拜访所有客户」：统计拜访过的**客户类型**种数（TAORAN-T）。
  // 注意与 `type` 区分：type = 拜访方式（visit/call，供 L1 电话量统计），
  // customer_type = 客户类型（opportunity/target/potential，供 TAORAN 与覆盖率判定）。
  // 2026-08-30 修正：此前误读 type 导致「拜访方式」被当成「客户类型」计数。
  const uniqueSegments = new Set(notes.map(n => pickNote(n, 'customer_type')).filter(Boolean));

  const items = {
    // BH-01 聪明勤奋
    '01-01': notes.some(n => n?.at && daysAgo(new Date(n.at).getTime(), T.recentVisitDays)),
    '01-02': Boolean(pickNote(last, 'objective') && String(pickNote(last, 'objective')).length > 4 && !String(pickNote(last, 'objective')).includes('维护关系')),
    '01-03': Boolean(pickNote(last, 'prepare') && String(pickNote(last, 'prepare')).length > 0),
    // BH-02 双管齐下
    '02-01': uniqueSegments.size >= T.minCustomerTypes,
    '02-02': Boolean((p.needs || p.pain_points) ? deals.length > 0 : true),
    // BH-03 知己知彼
    '03-01': bestBantcc(deals, T.bantccUnknown) >= T.bantccPass,
    '03-02': Boolean(p.needs?.pain || p.pain_points || (Array.isArray(p.pain_points) ? p.pain_points.length : false)),
    '03-03': !(pickNote(last, 'achieved') === '未达到' && !pickNote(last, 'next')),
    '03-04': Boolean(pickNote(last, 'prepare') && String(pickNote(last, 'prepare')).length > 0),
    // BH-04 充满信心
    '04-01': contacts.some(c => Boolean(c.payload?.business_title || c.business_title)),
    '04-02': contacts.length >= T.minContacts || Boolean(pickNote(last, 'new_contact')),
    '04-03': Boolean(pickNote(last, 'next') && String(pickNote(last, 'next')).length > 0),
    // BH-05 着眼未来
    '05-01': Boolean(seg && seg !== 'potential'),
    '05-02': seg === 'potential' ? hasRecentVisit(p, rhythm.potential_days) : true,
    '05-03': seg === 'target' ? hasRecentVisit(p, rhythm.target_days) : true,
    // BH-06 善用资源
    '06-01': deals.every(d => !d.payload?.hidden),
    '06-02': deals.some(d => Boolean(d.payload?.win_strategy)),
    '06-03': deals.some(d => Boolean(d.payload?.team?.length)) || Boolean(pickNote(last, 'collaboration')),
    '06-04': deals.some(d => d.payload?.stage === 'closed_lost' && Boolean(d.payload?.review)),
    // BH-07 依照套路
    '07-01': (() => {
      const v = p.ai?.sales_visit_value;
      return typeof v === 'object' ? Boolean(v.value) : Boolean(v);
    })(),
    '07-02': Boolean(pickNote(last, 'review') && String(pickNote(last, 'review')).length > 0),
  };

  const gaps = [];
  const standardLabels = {
    '01-01': 'BH-01 时间安排饱满', '01-02': 'BH-01 目的明确', '01-03': 'BH-01 工作计划完善',
    '02-01': 'BH-02 拜访所有客户', '02-02': 'BH-02 珍惜项目机会',
    '03-01': 'BH-03 BANTCC', '03-02': 'BH-03 关注需求', '03-03': 'BH-03 不做无效拜访', '03-04': 'BH-03 访前准备',
    '04-01': 'BH-04 理解关系作用', '04-02': 'BH-04 积极发展', '04-03': 'BH-04 主动管理',
    '05-01': 'BH-05 科学分类', '05-02': 'BH-05 接触潜力', '05-03': 'BH-05 关注目标',
    '06-01': 'BH-06 看到所有商机', '06-02': 'BH-06 识别致胜关键', '06-03': 'BH-06 寻求团队', '06-04': 'BH-06 正确看待输赢',
    '07-01': 'BH-07 按照标准做事', '07-02': 'BH-07 及时总结反省',
  };

  for (const [k, ok] of Object.entries(items)) {
    if (!ok) gaps.push(standardLabels[k] || k);
  }

  const pass = Object.values(items).filter(Boolean).length;
  return { pass, total: 21, gaps, items };
}
