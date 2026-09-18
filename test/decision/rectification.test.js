// test/decision/rectification.test.js — 整改报告结构化（Task 11 / 设计 §16.2）
// 隔离：db.js 全 mock（按 SQL 片段分发，不触真实 PG）；LLM 经 llmFactory 注入。
// 覆盖：
//   summarizeDailyOps 三源聚合（decision/tasks/agent_sla）+ 数值换算（pg 计数返回字符串）；
//   buildVerdict 纯函数（失败/受阻>0 → 提示关注；全零 → 执行平稳）；
//   runDecisionRetro 非 dryRun → report.rectification 三段落 + INSERT 含 rectification 列；
//   dryRun 契约不破坏 → 不触发 dailyOps 聚合查询、rectification 为空（存量「仅 2 次查询」断言的前提）。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  decisionRows: [],      // retro 窗口决策（SELECT * FROM crm.decision ... LIMIT）
  decisionAgg: null,     // dailyOps 决策聚合行（decider_type 口径）
  taskAgg: null,         // dailyOps 任务聚合行
  slaRows: [],           // dailyOps SLA 行
  insertCalls: [],       // decision_retro_report INSERT
  allCalls: [],          // 全部查询（按序）
}));
vi.mock('../../src/db.js', () => ({
  query: async (sql, params) => {
    const s = String(sql);
    h.allCalls.push(s);
    if (s.includes('INSERT INTO crm.decision_retro_report')) {
      h.insertCalls.push({ sql: s, params });
      return { rows: [{ report_id: 'rep-rect-1' }] };
    }
    if (s.includes('decider_type')) return { rows: [h.decisionAgg] };   // dailyOps 决策聚合
    if (s.includes('FROM crm.tasks')) return { rows: [h.taskAgg] };     // dailyOps 任务聚合
    if (s.includes('FROM crm.agent_sla')) return { rows: h.slaRows };   // dailyOps SLA 快照
    if (s.includes('crm.config_store')) return { rows: [] };            // retroTimeoutMs 配置读取
    if (s.includes('FROM crm.decision')) return { rows: h.decisionRows }; // retro 窗口加载
    return { rows: [] };
  },
}));

// D7（2026-09-18）：retro 收盘自动升格依赖 memoryLog/promote —— 本测试隔离要求「不触真实 PG」，
//   故 mock 之（append 成功 / promote 成功 / list 空）。dryRun 契约用例不受影响（不触发升格）。
vi.mock('../../src/memory/memoryLog.js', () => ({
  appendMemory: async ({ topic, kind, payload, layer, actor, explicit, tenantId }) =>
    ({ ok: true, row: { id: 'mem-' + String(Math.random()), topic, kind, payload, layer, actor, tenant_id: tenantId } }),
}));
vi.mock('../../src/memory/promote.js', () => ({
  promoteMemoryToTenant: async (pool, { memoryId, tenantId, by, decisionId, title }) =>
    ({ ok: true, row: { id: 'tp-' + String(memoryId), tenant_id: tenantId } }),
  listTenantPrecedents: async (pool, tenantId) => [],
}));

import { summarizeDailyOps, buildVerdict } from '../../src/decision/dailyOps.js';
import { runDecisionRetro } from '../../src/decision/retro.js';

function mkRow(scenarioId, i, { missing = ['identity'], category = 'dim_missing' } = {}) {
  return {
    decision_id: `d-${scenarioId}-${i}`,
    scenario_id: scenarioId,
    tenant_id: 'system',
    decided_at: new Date().toISOString(),
    attribution: { category, required_fill: { missing }, edge_compliance: {} },
    feedback: { usable: true, major_deviation: false },
  };
}
function mkRows(scenarioId, n, opts) {
  return Array.from({ length: n }, (_, i) => mkRow(scenarioId, i, opts));
}

// LLM 合法输出：config_store 类处方（用户主线场景 minSimilarity 0.45→0.40）
const VALID_OUT = {
  root_cause_class: 'DATA_QUALITY_PRECEDENT',
  root_cause_explanation: '先例命中率 12% vs 健康线 30%',
  draft_patches: [{
    knob: 'config_store', target: 'precedent-conf.minSimilarity',
    from_value: 0.45, to_value: 0.40, risk: 'LOW',
    label: 'minSimilarity 下调 0.45→0.40，预计先例召回 +6pp',
    evidence: { hit_rate_measured: '0.12', healthy_baseline: '0.30' },
  }],
  confidence: 0.8,
  predicted_impact: '先例命中率预计升至 ~0.18',
};

function factory(impl) {
  const calls = [];
  const f = async (opts) => { calls.push(opts); return impl(calls.length - 1); };
  f.calls = calls;
  return f;
}

beforeEach(() => {
  h.decisionRows = [];
  h.decisionAgg = null;
  h.taskAgg = null;
  h.slaRows = [];
  h.insertCalls = [];
  h.allCalls = [];
});

describe('summarizeDailyOps · 三源聚合（§16.2 daily_ops）', () => {
  it('聚合 decision/tasks/agent_sla 三源，pg 字符串计数正确换算为数值', async () => {
    // pg 的 COUNT(*) 返回字符串、NUMERIC 返回字符串——须 +() 强转（计划缺陷修正 #5：decider_type 口径）
    h.decisionAgg = { total: '142', autonomous: '98', escalated: '44', avg_confidence: '0.81' };
    h.taskAgg = { scheduled: '30', completed: '28', timeout: '2', failed: '1' };
    h.slaRows = [{ auditability_pct: '98.20', tampered_count: '0', q1_pass: '120' }];

    const ops = await summarizeDailyOps(null, {
      window_start: '2026-09-04T02:00:00.000Z',
      window_end: '2026-09-05T02:00:00.000Z',
    });

    expect(ops.window).toBe('2026-09-04T02:00:00.000Z~2026-09-05T02:00:00.000Z');
    expect(ops.decisions).toEqual({ total: 142, autonomous: 98, escalated: 44, avg_confidence: 0.81 });
    expect(ops.agent_tasks).toEqual({ scheduled: 30, completed: 28, timeout: 2, failed: 1 });
    expect(ops.agent_sla).toEqual({ auditability_pct: 98.2, tampered: 0, q1_pass: 120 });
    expect(typeof ops.verdict).toBe('string');
    expect(ops.verdict.length).toBeGreaterThan(0);
  });

  it('三源全空（无行/无快照）→ 全零兜底不抛错', async () => {
    h.decisionAgg = {}; h.taskAgg = {}; h.slaRows = [];
    const ops = await summarizeDailyOps(null, {
      window_start: '2026-09-04T02:00:00.000Z', window_end: '2026-09-05T02:00:00.000Z',
    });
    expect(ops.decisions).toEqual({ total: 0, autonomous: 0, escalated: 0, avg_confidence: 0 });
    expect(ops.agent_tasks).toEqual({ scheduled: 0, completed: 0, timeout: 0, failed: 0 });
    expect(ops.agent_sla).toEqual({ auditability_pct: 0, tampered: 0, q1_pass: 0 });
  });

  it('聚合 SQL 口径：decision 用 decider_type（无 autonomy 列）、tasks 用 blocked 承载 timeout 槽位', async () => {
    h.decisionAgg = {}; h.taskAgg = {}; h.slaRows = [];
    await summarizeDailyOps(null, { window_start: 'a', window_end: 'b' });
    const decSql = h.allCalls.find((s) => s.includes('decider_type'));
    const taskSql = h.allCalls.find((s) => s.includes('FROM crm.tasks'));
    expect(decSql).toContain("decider_type = 'AUTONOMOUS_AGENT'");
    expect(taskSql).toContain("status = 'blocked'");
  });
});

describe('buildVerdict · 纯函数判定', () => {
  it('存在失败/受阻任务 → 提示关注并给出数量', () => {
    const v = buildVerdict({}, { failed: '1', timeout: '2' });
    expect(v).toContain('关注');
    expect(v).toContain('1');
    expect(v).toContain('2');
  });

  it('无失败/受阻 → 执行平稳', () => {
    const v = buildVerdict({ total: '10' }, { failed: '0', timeout: '0' });
    expect(v).toContain('平稳');
  });
});

describe('runDecisionRetro · rectification 三段落（§16.2）', () => {
  it('非 dryRun：报告含 daily_ops/problems/prescriptions，且 INSERT 携带 rectification 列', async () => {
    // 场景 A（25 样本）LLM 出 config_store 处方；场景 B（25 样本）LLM 不可用 → 降级簇（confidence 0.3 → problems）
    h.decisionRows = [...mkRows('OPP_QUALIFY', 25), ...mkRows('LEAD_FOLLOW_UP', 25)];
    h.decisionAgg = { total: '50', autonomous: '42', escalated: '8', avg_confidence: '0.77' };
    h.taskAgg = { scheduled: '10', completed: '9', timeout: '1', failed: '0' };
    h.slaRows = [{ auditability_pct: '98.20', tampered_count: '0', q1_pass: '120' }];
    const f = factory((i) => (i === 0 ? async () => VALID_OUT : null));

    const rep = await runDecisionRetro({ windowHours: 24, dryRun: false, llmFactory: f, now: '2026-09-05T02:00:00.000Z' });

    // ① 三段落存在
    expect(rep.rectification).toBeTruthy();
    expect(rep.rectification.daily_ops.decisions).toEqual({ total: 50, autonomous: 42, escalated: 8, avg_confidence: 0.77 });
    expect(rep.rectification.daily_ops.agent_tasks).toEqual({ scheduled: 10, completed: 9, timeout: 1, failed: 0 });
    expect(rep.rectification.daily_ops.verdict).toContain('关注');

    // ② problems：降级簇（confidence 0.3 < 0.7）入选，含根因与证据
    //    （heuristicAnalyze 按证据判 DIM_MISSING：mkRow missing=['identity']）
    expect(Array.isArray(rep.rectification.problems)).toBe(true);
    expect(rep.rectification.problems.length).toBe(1);
    expect(rep.rectification.problems[0]).toMatchObject({
      cluster: 'LEAD_FOLLOW_UP',
      root_cause: 'DIM_MISSING',
    });
    expect(typeof rep.rectification.problems[0].evidence).toBe('string');

    // ③ prescriptions：draft_patches 映射（from_value/to_value → from/to；label → why）
    expect(rep.rectification.prescriptions).toHaveLength(1);
    expect(rep.rectification.prescriptions[0]).toMatchObject({
      target: 'precedent-conf.minSimilarity',
      from: 0.45,
      to: 0.40,
      risk: 'LOW',
      knob: 'config_store',
    });
    expect(rep.rectification.prescriptions[0].why).toContain('minSimilarity');

    // ④ INSERT 携带 rectification 列（第 9 列）且为合法 JSON 三段落
    expect(h.insertCalls).toHaveLength(1);
    expect(h.insertCalls[0].sql).toContain('rectification');
    const rt = JSON.parse(h.insertCalls[0].params[8]);
    expect(rt.daily_ops.decisions.total).toBe(50);
    expect(Array.isArray(rt.problems)).toBe(true);
    expect(rt.prescriptions[0].target).toBe('precedent-conf.minSimilarity');

    // ⑤ 落库 report_id 回填
    expect(rep.report_id).toBe('rep-rect-1');
  });

  it('dryRun 契约不破坏：不触发 dailyOps 聚合查询、rectification 为空', async () => {
    h.decisionRows = mkRows('OPP_QUALIFY', 25);
    const f = factory(() => async () => VALID_OUT);
    const rep = await runDecisionRetro({ windowHours: 24, dryRun: true, llmFactory: f });

    expect(rep.rectification).toBeUndefined();
    expect(h.allCalls.some((s) => s.includes('FROM crm.tasks'))).toBe(false);
    expect(h.allCalls.some((s) => s.includes('FROM crm.agent_sla'))).toBe(false);
    expect(h.allCalls.some((s) => s.includes('decider_type'))).toBe(false);
    expect(h.insertCalls).toHaveLength(0);
  });
});
