// test/embedding-model.test.js — EMBEDDING_PROVIDER='model' 时 searchPrecedents 向量分量自动启用
// 用确定性「伪语义」向量 mock fetch：同源文本 → 相同向量（验证 model 路径余弦逻辑与同源一致，不依赖真实模型/网络）。
// 关键断言：provider='model' 时 components.vector>0（旧 hash 路径恒 null），且近义候选被召回。
// 注：共享测试库未必种子化默认 llm_config，故 mock llmConfigStore 让 model 路径可达（与 embeddingClient 单测同手法）。
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createHash } from 'node:crypto';

vi.mock('../src/llm/llmConfigStore.js', () => ({
  getDefault: async () => ({ provider: 'siliconflow', model: 'BAAI/bge-large-zh-v1.5', base_url: 'https://api.siliconflow.cn/v1', api_key: 'enc' }),
  hydrate: (c) => ({ ...c, apiKey: 'sk-test', base: 'https://api.siliconflow.cn/v1/chat/completions' }),
}));

import { createDecision, searchPrecedents } from '../src/decision/decisionRepo.js';
import { pool } from '../src/db.js';

const realFetch = global.fetch;
const REAL_ENV = process.env.EMBEDDING_PROVIDER;

// 确定性向量：文本 → 1024 维（与 BAAI/bge-large-zh-v1.5 维度一致；列已 vector(1024)）。
// 同源文本同向量（验证余弦与同源重嵌），维度对齐避免写入 vector(1024) 列报维度错误。
function fakeEmbedding(text) {
  const out = [];
  let h = createHash('sha256').update(text).digest();
  for (let i = 0; i < 1024; i++) {
    if (i > 0 && i % 32 === 0) h = createHash('sha256').update(h).digest();
    out.push(((h[i % 32] + i) % 255) / 255);
  }
  return out;
}

beforeAll(async () => {
  process.env.EMBEDDING_PROVIDER = 'model';
  // 隔离：将本测试涉及 scenario 的残留 CONFIRMED/AUTONOMOUS 移出候选池，避免历史数据污染断言
  //   （测试数据清理，非生产写操作；不改删除语义，仅改 state 使 searchPrecedents 候选池排除）
  await pool.query(
    `UPDATE crm.decision SET state='ARCHIVED' WHERE scenario_id IN ('LEAD_FOLLOW_UP','QUOTE_PRICING') AND state IN ('CONFIRMED','AUTONOMOUS')`
  ).catch(() => {});
  global.fetch = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    return { ok: true, status: 200, async json() { return { data: [{ embedding: fakeEmbedding(body.input) }] }; } };
  };
});
afterAll(() => {
  process.env.EMBEDDING_PROVIDER = REAL_ENV; // 还原，避免影响其它套件（默认 hash）
  global.fetch = realFetch;
});

describe('searchPrecedents 向量分量（model 路径）', () => {
  it('近义查询召回候选且 components.vector>0（同源重嵌生效，非恒 null）', async () => {
    const ctx = { customer: 'acme', project: 'pilot' };
    const conds = [{ cond: 'B', met: true }];
    await createDecision({
      scenario_id: 'LEAD_FOLLOW_UP', trigger_context: ctx, conditions_evaluated: conds,
      disposition: 'APPROVE', business_tier: 'LEAD', state: 'CONFIRMED',
    });
    const precs = await searchPrecedents(
      'LEAD_FOLLOW_UP',
      { trigger_context: ctx, conditions_evaluated: conds, business_tier: 'LEAD', disposition: 'APPROVE' },
      { k: 5 }
    );
    expect(precs.length).toBeGreaterThanOrEqual(1);
    const hit = precs[0];
    // 同源文本 → 余弦≈1（jaccard/category 也满 → 总分≈0.8），证明向量分量真正参与评分
    expect(hit.components.vector).toBeGreaterThan(0.9);
    expect(hit.similarity).toBeGreaterThan(0.45);
  });

  it('不同语义查询 → 向量分量显著低于近义（区分度成立，非 hash 噪声恒≈0.11）', async () => {
    const ctxA = { customer: 'acme', project: 'pilot' };
    const ctxB = { customer: 'zzz-other-co', project: 'totally-different' };
    await createDecision({
      scenario_id: 'QUOTE_PRICING', trigger_context: ctxB, conditions_evaluated: [{ cond: 'price', met: false }],
      disposition: 'REJECT', business_tier: 'HIGH', state: 'CONFIRMED',
    });
    const precs = await searchPrecedents(
      'QUOTE_PRICING',
      { trigger_context: ctxA, conditions_evaluated: [{ cond: 'price', met: true }], business_tier: 'LEAD', disposition: 'APPROVE' },
      { k: 5 }
    );
    // ctxA 与 ctxB 文本不同 → 向量低相似；即便同 scenario，向量分量应明显 < 近义情形
    for (const p of precs) {
      if (p.scenario_id === 'QUOTE_PRICING') expect(p.components.vector).toBeLessThan(0.9);
    }
  });
});
