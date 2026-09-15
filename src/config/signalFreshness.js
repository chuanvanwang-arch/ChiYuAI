// src/config/signalFreshness.js — P0-1a 信号时间衰减（设计 docs/2026-09-15-anysite-borrowing-analysis.md §3 P0-1）
// 案例依据 F6：信号短保质期——24h 内互动 2-5x 回复率；一周后即"事后诸葛"。
// 铁律：
//   ① 纯函数、零 DB、零副作用（单测友好）
//   ② 配置驱动：衰减档来自 config（出厂默认即"向后兼容"——无 ts / 空档均 1.0）
//   ③ 缺 ts（信号无时间戳）→ 不衰减（与旧行为一致，防回归）
export const DEFAULT_AGE_TIERS = Object.freeze([
  { max_days: 7, multiplier: 1.0 },
  { max_days: 30, multiplier: 0.6 },
  { max_days: 90, multiplier: 0.3 },
  { max_days: null, multiplier: 0.1 },
]);

// 纯函数：给定信号年龄（天）→ 衰减系数 [0,1]
//   ageDays 为 null/undefined（无时间戳）→ 1.0（向后兼容）
//   tiers 为空数组 → 1.0（向后兼容）
export function freshnessMultiplier(ageDays, tiers = DEFAULT_AGE_TIERS) {
  if (ageDays === null || ageDays === undefined) return 1.0;
  if (!Array.isArray(tiers) || tiers.length === 0) return 1.0;
  for (const t of tiers) {
    if (t.max_days === null || ageDays <= t.max_days) return t.multiplier ?? 1.0;
  }
  return 1.0;
}

// 纯函数：ts 时间戳 → 天数；无/非法 ts → null（调用方按"无 ts 不衰减"处理）
export function ageDaysOf(ts, now = Date.now()) {
  if (!ts) return null;
  const t = new Date(ts).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now - t) / 86400000));
}
