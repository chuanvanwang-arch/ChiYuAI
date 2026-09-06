// src/web/util.js — 格式化单一来源（根治 SPEC R3：金额/数字 JS 拼接乱序）
// 用法：import { fmtMoney, fmtNum, fmtPct } from '/portal/util.js';
export const fmtMoney = (n, { sign = false } = {}) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  const s = v.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  return (sign && v > 0 ? '+' : '') + '¥' + s; // 单位右置、无空格粘连
};
export const fmtNum = (n, unit = '') => {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString('zh-CN') + (unit ? ' ' + unit : '');
};
export const fmtPct = (n, digits = 1) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return (v * 100).toLocaleString('zh-CN', { maximumFractionDigits: digits }) + '%';
};
