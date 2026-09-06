// src/calibration/constants.js — 校准层常量单一事实源
// REPLAY_K：先例检索条数，与 autonomyEngine.js:66 的 `opts.k || 5` 对齐。
//   技术债：k 未落库，重放端只能取常量。若运行端未来传入自定义 k，须同步落库或配置化，否则重放失真。
export const REPLAY_K = 5;
export const MIN_SAMPLE = 20;      // 最小样本闸门（R6）
export const FATIGUE_HOURS = 24;   // 升级件超过此时长无人处置 = 升级疲劳
export const CONF_FLOOR = 0.5;     // 有效阈值下限，与 autonomyEngine.js:84 的 Math.max(..., 0.5) 对齐
export const REL_BOOST = 0.3;      // 强关系单项加成
export const REL_THRESHOLD_RELAX = 0.1;
export const CONF_CAP = 0.95;