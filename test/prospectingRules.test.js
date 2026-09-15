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

describe('hiring 岗位层级下钻（P1-2）', () => {
  const rules = {
    ...DEFAULT_PROSPECTING_RULES,
    signals: { hiring: 0.7 },   // 分母恒 0.7 → 断言与层级自洽
    signal_age_tiers: [],
    hiring_role_tiers: { icp_key: ['VP', '总监', 'Director'], mid: ['经理', 'Manager'], jun: ['专员', '工程师'] },
    hiring_role_weight: { icp_key: 1.0, mid: 0.6, jun: 0.3 },
  };
  it('① VP 级招聘权重足额，junior 降档', () => {
    const s1 = computeFitScore({ signals: { hiring: true }, hiring_role: 'VP' }, rules);
    const s2 = computeFitScore({ signals: { hiring: true }, hiring_role: '专员' }, rules);
    expect(s1).toBeGreaterThan(s2);
    expect(s1).toBeCloseTo(1.0, 5);   // 0.7×1.0/0.7
    expect(s2).toBeCloseTo(0.3, 5);   // 0.7×0.3/0.7
  });
  it('② mid 层级按 0.6 档', () => {
    const s = computeFitScore({ signals: { hiring: true }, hiring_role: '经理' }, rules);
    expect(s).toBeCloseTo(0.6, 5);
  });
  it('③ 无层级词 → 默认 1.0（向后兼容，fail-open）', () => {
    const s = computeFitScore({ signals: { hiring: true }, hiring_role: 'CTO' }, rules);
    expect(s).toBeCloseTo(1.0, 5);
  });
  it('④ 无 hiring_role 字段 → 默认 1.0（fail-open，源未返回职位）', () => {
    const s = computeFitScore({ signals: { hiring: true } }, rules);
    expect(s).toBeCloseTo(1.0, 5);
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

describe('hiring 岗位层级 → computeFitScore 联动（P1-2 端到端）', () => {
  // hiring_role 由 qixin 适配器 mapSearchResult 附加（fail-open），computeFitScore 消费层级权重
  // 直接 import 纯函数验证映射 + 评分联动（qixin.js 为并行会话新文件，保持 untracked，用例归本文件）
  it('① 源返回招聘岗位 → hiring_role 附加 + VP 足额评分', async () => {
    const { mapSearchResult } = await import('../src/connectors/discovery/adapters/qixin.js');
    const r = mapSearchResult({ name: 'S 集团', hiring_icp_role: '招聘VP' });
    expect(r.hiring_role).toBe('招聘VP');
    const rules = { ...DEFAULT_PROSPECTING_RULES, signals: { hiring: 0.7 }, signal_age_tiers: [],
                    hiring_role_tiers: { icp_key: ['VP', '总监'], mid: ['经理'], jun: ['专员', '工程师'] },
                    hiring_role_weight: { icp_key: 1.0, mid: 0.6, jun: 0.3 } };
    expect(computeFitScore({ signals: { hiring: true }, hiring_role: r.hiring_role }, rules)).toBeCloseTo(1.0, 5);
  });
  it('② 源无招聘信息 → 无 hiring_role（fail-open，评分默认 1.0）', async () => {
    const { mapSearchResult } = await import('../src/connectors/discovery/adapters/qixin.js');
    const r = mapSearchResult({ name: 'B 公司' });
    expect('hiring_role' in r).toBe(false);
  });
});
