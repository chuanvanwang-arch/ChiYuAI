import { describe, it, expect } from 'vitest';
import {
  computeIntentScore, computeIcpFit, scoreLeadFit,
  LEAD_FIT_FIT_RULE, LEAD_FIT_INTENT_RULE,
} from '../../../src/connectors/discovery/leadFitScorer.js';

// 与 config/discoveryRules.js:32-40 同形的权重表（键为**全称**——陷阱②）
const RULES = {
  signals: {
    funding_round: { weight: 0.9 }, hiring_icp_role: { weight: 0.7 }, tender_match: { weight: 0.8 },
    leadership_change: { weight: 0.5 }, tech_adopt: { weight: 0.6 },
    website_redesign: { weight: 0.3 }, social_content: { weight: 0.4 },
  },
  signal_time_fields: { funding_round: 'funding_ts', hiring_icp_role: 'hiring_ts' },
  signal_age_tiers: [
    { max_days: 7, multiplier: 1.0 }, { max_days: 30, multiplier: 0.6 },
    { max_days: 90, multiplier: 0.3 }, { max_days: null, multiplier: 0.1 },
  ],
  icp: { industries: ['industrial_coatings', 'chemical'], min_headcount: 50, geo: ['CN'] },
};

describe('computeIntentScore（信号加权 × 时间衰减）', () => {
  it('① 全命中且满分 → 1.0', () => {
    const now = Date.parse('2026-09-16T00:00:00Z');
    const sigs = Object.keys(RULES.signals).map((t) => ({ type: t, ts: '2026-09-15T00:00:00Z' }));
    const r = computeIntentScore(sigs, RULES, now);
    expect(r.value).toBeCloseTo(1.0, 4);
    expect(r.denominator).toBeCloseTo(0.9 + 0.7 + 0.8 + 0.5 + 0.6 + 0.3 + 0.4, 4);
  });

  it('② 零信号 → 0（不是 0.5！占位值与真实值的区分断言）', () => {
    expect(computeIntentScore([], RULES).value).toBe(0);
  });

  it('③ 单信号命中 → weight/sum(weights)', () => {
    const now = Date.parse('2026-09-16T00:00:00Z');
    const r = computeIntentScore([{ type: 'funding_round', ts: '2026-09-15T00:00:00Z' }], RULES, now);
    expect(r.value).toBeCloseTo(0.9 / 4.2, 4); // Σ权重 = 4.2
  });

  it('④ 时间衰减生效：20 天前 → 落在 max_days:30 档 ×0.6（freshnessMultiplier 语义：ageDays<=max_days 取首命中档）', () => {
    const now = Date.parse('2026-09-16T00:00:00Z');
    const r = computeIntentScore([{ type: 'funding_round', ts: '2026-08-27T00:00:00Z' }], RULES, now);
    expect(r.value).toBeCloseTo((0.9 * 0.6) / 4.2, 4);
  });

  it('⑤ 无 ts → 不衰减（向后兼容，mult=1.0）', () => {
    const r = computeIntentScore([{ type: 'funding_round' }], RULES);
    expect(r.breakdown.find((b) => b.key === 'funding_round').mult).toBe(1.0);
  });

  it('⑥ signal_time_fields 映射被消费（ts 由映射字段取到）', () => {
    const now = Date.parse('2026-09-16T00:00:00Z');
    const withTs = computeIntentScore([{ type: 'funding_round', funding_ts: '2026-09-15T00:00:00Z' }], RULES, now);
    expect(withTs.breakdown.find((b) => b.key === 'funding_round').mult).toBe(1.0);
    expect(withTs.value).toBeGreaterThan(0);
  });

  // ⚠ 假绿反证：prospecting 的简写键喂进来必须全部未命中（证明「跨域键不通用」）
  it('⑦ 反证：prospecting 简写键({funding:true}) 不命中 discovery 权重表 → 0', () => {
    const r = computeIntentScore([{ type: 'funding' }, { type: 'hiring' }], RULES);
    expect(r.value).toBe(0);
    expect(r.breakdown.every((b) => b.hit === false)).toBe(true);
  });

  it('⑧ 同类型多信号不叠加（首次命中为准）', () => {
    const a = computeIntentScore([{ type: 'funding_round', ts: '2026-09-15T00:00:00Z' }], RULES);
    const b = computeIntentScore([
      { type: 'funding_round', ts: '2026-09-15T00:00:00Z' },
      { type: 'funding_round', ts: '2026-09-15T00:00:00Z' },
    ], RULES);
    expect(b.value).toBeCloseTo(a.value, 6);
  });
});

describe('computeIcpFit（行业/规模/地域三维）', () => {
  it('① 三维全中 → 1.0', () => {
    const acct = { payload: { enrichment: {
      industry: { value: 'chemical', provider: 'gaode' },
      headcount: { value: 120, provider: 'gaode' },
      country: { value: 'CN', provider: 'gaode' },
    } } };
    const r = computeIcpFit(acct, RULES);
    expect(r.value).toBeCloseTo(1.0, 4);
    expect(r.degraded).toBe(false);
  });

  it('② 行业不匹配 → 1/3', () => {
    const acct = { payload: { enrichment: {
      industry: { value: 'retail' }, headcount: { value: 120 }, country: { value: 'CN' },
    } } };
    // 三维：行业未命中、规模命中(120>=50)、地域命中(CN∈geo) → 可判定 3 维命中 2 → 2/3
    expect(computeIcpFit(acct, RULES).value).toBeCloseTo(2 / 3, 4);
  });

  it('③ 缺全部维 → 0 且 degraded=true（**不假填充**，不是 0.5）', () => {
    const r = computeIcpFit({ payload: {} }, RULES);
    expect(r.value).toBe(0);
    expect(r.degraded).toBe(true);
    expect(r.unjudged).toEqual(['industry', 'headcount', 'geo']);
  });

  it('④ 部分缺维：分母只计「可判定维」（不把未知算作未命中）', () => {
    const acct = { payload: { enrichment: { industry: { value: 'chemical' } } } }; // 只有行业
    const r = computeIcpFit(acct, RULES);
    expect(r.value).toBeCloseTo(1.0, 4);   // 可判定维=1，命中=1
    expect(r.degraded).toBe(true);          // 但标记降级（缺 2 维）
  });

  it('⑤ 兼容顶层字段（未经 enrichment 包装）', () => {
    const acct = { payload: { industry: 'chemical', headcount: 80, country: 'CN' } };
    expect(computeIcpFit(acct, RULES).value).toBeCloseTo(1.0, 4);
  });
});

describe('scoreLeadFit 统一入口', () => {
  it('返回设计 §5 要求的双维 + ruleRefs + 可解释 breakdown', () => {
    const out = scoreLeadFit({
      account: { payload: { enrichment: { industry: { value: 'chemical' } } } },
      signals: [{ type: 'funding_round', ts: new Date().toISOString() }],
      rules: RULES,
    });
    expect(out.ruleRefs.fit).toBe(LEAD_FIT_FIT_RULE);
    expect(out.ruleRefs.intent).toBe(LEAD_FIT_INTENT_RULE);
    expect(out.icp_fit).toBeGreaterThan(0);
    expect(out.intent).toBeGreaterThan(0);
    expect(out.breakdown.intent.length).toBe(7);       // 每个权重键一条可解释记录
    expect(typeof out.degraded.icp).toBe('boolean');
  });

  it('空 rules → 不抛错、不假填充（value 0 + degraded）', () => {
    const out = scoreLeadFit({ account: {}, signals: [], rules: {} });
    expect(out.icp_fit).toBe(0);
    expect(out.intent).toBe(0);
    expect(out.degraded.intent).toBe(true);
  });
});

describe('语义边界（陷阱①：不得复用 rubricScorer 的 9 维）', () => {
  it('本模块导出的 ruleRef 是信号规则，**不含** clarity/accuracy 等叙述维度', () => {
    for (const ref of [LEAD_FIT_FIT_RULE, LEAD_FIT_INTENT_RULE]) {
      expect(ref.startsWith('scenario:lead-fit#ruler:')).toBe(true);
      expect(['clarity', 'accuracy', 'precision', 'relevance', 'depth', 'breadth', 'logic', 'importance', 'fairness']
        .some((k) => ref.includes(k))).toBe(false);
    }
  });
});
