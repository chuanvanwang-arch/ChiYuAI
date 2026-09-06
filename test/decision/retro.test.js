// test/decision/retro.test.js — 决策复盘跑批（T5）
// 隔离：db.js 全 mock（不触真实 PG）；LLM 经 llmFactory 注入（不发真实网络请求）
// 覆盖：每 cluster 独立取用 LLM（round-robin 轮换，根治限流连续超时）/
//       LLM 合法 → 出处方 / LLM 不可信 → 降级但 llm_effective=0（暴露限流）/
//       LLM 不可用 → llm_enabled=false / 样本不足 R6 守卫不出处方 / dryRun 不落库
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ rows: [], calls: [] }));
vi.mock('../../src/db.js', () => ({
  query: async (sql, params) => { h.calls.push({ sql, params }); return { rows: h.rows, rowsAffected: 0 }; },
}));

import { runDecisionRetro } from '../../src/decision/retro.js';

// 构造决策行：attribution.required_fill.missing 驱动聚类摘要；feedback 驱动负反馈计数
function mkRow(scenarioId, i, { missing = ['identity'], category = 'dim_missing' } = {}) {
  return {
    decision_id: `d-${scenarioId}-${i}`,
    scenario_id: scenarioId,
    decided_at: new Date().toISOString(),
    attribution: { category, required_fill: { missing }, edge_compliance: {} },
    feedback: { usable: true, major_deviation: false },
  };
}
function mkRows(scenarioId, n, opts) {
  return Array.from({ length: n }, (_, i) => mkRow(scenarioId, i, opts));
}

const VALID_OUT = {
  root_cause_class: 'DIM_MISSING',
  root_cause_explanation: '身份维度缺失',
  draft_patches: [{
    knob: 'required_dims', target: 'OPP_QUALIFY', from_value: null,
    to_value: { add: ['identity'] }, risk: 'LOW', label: '补身份维度', evidence: {},
  }],
  confidence: 0.8,
  predicted_impact: '维度覆盖率提升',
};

// llmFactory：每次调用记一笔 opts，并按 impl 返回 llmJson 函数或 null
function factory(impl) {
  const calls = [];
  const f = async (opts) => { calls.push(opts); return impl(calls.length - 1); };
  f.calls = calls;
  return f;
}

beforeEach(() => {
  h.rows = [];
  h.calls = [];
});

describe('runDecisionRetro · LLM 取用策略', () => {
  it('每个 cluster 独立取用 LLM，且携带 strategy=round-robin（多配置轮换，规避单 key 限流）', async () => {
    h.rows = [...mkRows('OPP_QUALIFY', 25), ...mkRows('LEAD_FOLLOW_UP', 25)];
    const f = factory(() => async () => VALID_OUT);
    const rep = await runDecisionRetro({ windowHours: 24, dryRun: true, llmFactory: f });

    expect(rep.clusters).toHaveLength(2);
    expect(f.calls).toHaveLength(2); // 2 个 cluster → 2 次取用（旧实现仅 1 次，全部打到同一条配置）
    for (const c of f.calls) expect(c.strategy).toBe('round-robin');
    expect(rep.draft_patches).toHaveLength(2);
    expect(rep.summary.llm_enabled).toBe(true);
    expect(rep.summary.llm_effective).toBe(2);
  });

  it('dryRun 不落库（仅 2 次查询：窗口决策加载 + 复盘超时配置读取）', async () => {
    h.rows = mkRows('OPP_QUALIFY', 25);
    await runDecisionRetro({ windowHours: 24, dryRun: true, llmFactory: factory(() => async () => VALID_OUT) });
    expect(h.calls).toHaveLength(2);
    const sqls = h.calls.map((c) => c.sql).join(' | ');
    expect(sqls).toContain('FROM crm.decision');
    // 超时阈值配置化（禁硬编码）：config_store 参数化查询，key 落在 params 里
    const cfgCall = h.calls.find((c) => String(c.sql).includes('crm.config_store'));
    expect(cfgCall).toBeTruthy();
    expect(cfgCall.params).toContain('decision-retro');
  });

  it('LLM 超时阈值可经 config_store 覆盖（出厂兜底 180000ms）', async () => {
    h.rows = mkRows('OPP_QUALIFY', 25);
    let seen = null;
    const f = factory(() => async (sys, user, o) => { seen = o; return VALID_OUT; });
    await runDecisionRetro({ windowHours: 24, dryRun: true, llmFactory: f });
    expect(seen.timeoutMs).toBe(180000); // 无配置 → 出厂兜底（推理模型实测 107~125s）
  });
});

describe('runDecisionRetro · 降级语义（限流可观测）', () => {
  it('LLM 输出不可信 → 降级、不出处方，但 llm_enabled=true 而 llm_effective=0（暴露限流降级）', async () => {
    h.rows = mkRows('OPP_QUALIFY', 25);
    const f = factory(() => async () => ({ root_cause_class: 'NOT_IN_ENUM' }));
    const rep = await runDecisionRetro({ windowHours: 24, dryRun: true, llmFactory: f });

    expect(rep.draft_patches).toHaveLength(0);
    expect(rep.summary.llm_enabled).toBe(true); // 配置可用
    expect(rep.summary.llm_effective).toBe(0);  // 实际未吃到（关键：区分「没配」与「配了但超时」）
    expect(rep.clusters[0].llm_used).toBe(false);
  });

  it('LLM 不可用（未配置）→ llm_enabled=false 且走启发式降级', async () => {
    h.rows = mkRows('OPP_QUALIFY', 25);
    const f = factory(() => null);
    const rep = await runDecisionRetro({ windowHours: 24, dryRun: true, llmFactory: f });

    expect(rep.llm_enabled).toBe(false);
    expect(rep.draft_patches).toHaveLength(0);
    expect(rep.clusters[0].llm_used).toBe(false);
  });

  it('限流场景：前几次超时（LLM 抛）、后续成功 → 成功者仍出处方（多配置重试生效）', async () => {
    h.rows = [...mkRows('OPP_QUALIFY', 25), ...mkRows('LEAD_FOLLOW_UP', 25), ...mkRows('QUOTE_PRICING', 25)];
    // 第 1 个 cluster 的 LLM 调用超时（返回 null，模拟超时降级），后 2 个成功
    const f = factory((i) => (i === 0 ? async () => null : async () => VALID_OUT));
    const rep = await runDecisionRetro({ windowHours: 24, dryRun: true, llmFactory: f });

    expect(rep.clusters).toHaveLength(3);
    expect(rep.draft_patches).toHaveLength(2); // 仅后 2 个出处方
    expect(rep.summary.llm_effective).toBe(2);
  });
});

describe('runDecisionRetro · R6 样本守卫', () => {
  it('样本 < MIN_SAMPLE(20) → NEED_DIM_ORDER 且不出处方，且不调用 LLM', async () => {
    h.rows = mkRows('OPP_QUALIFY', 7);
    const f = factory(() => async () => VALID_OUT);
    const rep = await runDecisionRetro({ windowHours: 24, dryRun: true, llmFactory: f });

    expect(rep.clusters[0].root_cause_class).toBe('NEED_DIM_ORDER');
    expect(rep.clusters[0].draft_patches).toEqual([]);
    expect(rep.clusters[0].root_cause_explanation).toContain('样本不足');
    expect(f.calls).toHaveLength(1); // 仍取用（守卫在 analyzeCluster 内），但未真正调用 LLM 出方案
  });
});
