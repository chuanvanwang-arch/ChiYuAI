// src/sales/visitNote.js — visit_notes 单项字段读取的唯一入口（字段名兼容层）
// TAORAN-A 达成分档阈值走 config_store['sales-thresholds']（id32），不硬编码
import { readThreshold, DEFAULT_THRESHOLDS } from './salesThresholds.js';
// 背景：visit_notes 存在两套历史写法——
//   新写法：objective / result / next / type / achieved / appointment / customer_type
//   旧写法：t_objective / t_result / t_next / t_type / t_achieved / t_appointment
// 2026-08-30 两次回归均因「改字段名只改了部分消费方」而起：
//   第一次漏 behaviorChecklist.js（21 条 6 项恒 false）
//   第二次漏 evaluator.js（sales_visit_value 恒 false → S2→S3 阶段门控误拦）
// 铁律：任何消费方必须走 pickNote()，禁止直读 t_*；新增字段时同步加进 KNOWN_KEYS。

// 支持兼容读取的字段清单（新增 TAORAN 要素时必须登记，否则兼容失效）
const KNOWN_KEYS = [
  'type',           // 拜访类型：visit | call（L1 电话量统计依赖）
  'customer_type',  // TAORAN-T：客户类型（opportunity/target/potential），写入时从账户 tier 同步
  'appointment',    // TAORAN-A：是否预约
  'objective',      // TAORAN-O：拜访目的
  'result',         // TAORAN-R：结果事实
  'achieved',       // TAORAN-A：达到 | 部分达到 | 未达到
  'next',           // TAORAN-N：下一步安排
  // 非 TAORAN 的既有扩展字段（历史数据为新写法，无 t_ 版本，登记仅为统一入口）
  'prepare', 'review', 'new_contact', 'collaboration',
];

/**
 * 读取 visit_notes 单项字段，新写法优先、旧写法回退。
 * @param {object} note - visit_notes 数组的单项（可为 null/undefined）
 * @param {string} key  - 新写法字段名（须在 KNOWN_KEYS 内）
 * @returns {*} 字段值；两者皆缺时返回 undefined
 */
export function pickNote(note, key) {
  if (!note || typeof note !== 'object') return undefined;
  if (!KNOWN_KEYS.includes(key)) {
    // 未登记字段：按新写法直读（不做 t_ 回退），避免未知键被静默改写语义
    return note[key];
  }
  const v = note[key];
  // 仅当新写法「真正缺失」时才回退；'' / 0 / false 属于有效值，不回退
  return (v !== undefined && v !== null) ? v : note[`t_${key}`];
}

/** 兼容字段清单（供测试与文档核对） */
export const NOTE_KEYS = KNOWN_KEYS.slice();

/**
 * TAORAN-A 达成比例分档（数值 → 三档）。
 * 阈值走配置（config_store['sales-thresholds'].taoran）：
 *   ratio ≥ achieved_ratio（默认 80）→ '达到'
 *   ratio < unachieved_ratio（默认 20）→ '未达到'
 *   其余 → '部分达到'（含 unachieved ≤ ratio < achieved）
 * 原则（用户 2026-08-30）：分界比例不硬编码，客户可后台调整。
 * @param {number} ratio - 达成比例（0-100）
 * @param {object} [thresholds] - 合并后阈值；缺省回退默认
 * @returns {'达到'|'部分达到'|'未达到'}
 */
export function classifyTaoranAchieved(ratio, thresholds) {
  const r = Number(ratio);
  const achieved = thresholds
    ? readThreshold(thresholds, 'taoran.achieved_ratio', 80)
    : DEFAULT_THRESHOLDS.taoran?.achieved_ratio ?? 80;
  const unachieved = thresholds
    ? readThreshold(thresholds, 'taoran.unachieved_ratio', 20)
    : DEFAULT_THRESHOLDS.taoran?.unachieved_ratio ?? 20;
  if (r >= achieved) return '达到';
  if (r < unachieved) return '未达到';
  return '部分达到';
}

/** 批量读取：一次取出多个字段，返回新写法键名的对象 */
export function pickNotes(note, keys = []) {
  const out = {};
  for (const k of keys) out[k] = pickNote(note, k);
  return out;
}
