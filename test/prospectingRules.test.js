// test/prospectingRules.test.js — 拓客双层配置（T3）
// 设计输入：docs/2026-09-14-prospecting-module-design.md §3
// 对齐 discoveryRules.js 范式：出厂默认 + 租户覆盖（sources 以 id 为键覆盖，不增删）
// + config_store ⊕ fail-open + fit_score 服务端计算（修订 2）
import { describe, it, expect } from 'vitest';
import { DEFAULT_PROSPECTING_RULES, mergeProspectingRules, mergedProspectingRules, computeFitScore } from '../src/config/prospectingRules.js';

describe('prospecting-rules 双层配置（T3）', () => {
  it('① 出厂默认：付费源全关、阈值合理', () => {
    expect(DEFAULT_PROSPECTING_RULES.sources.qixin.enabled).toBe(false);
    expect(DEFAULT_PROSPECTING_RULES.sources.xinbang.enabled).toBe(false);
    expect(DEFAULT_PROSPECTING_RULES.icp.min_headcount).toBe(50);
    expect(DEFAULT_PROSPECTING_RULES.candidate_limit).toBe(50);
    expect(DEFAULT_PROSPECTING_RULES.fit_threshold).toBe(0.6);
  });
  it('② merge：租户覆盖 icp/signals，sources 只覆盖既有 id', () => {
    const merged = mergeProspectingRules(DEFAULT_PROSPECTING_RULES, {
      icp: { industries: ['healthcare'] },
      sources: { qixin: { enabled: true, weight: 0.8 }, evil: { enabled: true } }, // evil 未在出厂 → 忽略
    });
    expect(merged.icp.industries).toEqual(['healthcare']);
    expect(merged.sources.qixin.enabled).toBe(true);
    expect(merged.sources.evil).toBeUndefined();          // 防租户越权新增付费源
    expect(Object.keys(merged.sources)).toEqual(Object.keys(DEFAULT_PROSPECTING_RULES.sources));
  });
  it('③ mergedProspectingRules：config_store 覆盖 ⊕ fail-open', async () => {
    const r = await mergedProspectingRules({ tenantId: 'acme' }, { readConfig: async () => ({ value: { icp: { min_headcount: 100 } } }) });
    expect(r.icp.min_headcount).toBe(100);
    const fail = await mergedProspectingRules({ tenantId: 'acme' }, { readConfig: async () => { throw new Error('db down'); } });
    expect(fail.icp.min_headcount).toBe(50);              // fail-open 回退出厂
  });
  it('④ fit_score 仅服务端计算：适配器注入的 fit_score 被忽略', () => {
    // 候选带 fit_score（恶意/错误注入）→ computeFitScore 只看 signals 字段（修订 2）
    const c = { name: 'X', signals: { hiring: true, funding: true }, fit_score: 0.99 };
    const rules = { ...DEFAULT_PROSPECTING_RULES, signals: { hiring: 0.7, funding: 0.9 } };
    const s = computeFitScore(c, rules);
    expect(s).toBeCloseTo(1.0);   // (0.7+0.9)/(0.7+0.9) = 1.0（无视注入的 0.99）
  });
  it('⑤ computeFitScore 部分信号：未命中按 0 计', () => {
    const c = { name: 'X', signals: { hiring: true } };   // 只命中 hiring
    const rules = { ...DEFAULT_PROSPECTING_RULES, signals: { hiring: 0.7, funding: 0.9 } };
    const s = computeFitScore(c, rules);
    expect(s).toBeCloseTo(0.7 / 1.6);   // 0.4375
  });
});

describe('computeFitScore 时间衰减（P0-1b）', () => {
  const tiers = [
    { max_days: 7, multiplier: 1.0 },
    { max_days: 30, multiplier: 0.6 },
    { max_days: 90, multiplier: 0.3 },
    { max_days: null, multiplier: 0.1 },
  ];
  const DAY = 86400000;
  // 显式限定 signals 只有 funding → 分母恒 0.9 → 断言与衰减档自洽
  const rules = { ...DEFAULT_PROSPECTING_RULES, signals: { funding: 0.9 }, signal_age_tiers: tiers };

  it('① 新鲜信号权重足额', () => {
    const c = { name: 'X', signals: { funding: true, funding_ts: Date.now() - 2 * DAY } };
    // 0.9 × 1.0 / 0.9 = 1.0
    expect(computeFitScore(c, rules)).toBeCloseTo(1.0, 5);
  });
  it('② 陈旧信号按档衰减', () => {
    const c = { name: 'X', signals: { funding: true, funding_ts: Date.now() - 100 * DAY } };
    // 0.9 × 0.1 / 0.9 = 0.1
    expect(computeFitScore(c, rules)).toBeCloseTo(0.1, 5);
  });
  it('③ 无时间戳 → 不衰减（向后兼容）', () => {
    const c = { name: 'X', signals: { funding: true } };
    expect(computeFitScore(c, rules)).toBeCloseTo(1.0, 5);
  });
});
