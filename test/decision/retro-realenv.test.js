// test/decision/retro-realenv.test.js — 夜间复盘「真实环境」四类盲点修复（R1/R2/R3/R5）
// 背景：docs/2026-09-05-nightly-retro-realenv-rootcause.md
//   R1 MIN_SAMPLE=20 硬编码 vs 真实日产量个位数 → 全簇短路、恒不调 LLM（llm_effective 连两晚为 0）
//   R2 待办只认 knob='config_store' → 真实 14 条处方命中 0 条，calibration_patch 恒 0 行
//   R3 retro 读 config_store['decision-retro']，该键从未落库 → llm_timeout_ms 等配置恒走代码兜底（死代码）
//   R5 无全局 deadline（单簇最坏 360s）+ 无连续失败熔断
// 隔离：db.js / store.js / dailyOps.js / monitorStore.js 全 mock（不触真实 PG、不发真实网络请求）
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  decisionRows: [],      // crm.decision 查询结果（默认 / 近窗口）
  farRows: null,         // 非 null 时：窗口 >48h 的扩展查询返回此值（模拟扩窗后样本变多）
  configValue: null,     // config_store['decision-retro'].value（null = 键不存在）
  calls: [],             // db.query 调用轨迹 { sql, params }
  savedPatches: [],      // savePatches 收到的处方
  emitted: [],           // events.bus.emit 轨迹
}));

vi.mock('../../src/db.js', () => ({
  query: async (sql, params) => {
    h.calls.push({ sql: String(sql), params });
    if (/FROM crm\.config_store/.test(sql)) {
      return h.configValue === null ? { rows: [], rowsAffected: 0 } : { rows: [{ value: h.configValue, decision_id: null }] };
    }
    if (/FROM crm\.decision/.test(sql) && h.farRows && params?.[0]) {
      const ageH = (Date.now() - Date.parse(params[0])) / 3600000;
      if (ageH > 48) return { rows: h.farRows, rowsAffected: 0 }; // 扩展窗口（168h）
    }
    return { rows: h.decisionRows, rowsAffected: 0 };
  },
  queryWrite: async (sql, params) => { h.calls.push({ sql: String(sql), params }); return { rows: [], rowsAffected: 0 }; },
  withTx: async (fn) => fn({ query: async () => ({ rows: [] }) }),
}));

vi.mock('../../src/events/bus.js', () => ({
  emit: (domain, type, payload) => { h.emitted.push({ domain, type, payload }); },
}));

vi.mock('../../src/monitor/monitorStore.js', () => ({
  recordFailure: async () => {},
}));

vi.mock('../../src/calibration/store.js', () => ({
  savePatches: async (scenarioId, patches) => {
    h.savedPatches.push(...(patches || []).map((p) => ({ ...p, scenario_id: scenarioId })));
    return { created: (patches || []).length, skipped: [] };
  },
}));

vi.mock('../../src/decision/dailyOps.js', () => ({
  summarizeDailyOps: async () => ({
    window: 'mock', decisions: { total: 0, autonomous: 0, escalated: 0, avg_confidence: 0 },
    agent_tasks: { scheduled: 0, completed: 0, timeout: 0, failed: 0 },
    agent_sla: { auditability_pct: 0, tampered: 0, q1_pass: 0 }, verdict: 'mock',
  }),
}));

import { runDecisionRetro, readRetroConfig, RETRO_CONFIG_DEFAULTS, RETRO_CONFIG_KEY } from '../../src/decision/retro.js';

function mkRow(scenarioId, i, { daysAgo = 0 } = {}) {
  return {
    decision_id: `d-${scenarioId}-${i}`,
    scenario_id: scenarioId,
    decided_at: new Date(Date.now() - daysAgo * 86400000).toISOString(),
    tenant_id: 'system',
    attribution: { category: 'dim_missing', required_fill: { missing: ['identity'] }, edge_compliance: {} },
    feedback: { usable: true, major_deviation: false },
  };
}
function mkRows(scenarioId, n, opts) { return Array.from({ length: n }, (_, i) => mkRow(scenarioId, i, opts)); }

const VALID_OUT = (patches) => ({
  root_cause_class: 'DIM_MISSING',
  root_cause_explanation: '身份维度缺失',
  draft_patches: patches,
  confidence: 0.8,
  predicted_impact: '维度覆盖率提升',
});

// llmFactory：按 impl(i) 返回 llmJson 函数或 null；记录每次取用
function factory(impl) {
  const f = async (opts) => { f.calls.push(opts); return impl(f.calls.length - 1); };
  f.calls = [];
  return f;
}

beforeEach(() => {
  h.decisionRows = [];
  h.farRows = null;
  h.configValue = null;
  h.calls = [];
  h.savedPatches = [];
  h.emitted = [];
});

// ───────────────────────── R3：配置键单一事实源 ─────────────────────────
describe('R3 · 复盘配置 config_store 化（禁硬编码）', () => {
  it(`配置键为 '${RETRO_CONFIG_KEY}'，出厂默认值全部可数（无 undefined）`, async () => {
    const cfg = await readRetroConfig();
    expect(h.calls.some((c) => c.params?.includes(RETRO_CONFIG_KEY))).toBe(true);
    for (const [k, v] of Object.entries(RETRO_CONFIG_DEFAULTS)) {
      expect(typeof v === 'number' || typeof v === 'boolean').toBe(true);
      expect(cfg[k]).toBe(v);
    }
  });

  it('配置可覆盖：min_sample / llm_timeout_ms / window_extend_hours 全部生效', async () => {
    h.configValue = { min_sample: 5, llm_timeout_ms: 30000, window_extend_hours: 72 };
    const cfg = await readRetroConfig();
    expect(cfg.min_sample).toBe(5);
    expect(cfg.llm_timeout_ms).toBe(30000);
    expect(cfg.window_extend_hours).toBe(72);
  });

  it('非法/负数配置 → 回退出厂默认（fail-safe，不因脏配置崩跑批）', async () => {
    h.configValue = { min_sample: -1, llm_timeout_ms: 'abc', total_deadline_ms: null };
    const cfg = await readRetroConfig();
    expect(cfg.min_sample).toBe(RETRO_CONFIG_DEFAULTS.min_sample);
    expect(cfg.llm_timeout_ms).toBe(RETRO_CONFIG_DEFAULTS.llm_timeout_ms);
    expect(cfg.total_deadline_ms).toBe(RETRO_CONFIG_DEFAULTS.total_deadline_ms);
  });

  it('llm_timeout_ms 覆盖透传至 LLM 调用（原实现为死代码）', async () => {
    h.configValue = { llm_timeout_ms: 45000 };
    h.decisionRows = mkRows('OPP_QUALIFY', 25);
    let seen = null;
    await runDecisionRetro({ windowHours: 24, dryRun: true, llmFactory: factory(() => async (s, u, o) => { seen = o; return VALID_OUT([]); }) });
    expect(seen.timeoutMs).toBe(45000);
  });
});

// ───────────────────────── R1：min_sample 可配 + 窗口自适应 ─────────────────────────
describe('R1 · MIN_SAMPLE 配置化 + 窗口自适应', () => {
  it('min_sample 可下调 → 低样本簇也进入 LLM 分析（根治 llm_effective=0 空转）', async () => {
    h.configValue = { min_sample: 5 };
    h.decisionRows = mkRows('OPP_QUALIFY', 7);
    const f = factory(() => async () => VALID_OUT([{ knob: 'required_dims', target: 'OPP_QUALIFY', to_value: { add: ['identity'] }, risk: 'LOW' }]));
    const rep = await runDecisionRetro({ windowHours: 24, dryRun: true, llmFactory: f });

    expect(rep.summary.llm_effective).toBe(1);
    expect(rep.draft_patches).toHaveLength(1);
    expect(rep.clusters[0].root_cause_class).not.toBe('NEED_DIM_ORDER');
  });

  it('默认 min_sample=20 时，7 条样本仍短路（向后兼容既有 R6 守卫）', async () => {
    h.decisionRows = mkRows('OPP_QUALIFY', 7);
    const rep = await runDecisionRetro({ windowHours: 24, dryRun: true, llmFactory: factory(() => async () => VALID_OUT([])) });
    expect(rep.clusters[0].root_cause_explanation).toContain('样本不足');
  });

  it('全簇样本不足 → 自动扩展窗口（24h→168h）并重新取数，报告标 window_extended', async () => {
    h.decisionRows = mkRows('OPP_QUALIFY', 3);   // 近 24h：3 条（< min_sample 20）
    h.farRows = mkRows('OPP_QUALIFY', 25);       // 扩窗 168h：25 条（≥ 20）
    const rep = await runDecisionRetro({ windowHours: 24, dryRun: true, llmFactory: factory(() => async () => VALID_OUT([])) });

    expect(rep.window_extended).toBe(true);
    expect(rep.effective_window_hours).toBe(RETRO_CONFIG_DEFAULTS.window_extend_hours);
    expect(rep.decisions_scanned).toBe(25);
    expect(rep.summary.llm_effective).toBe(1);
    expect(h.calls.filter((c) => /FROM crm\.decision/.test(c.sql))).toHaveLength(2); // 原窗口 + 扩展窗口
  });

  it('样本充足 → 不扩窗（保持既有「dryRun 仅 2 次查询」契约）', async () => {
    h.decisionRows = mkRows('OPP_QUALIFY', 25);
    await runDecisionRetro({ windowHours: 24, dryRun: true, llmFactory: factory(() => async () => VALID_OUT([])) });
    expect(h.calls).toHaveLength(2);
    expect(h.calls.filter((c) => /FROM crm\.decision/.test(c.sql))).toHaveLength(1);
  });

  it('window_extend_enabled=false → 关闭自适应（尊重显式关停）', async () => {
    h.configValue = { window_extend_enabled: false };
    h.decisionRows = mkRows('OPP_QUALIFY', 3);
    const rep = await runDecisionRetro({ windowHours: 24, dryRun: true, llmFactory: factory(() => async () => VALID_OUT([])) });
    expect(rep.window_extended).toBe(false);
    expect(h.calls.filter((c) => /FROM crm\.decision/.test(c.sql))).toHaveLength(1);
  });
});

// ───────────────────────── R2：待办处方 knob 白名单 ─────────────────────────
describe('R2 · 待办处方 knob 白名单（原仅认 config_store → 真实处方 0 命中）', () => {
  it('required_dims / threshold / weight / edge_binding 等可 apply knob → 进待办', async () => {
    h.decisionRows = mkRows('OPP_QUALIFY', 25);
    const patches = [
      { knob: 'required_dims', target: 'OPP_QUALIFY', to_value: ['identity'], risk: 'LOW' },
      { knob: 'threshold', target: 'OPP_QUALIFY', to_value: 0.75, risk: 'MEDIUM' },
    ];
    await runDecisionRetro({ windowHours: 24, dryRun: false, llmFactory: factory(() => async () => VALID_OUT(patches)) });
    expect(h.savedPatches).toHaveLength(2);
    expect(h.savedPatches.map((p) => p.knob).sort()).toEqual(['required_dims', 'threshold']);
    expect(rep_todos()).toBe(2);
    function rep_todos() { return h.emitted.filter((e) => e.type === 'todo-created').length; }
  });

  it("knob='config_store' 但 target 无点号 → 不进待办（防整键替换清空配置）", async () => {
    h.decisionRows = mkRows('OPP_QUALIFY', 25);
    await runDecisionRetro({
      windowHours: 24, dryRun: false,
      llmFactory: factory(() => async () => VALID_OUT([{ knob: 'config_store', target: 'sales-thresholds', to_value: {}, risk: 'HIGH' }])),
    });
    expect(h.savedPatches).toHaveLength(0);
    expect(h.emitted.some((e) => e.type === 'retro-todo-skipped')).toBe(true);
  });

  it("knob='config_store' 且 target 为 '键名.子键' → 正常进待办", async () => {
    h.decisionRows = mkRows('OPP_QUALIFY', 25);
    await runDecisionRetro({
      windowHours: 24, dryRun: false,
      llmFactory: factory(() => async () => VALID_OUT([{ knob: 'config_store', target: 'precedent-conf.minSimilarity', from_value: 0.45, to_value: 0.4, risk: 'MEDIUM' }])),
    });
    expect(h.savedPatches).toHaveLength(1);
    expect(h.savedPatches[0].target).toBe('precedent-conf.minSimilarity');
  });

  it('未知 knob（无 apply 策略）→ 不进待办但留痕（防「可生成不可批准」闭环断点）', async () => {
    h.decisionRows = mkRows('OPP_QUALIFY', 25);
    await runDecisionRetro({
      windowHours: 24, dryRun: false,
      llmFactory: factory(() => async () => VALID_OUT([{ knob: 'not_a_real_knob', target: 'x', to_value: 1, risk: 'LOW' }])),
    });
    expect(h.savedPatches).toHaveLength(0);
    expect(h.emitted.some((e) => e.type === 'retro-todo-skipped')).toBe(true);
  });

  it('required_dims 缺 scenario_id → 不进待办（apply 会 UPDATE 空匹配、静默失效）', async () => {
    h.decisionRows = mkRows('OPP_QUALIFY', 25);
    await runDecisionRetro({
      windowHours: 24, dryRun: false,
      llmFactory: factory(() => async () => VALID_OUT([{ knob: 'required_dims', target: null, to_value: ['identity'], risk: 'LOW', scenario_id_override: null }])),
    });
    expect(h.savedPatches).toHaveLength(0);
  });
});

// ───────────────────────── R5：全局 deadline + 连续失败熔断 ─────────────────────────
describe('R5 · 全局 deadline 与连续失败熔断', () => {
  it('总时长预算耗尽 → 剩余簇走启发式降级，报告标 deadline_hit（不再无界串行）', async () => {
    h.configValue = { total_deadline_ms: 0, min_sample: 1 }; // 预算 0 → 首簇即判定超期
    h.decisionRows = [...mkRows('A', 5), ...mkRows('B', 5)];
    const f = factory(() => async () => VALID_OUT([]));
    const rep = await runDecisionRetro({ windowHours: 24, dryRun: true, llmFactory: f });
    expect(rep.summary.deadline_hit).toBe(true);
    expect(rep.summary.llm_effective).toBe(0);
    expect(rep.clusters).toHaveLength(2); // 仍产出聚类洞察（降级而非中断）
  });

  it('连续失败达阈值 → 熔断，后续簇不再调 LLM（避免整晚空耗）', async () => {
    h.configValue = { llm_fail_circuit: 2, min_sample: 1 };
    h.decisionRows = [...mkRows('A', 5), ...mkRows('B', 5), ...mkRows('C', 5)];
    let llmCalls = 0;
    const f = factory(() => async () => { llmCalls += 1; return null; }); // 恒返回 null（模拟超时/不可解析）
    const rep = await runDecisionRetro({ windowHours: 24, dryRun: true, llmFactory: f });
    expect(rep.summary.circuit_open).toBe(true);
    expect(llmCalls).toBeLessThan(3); // 熔断后不再调用
    expect(h.emitted.some((e) => e.type === 'decision-retro-circuit-open')).toBe(true);
  });

  it('未触发熔断时不误伤（连续失败未达阈值 → 继续尝试）', async () => {
    h.configValue = { llm_fail_circuit: 3, min_sample: 1 };
    h.decisionRows = [...mkRows('A', 5), ...mkRows('B', 5)];
    let llmCalls = 0;
    const f = factory(() => async () => { llmCalls += 1; return null; });
    const rep = await runDecisionRetro({ windowHours: 24, dryRun: true, llmFactory: f });
    expect(rep.summary.circuit_open).toBe(false);
    expect(llmCalls).toBe(2);
  });

  it('回归：合格簇 > 熔断阈值且 LLM 全部可信 → 不误熔断（a.llm_used 误判缺陷）', async () => {
    // 复现 2026-09-05 生产复跑：10 簇、多个合格簇、LLM 可信，旧代码用 a.llm_used（恒 undefined）
    //   → 每合格簇计失败、连续 3 即熔断 → circuit_open 恒真、llm_effective 被掐在 3。
    h.configValue = { llm_fail_circuit: 3, min_sample: 1 };
    h.decisionRows = [
      ...mkRows('A', 5), ...mkRows('B', 5), ...mkRows('C', 5),
      ...mkRows('D', 5), ...mkRows('E', 5),
    ];
    let llmCalls = 0;
    const f = factory(() => async () => { llmCalls += 1; return VALID_OUT([]); }); // 恒返回可信结果（非降级）
    const rep = await runDecisionRetro({ windowHours: 24, dryRun: true, llmFactory: f });
    expect(rep.summary.circuit_open).toBe(false); // 必须不误熔断
    expect(llmCalls).toBe(5);                      // 每个合格簇都应真实调 LLM
    expect(rep.summary.llm_effective).toBe(5);
  });
});
