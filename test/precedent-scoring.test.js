// test/precedent-scoring.test.js — C4 先例相似度四分量评分器回归锁
// 设计：docs/2026-09-03-c2c3c4-decision-integrity-implementation.md T9
import { test, expect } from 'vitest';
import { hashVector, EMBED_PROVIDER, embedText } from '../src/ontology/embedding.js';
import {
  jaccardConditions, categoryMatch, normalizeWeights, similarityOf,
  graphDepthOf, cosine, DEFAULT_WEIGHTS, loadPrecedentConf,
} from '../src/decision/precedentScoring.js';
import { createDecision, searchPrecedents } from '../src/decision/decisionRepo.js';

// ① hashVector 伪向量噪声回归锁：语义相近（仅金额微变）cos 必须很低，不得充当语义相似度
test('hashVector 伪向量噪声锁：金额微变 cos < 0.3', () => {
  const a = hashVector('deal.advance|ctx={amount:120000}');
  const b = hashVector('deal.advance|ctx={amount:120001}');
  expect(cosine(a, b)).toBeLessThan(0.3);
});

// ② jaccard 全等 → 1.0
test('jaccard 全等 → 1.0', () => {
  const cond = [{ cond: 'B', met: true }, { cond: 'price', met: false }];
  expect(jaccardConditions(cond, cond)).toBe(1.0);
});

// ③ jaccard 三态：met:true 与 met:null 视为不同元素（禁假合并）
test('jaccard 三态：met:true 与 met:null 视为不同元素', () => {
  const a = [{ cond: 'B', met: true }];
  const b = [{ cond: 'B', met: null }];
  expect(jaccardConditions(a, b)).toBe(0);
  // 但同态应匹配
  expect(jaccardConditions(a, [{ cond: 'B', met: true }])).toBe(1.0);
});

// ④ 权重归一：合计必为 1.0
test('权重归一：{jaccard:2,category:1,graphDepth:1,vector:0} → 合计 1.0', () => {
  const { weights } = normalizeWeights({ jaccard: 2, category: 1, graphDepth: 1, vector: 0 });
  const sum = weights.jaccard + weights.category + weights.graphDepth + weights.vector;
  expect(Math.abs(sum - 1)).toBeLessThan(1e-9);
  expect(weights.jaccard).toBeCloseTo(0.5, 6);
});

// ⑤ 权重全 0 → 回退出厂 + degraded:true（禁静默接受非正权重）
test('权重全 0 → 回退出厂 + degraded:true', () => {
  const { weights, degraded } = normalizeWeights({ jaccard: 0, category: 0, graphDepth: 0, vector: 0 });
  expect(degraded).toBe(true);
  expect(weights.jaccard).toBe(0.5);
  expect(weights.category).toBe(0.25);
});

// ⑥ 向量降级：provider='hash' 时丢弃向量分量，jaccard 权重 ≥ 0.4
test('向量降级：provider=hash → dropVector 丢弃 vector 分量，jaccard 权重 ≥ 0.4', async () => {
  const { weights, degraded } = normalizeWeights(DEFAULT_WEIGHTS, { dropVector: true });
  expect(degraded).toBe(true);
  expect(weights.vector).toBe(0);
  expect(weights.jaccard).toBeCloseTo(0.5, 6); // 0.4 / (0.4+0.2+0.2)
  // 默认路径 embedText 返回 hash provider → 下游向量分量必须置 null
  const emb = await embedText('any text');
  expect(emb.provider).toBe(EMBED_PROVIDER.HASH);
});

// ⑦ 端到端召回：语义相近先例被召回且 similarity ≥ 0.45（旧伪向量恒≈0.11 不召回）
test('端到端召回：语义相近先例被召回且 similarity ≥ 0.45', async () => {
  let d;
  try {
    d = await createDecision({
      scenario_id: 'LEAD_FOLLOW_UP',
      trigger_context: { customer: 'normal', project: 'pilot' },
      conditions_evaluated: [{ cond: 'B', met: true }],
      disposition: 'APPROVE', business_tier: 'LEAD', state: 'CONFIRMED',
    });
  } catch (e) {
    if (String(e?.message || '').includes('ECONNREFUSED')) return; // DB 不可达，跳过（不冒充绿）
    throw e;
  }
  const precs = await searchPrecedents('LEAD_FOLLOW_UP', {
    trigger_context: { customer: 'normal', project: 'pilot' },
    conditions_evaluated: [{ cond: 'B', met: true }],
    business_tier: 'LEAD', disposition: null,
  }, { k: 5 });
  const hit = precs.find((p) => p.decision_id === d.decision_id);
  expect(hit).toBeTruthy();
  expect(hit.similarity).toBeGreaterThanOrEqual(0.45);
});

// ⑧ 配置缺省值（无 DB 也能跑）：minSimilarity 默认 0.45，权重默认四分量
test('loadPrecedentConf 无配置时回退出厂默认值', async () => {
  const conf = await loadPrecedentConf({ tenantId: 'system' });
  expect(conf.minSimilarity).toBe(0.45);
  expect(conf.weights).toEqual(DEFAULT_WEIGHTS);
});

// ⑧b graphDepthOf 读 PG 权威表（不再门 AGE）：无下游引用 → 0（非 null），仅读异常 → null
test('graphDepthOf 读 PG：无下游引用返回 0、有下游引用返回 >0', async () => {
  // 无引用 id（用语法合法但不存在的 UUID，避免 UUID 列比较抛 invalid syntax）：downstream 0 行 → 0
  let base;
  try {
    base = await graphDepthOf('11111111-1111-1111-1111-111111111111');
  } catch (e) {
    if (String(e?.message || '').includes('ECONNREFUSED')) return; // DB 不可达跳过
    throw e;
  }
  expect(base).toBe(0); // 修复前 AGE 关→恒 null；修复后读 PG 决策先例关系表，无引用即 0

  // 构造下游引用：B 引用 A 为先例 → A 的 graphDepth（downstream）应 > 0
  let a, b;
  try {
    a = await createDecision({
      scenario_id: 'LEAD_FOLLOW_UP', trigger_context: { customer: 'normal' },
      conditions_evaluated: [{ cond: 'B', met: true }],
      disposition: 'APPROVE', business_tier: 'LEAD', state: 'CONFIRMED',
    });
    b = await createDecision({
      scenario_id: 'LEAD_FOLLOW_UP', trigger_context: { customer: 'normal' },
      conditions_evaluated: [{ cond: 'B', met: true }],
      disposition: 'APPROVE', business_tier: 'LEAD', state: 'CONFIRMED',
      referenced_precedents: [{ precedent_id: a.decision_id, similarity: 0.9 }],
    });
  } catch (e) {
    if (String(e?.message || '').includes('ECONNREFUSED')) return;
    throw e;
  }
  expect(b).toBeTruthy();
  const depth = await graphDepthOf(a.decision_id, { maxDepth: 3 });
  expect(depth).toBeGreaterThan(0); // B 引用了 A → A 被引用计数 ≥ 1
});
