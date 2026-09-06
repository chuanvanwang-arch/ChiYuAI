// test/decision/rubricScorer.test.js
// P1-B3 九尺子评分器单测：纯确定性、无 DB 依赖（mock pool 验证 SQL），避免与并行会话撞库。
import { describe, it, expect } from 'vitest';
import { scoreDecision, persistRubric, RUBRICS } from '../../src/decision/rubricScorer.js';

// 一个八要素齐备的「好决策」上下文
function goodCtx() {
  return {
    intent: { purpose: '拿下 XX 制造产线订单', question: '报多少折扣能赢单且不破价？', sub_questions: ['竞品底价？'] },
    assumptions: [
      { id: 'a1', text: '客户预算 200 万', evidence_ref: ['m1'], risk_if_wrong: '丢单' },
      { id: 'a2', text: '竞品报价 180 万', evidence_ref: ['m2'] },
    ],
    conditions_evaluated: [{ name: '折扣', value: '8 折', unit: '%' }, { name: '账期', value: '30 天' }],
    inference: {
      chain: [
        { evidence: '客户年采购 5 条线', via_assumption: 'a1', conclusion: '单线价值 40 万' },
        { evidence: '竞品 180 万', via_assumption: 'a2', conclusion: '我方 160 万可压制' },
      ],
      conclusion: '报 8 折即 160 万具赢单空间',
    },
    viewpoints: [
      { stance: '我方', holder: '销售', covered: true },
      { stance: '客户', holder: '采购', covered: true },
      { stance: '竞品负面', holder: '市场', covered: true },
    ],
    concept_refs: [{ methodology_id: 'm1', dimension_key: 'price', weight: 2, required: true, hit: true }],
  };
}

describe('九尺子评分器 · 确定性主路径', () => {
  it('八要素齐备 + 故事线有数据 → 9 尺子均有分且 level=good', async () => {
    const r = await scoreDecision(goodCtx(), { storyAvailable: true, evidenceHits: 2, suppliedDims: ['price'], requiredDims: ['price'] });
    expect(Object.keys(r.scores)).toHaveLength(9);
    for (const k of Object.keys(r.scores)) {
      expect(r.scores[k].score).toBeGreaterThanOrEqual(0);
      expect(r.scores[k].score).toBeLessThanOrEqual(4);
    }
    expect(r.level).toBe('good');
    expect(r.llm_used).toBe(false);
    expect(r.degraded).not.toContain('clarity'); // 无模糊词，不降级
  });

  it('空上下文 → 无必填维时 relevance=4（§6.1 设计），其余 0 分，level=poor（不假填充）', async () => {
    const r = await scoreDecision({}, {});
    // 无 required_dims → 相关性按设计满分（不惩罚无必填场景）；其余尺子因缺要素计 0
    expect(r.scores.relevance.score).toBe(4);
    expect(r.scores.clarity.score).toBe(0);
    expect(r.scores.accuracy.score).toBe(0);
    expect(r.scores.depth.score).toBe(0);
    expect(r.scores.breadth.score).toBe(0);
    expect(r.scores.logic.score).toBe(0);
    expect(r.scores.importance.score).toBe(0);
    expect(r.weighted_total).toBe(4); // 仅 relevance 贡献
    expect(r.level).toBe('poor'); // ratio ≈ 0.11
  });

  it('清晰性含模糊词 + LLM 关 → score=2 且 degraded（确定性代理，不假填充）', async () => {
    const ctx = { intent: { question: '大概报多少折扣比较合适？' }, assumptions: [{ text: '可能客户预算有限' }] };
    const r = await scoreDecision(ctx, { llm: 'off' });
    expect(r.scores.clarity.score).toBe(2);
    expect(r.scores.clarity.degraded).toBe(true);
    expect(r.degraded).toContain('clarity');
  });

  it('清晰性含模糊词 + LLM 开且注入 scorer → 走 LLM 评分不降级', async () => {
    const ctx = { intent: { question: '也许报 8 折？' }, assumptions: [{ text: '可能预算 200 万' }] };
    const llmScorer = async () => 3;
    const r = await scoreDecision(ctx, { llm: 'on', llmScorer });
    expect(r.scores.clarity.score).toBe(3);
    expect(r.scores.clarity.degraded).toBe(false);
    expect(r.llm_used).toBe(true);
  });

  it('准确性：故事线空时 degraded=true + 代理分（有引用但无法命中）', async () => {
    const ctx = { assumptions: [{ text: 'x', evidence_ref: ['m1', 'm2'] }] };
    const r = await scoreDecision(ctx, { storyAvailable: false, evidenceHits: 0 });
    expect(r.scores.accuracy.score).toBe(2);
    expect(r.scores.accuracy.degraded).toBe(true);
  });

  it('相关性：required∩supplied 命中率驱动', async () => {
    const r1 = await scoreDecision({}, { requiredDims: ['price', 'risk'], suppliedDims: ['price', 'risk'] });
    expect(r1.scores.relevance.score).toBe(4);
    const r2 = await scoreDecision({}, { requiredDims: ['price', 'risk'], suppliedDims: ['price'] });
    expect(r2.scores.relevance.score).toBe(2); // 1/2
    const r3 = await scoreDecision({}, { requiredDims: ['price', 'risk'], suppliedDims: [] });
    expect(r3.scores.relevance.score).toBe(0);
    const r4 = await scoreDecision({}, { requiredDims: [], suppliedDims: ['price'] });
    expect(r4.scores.relevance.score).toBe(4); // 无必填 → 满分不降级
  });

  it('深度：推论链 ≥2 层且含结论 → 4 分；仅 1 层 → 2 分', async () => {
    const deep = await scoreDecision({ inference: { chain: [{ evidence: 'e', via_assumption: 'a', conclusion: 'c' }, { evidence: 'e2', via_assumption: 'a2', conclusion: 'c2' }], conclusion: 'ok' } });
    expect(deep.scores.depth.score).toBe(4);
    const shallow = await scoreDecision({ inference: { chain: [{ evidence: 'e', via_assumption: 'a', conclusion: 'c' }] } });
    expect(shallow.scores.depth.score).toBe(2);
  });

  it('广度：≥3 立场且含反方 → 4 分；≥2 无反方 → 2 分', async () => {
    const wide = await scoreDecision({ viewpoints: [{ stance: '我方' }, { stance: '客户' }, { stance: '竞品负面' }] });
    expect(wide.scores.breadth.score).toBe(4);
    const two = await scoreDecision({ viewpoints: [{ stance: '我方' }, { stance: '客户' }] });
    expect(two.scores.breadth.score).toBe(2);
  });

  it('逻辑性：每条链同时有 evidence+via_assumption → 4 分', async () => {
    const okLogic = await scoreDecision({ inference: { chain: [{ evidence: 'e', via_assumption: 'a', conclusion: 'c' }] } });
    expect(okLogic.scores.logic.score).toBe(4);
    const bad = await scoreDecision({ inference: { chain: [{ evidence: 'e', conclusion: 'c' }] } });
    expect(bad.scores.logic.score).toBe(2);
  });

  it('重要性：concept_refs 加权命中率驱动', async () => {
    const all = await scoreDecision({ concept_refs: [{ weight: 2, hit: true }, { weight: 1, hit: true }] });
    expect(all.scores.importance.score).toBe(4);
    const half = await scoreDecision({ concept_refs: [{ weight: 2, hit: true }, { weight: 2, hit: false }] });
    expect(half.scores.importance.score).toBe(2); // 0.5
    const none = await scoreDecision({});
    expect(none.scores.importance.score).toBe(0);
  });

  it('公平性：反面先例被消费 → 4 分；仅检索未消费 → 2 分', async () => {
    const consumed = await scoreDecision({}, { negativePrecedentConsumed: true });
    expect(consumed.scores.fairness.score).toBe(4);
    const retrieved = await scoreDecision({}, { negativePrecedentRetrieved: true });
    expect(retrieved.scores.fairness.score).toBe(2);
  });
});

describe('九尺子评分器 · 加权与分级', () => {
  it('焦点尺子 ×1.5 提升 weighted_total 但不豁免非焦点项', async () => {
    const base = await scoreDecision(goodCtx(), { storyAvailable: true, evidenceHits: 2, suppliedDims: ['price'], requiredDims: ['price'] });
    const focused = await scoreDecision(goodCtx(), { storyAvailable: true, evidenceHits: 2, suppliedDims: ['price'], requiredDims: ['price'], focus: ['depth'] });
    expect(focused.weighted_total).toBeGreaterThan(base.weighted_total);
    // 非焦点项仍计入（不归零）
    expect(focused.scores.relevance.score).toBe(base.scores.relevance.score);
  });

  it('【B4 形态归一】requiredDims/focus 支持对象数组形态（decision_scenario 实测 [{dim,on_missing}]/[{key,weight}]）', async () => {
    const r = await scoreDecision(goodCtx(), {
      storyAvailable: true, evidenceHits: 2,
      requiredDims: [{ dim: 'identity', on_missing: 'warn' }, { dim: 'governance', on_missing: 'warn' }],
      suppliedDims: ['identity', 'governance'],
      focus: [{ key: 'importance', weight: 1.5 }, { key: 'precision', weight: 1.5 }],
    });
    // 对象形态归一后 relevance 集合运算应命中（此前恒 0 分）
    expect(r.scores.relevance.score).toBe(4);
    // 聚焦加权应生效（importance/precision ×1.5）
    expect(r.weighted_total).toBeGreaterThan(
      (await scoreDecision(goodCtx(), { storyAvailable: true, evidenceHits: 2, requiredDims: ['identity', 'governance'], suppliedDims: ['identity', 'governance'] })).weighted_total
    );
  });

  it('【B4 深合并】仅传 warn 阈值不顶掉出厂 good（good 边界仍可判）', async () => {
    // 出厂 good=0.75；若浅合并（warn:0.5 覆盖全部），good 变 undefined → 永远判不到 good。
    // 深合并后 good 保持 0.75：goodCtx 的 ratio≈0.786 → level='good'。
    const r = await scoreDecision(goodCtx(), { storyAvailable: true, evidenceHits: 2, thresholds: { warn: 0.5 } });
    expect(r.level).toBe('good');
    // 对照组：把 good 阈值拉到 0.99（ratio 0.786 无法达到）→ 从 good 降为 warn（非恒 good）
    const r2 = await scoreDecision(goodCtx(), { storyAvailable: true, evidenceHits: 2, thresholds: { warn: 0.5, good: 0.99 } });
    expect(r2.level).toBe('warn');
  });

  it('阈值配置化：warn 线可调', async () => {
    const r = await scoreDecision(goodCtx(), { storyAvailable: true, evidenceHits: 2, thresholds: { good: 0.99, warn: 0.99 } });
    expect(r.level).toBe('poor'); // 高分但阈值被拉高
  });

  it('【B 真子集】enabled 非空只跑列出的尺子，其余 skipped 不计入总分（缺省=全 9 尺子，向后兼容）', async () => {
    const r = await scoreDecision(goodCtx(), { storyAvailable: true, evidenceHits: 2, suppliedDims: ['price'], requiredDims: ['price'], enabled: ['clarity', 'relevance'] });
    expect(Object.keys(r.scores)).toHaveLength(9); // 仍返回全部 9 键（含 skipped 标记）
    expect(r.scores.clarity.skipped).toBeFalsy();
    expect(r.scores.relevance.skipped).toBeFalsy();
    expect(r.scores.accuracy.skipped).toBe(true);
    expect(r.scores.depth.skipped).toBe(true);
    expect(r.scores.fairness.skipped).toBe(true);
    // 总分仅来自 clarity(4)+relevance(4)，无 focus → ×1.0
    expect(r.weighted_total).toBe(8);
    expect(r.max_total).toBe(8); // 2 尺子 × 4
    expect(r.level).toBe('good'); // ratio=1.0
  });

  it('【B 真子集】enabled 与 focus 叠加：子集内聚焦尺子仍 ×1.5', async () => {
    const r = await scoreDecision(goodCtx(), { storyAvailable: true, evidenceHits: 2, suppliedDims: ['price'], requiredDims: ['price'], enabled: ['clarity', 'relevance', 'depth'], focus: ['depth'] });
    expect(r.scores.depth.skipped).toBeFalsy();
    expect(r.scores.breadth.skipped).toBe(true);
    // clarity 4 + relevance 4 + depth 4×1.5 = 8 + 6 = 14；max = 4 + 4 + 4×1.5 = 14
    expect(r.weighted_total).toBe(14);
    expect(r.max_total).toBe(14);
  });
});

describe('九尺子评分器 · 持久化', () => {
  it('persistRubric 用 mock pool 逐尺子 INSERT + 更新 decision.rubric（SQL 正确、参数化）', async () => {
    const queries = [];
    const mockPool = {
      query: async (text, params) => {
        queries.push({ text, params });
        return { rowCount: 1 };
      },
    };
    const rubric = await scoreDecision(goodCtx(), { storyAvailable: true, evidenceHits: 2, suppliedDims: ['price'], requiredDims: ['price'] });
    const n = await persistRubric(mockPool, 'dec-123', rubric);
    expect(n).toBe(9);
    const inserts = queries.filter((q) => q.text.includes('INTO crm.decision_rubric_score'));
    expect(inserts).toHaveLength(9);
    inserts.forEach((q) => {
      expect(q.params[1]).toMatch(/^(clarity|accuracy|precision|relevance|depth|breadth|logic|importance|fairness)$/);
      expect(q.params[0]).toBe('dec-123');
    });
    const upd = queries.find((q) => q.text.includes('UPDATE crm.decision SET rubric'));
    expect(upd).toBeTruthy();
    expect(upd.params[1]).toBe('dec-123');
    expect(() => JSON.parse(upd.params[0])).not.toThrow();
  });

  it('persistRubric 缺 pool/decisionId 抛错（护栏）', async () => {
    await expect(persistRubric(null, 'x', { scores: {} })).rejects.toThrow();
    await expect(persistRubric({}, null, { scores: {} })).rejects.toThrow();
  });
});

describe('九尺子顺序固定（命名铁律）', () => {
  it('RUBRICS 顺序 = 1清晰…9公平，禁用「关联性」', () => {
    expect(RUBRICS.map((r) => r.key)).toEqual([
      'clarity', 'accuracy', 'precision', 'relevance', 'depth', 'breadth', 'logic', 'importance', 'fairness',
    ]);
    expect(RUBRICS.some((r) => r.name.includes('关联'))).toBe(false);
  });
});
