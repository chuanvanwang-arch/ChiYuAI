// test/sales/gateThresholdDelta.test.js — T4 门控阈值回归（P3→P4 拦截率统计）
// 红灯先行：本文件在 src/sales/gateThresholdDelta.js 实现前应先跑红（断言失败）。
// 纪律：禁止改期望迁就实现；delta>0.2 仅输出建议 0.5、不自动改配置。
import { describe, it, expect } from 'vitest';
import {
  scoreBantcc5, scoreBantcc6, interceptRate, computeDelta, recommendBantccThreshold,
} from '../../src/sales/gateThresholdDelta.js';

// —— 固定样本：覆盖「边界翻转」场景（旧 0.6 放行、新 0.5 拦截）——
// 旧五维：C = 竞争∨内线；新六维：C1=竞争、C2=内线（分母 6，旧数据无 C1/C2 且无 legacyC 时记 0）
const SAMPLE = [
  // 全齐：before=1.0 after=1.0 均放行
  { bantcc: { b: 1, a: 1, n: 1, t: 1, c1: 1, c2: 1 }, competition: 'x', coach: 'y', expected_amount: 10, authority: 'dm', needs: { product: 'p' }, expected_close_date: '2026-12' },
  // 缺 T、竞争+内线都在：before=(4)/5=0.8 放行；after=(B/A/N/C1/C2=1)/6=5/6≈0.833 放行
  { bantcc: { b: 1, a: 1, n: 1 }, competition: 'x', coach: 'y' },
  // 缺 T、缺竞争缺内线：before=(3)/5=0.6 放行(边界)；after=3/6=0.5 拦截 ← 翻转
  { bantcc: { b: 1, a: 1, n: 1 } },
  // 缺 B：before=4/5=0.8 放行；after=4/6≈0.667 放行
  { bantcc: { a: 1, n: 1, t: 1, c1: 1, c2: 1 }, coach: 'y' },
  // 缺 A 缺 N（但 T/竞争/内线在）：before=(B/T/C)/5=3/5=0.6 放行；after=3/6=0.5 拦截 ← 翻转
  { bantcc: { b: 1, t: 1 }, competition: 'x', coach: 'y' },
  // 全缺：before=0 after=0 均拦截
  {},
  // 旧数据迁移回退：仅 bantcc.c=1（无 C1/C2）→ C1=C2=1，分母 6 但分子同步+2；T 缺
  //   before=(B/A/N/C)/5 = 4/5=0.8 放行；after=(B/A/N/C1/C2)/6 = 5/6≈0.833 放行（迁移不拉低）
  { bantcc: { b: 1, a: 1, n: 1, c: 1 } },
  // 仅 B/A 在、T 与 C 全缺：before=2/5=0.4 拦截；after=2/6≈0.333 拦截（两口径都拦，无翻转）
  { bantcc: { b: 1, a: 1 } },
];

describe('T4 · 门控阈值回归（P3→P4 拦截率）', () => {
  // T4-C1：拦截率统计脚本可重复执行，输出 {before, after, delta} 结构
  it('【T4-C1】全量商机样本 → 输出 {before, after, delta} 且可重复执行', () => {
    const r1 = computeDelta(SAMPLE, { pass: 0.6 });
    const r2 = computeDelta(SAMPLE, { pass: 0.6 });
    expect(r1).toEqual(r2); // 可重复执行：两次结果全等
    expect(r1).toHaveProperty('before');
    expect(r1).toHaveProperty('after');
    expect(r1).toHaveProperty('delta');
    expect(typeof r1.before).toBe('number');
    expect(typeof r1.after).toBe('number');
    expect(typeof r1.delta).toBe('number');
    expect(r1.delta).toBeGreaterThanOrEqual(0); // delta 取绝对值
    // 样本含翻转场景，after 拦截率应高于 before
    expect(r1.after).toBeGreaterThan(r1.before);
  });

  // T4-C2：delta ≤ 20% → 阈值保持 0.6（不回调）
  it('【T4-C2】delta 0.15 ≤ 20% → 阈值保持 0.6（不回调）', () => {
    const r = recommendBantccThreshold(0.15, 0.6);
    expect(r.change).toBe(false);
    expect(r.threshold).toBe(0.6);
    expect(r.action).toBe('keep');
  });

  // T4-C3：delta > 20% → 输出建议阈值 0.5（不自动改，需人工确认）
  it('【T4-C3】delta 0.25 > 20% → 输出建议阈值 0.5（不自动改）', () => {
    const r = recommendBantccThreshold(0.25, 0.6);
    expect(r.change).toBe(true);
    expect(r.suggested).toBe(0.5);
    expect(r.action).toBe('suggest');
    // 关键：函数本身绝不写配置，只返回建议
    expect(r.note).toMatch(/不自动改|人工确认/);
  });

  // 边界：delta 恰为 0.20 视为 ≤20%，保持 0.6
  it('【T4-C2】delta 0.20 边界仍保持 0.6', () => {
    const r = recommendBantccThreshold(0.2, 0.6);
    expect(r.change).toBe(false);
    expect(r.threshold).toBe(0.6);
  });

  // scoreBantcc5 / scoreBantcc6 单口径正确性（保障 computeDelta 可信）
  it('【T4-C1】scoreBantcc5 旧五维与 scoreBantcc6 新六维口径分离', () => {
    const deal = SAMPLE[2]; // 缺 T、缺竞争缺内线
    expect(scoreBantcc5(deal)).toBeCloseTo(3 / 5, 5); // 0.6
    expect(scoreBantcc6(deal)).toBeCloseTo(3 / 6, 5); // 0.5
    const full = SAMPLE[0];
    expect(scoreBantcc5(full)).toBe(1);
    expect(scoreBantcc6(full)).toBe(1);
  });

  it('【T4-C1】interceptRate 按 pass 阈值统计拦截占比', () => {
    const before = interceptRate(SAMPLE, scoreBantcc5, 0.6);
    const after = interceptRate(SAMPLE, scoreBantcc6, 0.6);
    expect(before).toBeGreaterThanOrEqual(0);
    expect(before).toBeLessThanOrEqual(1);
    expect(after).toBeGreaterThan(before); // 样本含翻转，after 更高
  });
});
