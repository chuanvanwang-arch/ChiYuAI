// test/calibration/paramInspector.test.js — 参数巡检器单测（P0 参数闭环）
// 覆盖：22 项声明完整 / judge 确定性判据 / suggest 目标值 / buildSample 指标计算 /
//       context-routing 红线（只 review 不出 patches）/ fail-open 单键 / DEFAULT_KNOB_MAP 护栏配置
// 铁律：确定性无 LLM；样本不足不出 adjust；禁 DELETE。
import { describe, it, expect, vi } from 'vitest';

// 隔离 db/configStore（不碰真实 PG）
vi.mock('../../src/db.js', () => ({ query: vi.fn().mockResolvedValue({ rows: [] }) }));
vi.mock('../../src/config/configStore.js', () => ({
  readConfig: vi.fn().mockImplementation(async (key) => {
    if (key === 'autonomy-conf') return { value: { threshold: 0.7, weights: {} } };
    if (key === 'rubric-thresholds') return { value: { good: 0.75 } };
    return { value: null };
  }),
}));

const mod = await import('../../src/calibration/paramInspector.js');
const { PARAM_ITEMS, judge, suggest, buildSample, DEFAULT_KNOB_MAP, inspectAll, DEFAULT_INSPECT_CFG } = mod;

describe('参数巡检器（paramInspector）', () => {
  it('PARAM_ITEMS 声明 26 项（含九尺子扩展 4 项），覆盖核心参数键', () => {
    expect(Array.isArray(PARAM_ITEMS)).toBe(true);
    expect(PARAM_ITEMS.length).toBe(26);
    const keys = [...new Set(PARAM_ITEMS.map((i) => i.key))];
    // 覆盖核心决策链键 + 九尺子扩展键（作为抽样）
    for (const k of [
      'autonomy-conf', 'rubric-thresholds', 'rubric-weights', 'precedent-conf',
      'sales-thresholds', 'approval-config', 'decision-retro', 'llm',
      'rubric-llm', 'rubric-scenario-focus', 'rubric-scenario-subset', 'rubric-scenario-passline',
    ]) {
      expect(keys).toContain(k);
    }
  });

  it('九尺子扩展：rubric-llm + 场景级 focus/subset/passline 共 4 项接入，场景级 verdict=review 不出处方', async () => {
    const out = await inspectAll({
      tenantId: 'system',
      query: async (sql) => {
        if (String(sql).includes('crm.decision_scenario')) {
          return { rows: [
            { scenario_id: 'A', focus_rulers: [{ key: 'clarity', weight: 1.5 }], enabled_rulers: ['clarity', 'accuracy'], rubric_pass_line: 0.6 },
            { scenario_id: 'B', focus_rulers: null, enabled_rulers: null, rubric_pass_line: 0.7 },
          ] };
        }
        if (String(sql).includes('crm.decision')) return { rows: [] };
        if (String(sql).includes('crm.calibration_patch')) return { rows: [] };
        return { rows: [] };
      },
    });
    const scenarioKeys = ['rubric-llm', 'rubric-scenario-focus', 'rubric-scenario-subset', 'rubric-scenario-passline'];
    for (const k of scenarioKeys) {
      expect(out.items.find((i) => i.key === k), `缺少九尺子项 ${k}`).toBeTruthy();
    }
    // 场景级 3 项：仅观测 review，绝不生成 PENDING 处方（守住禁自动 apply 红线）
    for (const k of ['rubric-scenario-focus', 'rubric-scenario-subset', 'rubric-scenario-passline']) {
      const it = out.items.find((i) => i.key === k);
      expect(it.verdict).toBe('review');
      expect(out.patches.every((p) => !String(p.target).startsWith(k))).toBe(true);
    }
    // rubric-llm：config_store 缺省 → valueOf(null) → 无 rule → healthy/keep
    const llm = out.items.find((i) => i.key === 'rubric-llm');
    expect(llm.verdict).toBe('keep');
    // 聚合值正确：focus 1/2、subset 1/2、passline min0.6/max0.7/avg0.65
    const focus = out.items.find((i) => i.key === 'rubric-scenario-focus');
    expect(focus.current).toBe('1/2');
    const subset = out.items.find((i) => i.key === 'rubric-scenario-subset');
    expect(subset.current).toBe('1/2');
    const passline = out.items.find((i) => i.key === 'rubric-scenario-passline');
    expect(passline.current).toContain('min 0.6');
    expect(passline.current).toContain('max 0.7');
    expect(passline.current).toContain('avg 0.65');
  });

  it('judge：命中 adjust_if → drift/adjust，未命中 → healthy/keep', () => {
    const spec = PARAM_ITEMS.find((i) => i.key === 'autonomy-conf' && i.param === 'threshold');
    const cfg = DEFAULT_INSPECT_CFG;
    // 覆写率高（且 adopted>0，对齐 buildSample 语义）→ drift/adjust
    expect(judge(spec, 0.7, { adopted: 10, override_rate: 0.4, escalate_rate: 0.1, fatigue_rate: 0 }, cfg)).toEqual({ health: 'drift', verdict: 'adjust' });
    // 健康 → keep
    expect(judge(spec, 0.7, { adopted: 10, override_rate: 0.1, escalate_rate: 0.1, fatigue_rate: 0 }, cfg)).toEqual({ health: 'healthy', verdict: 'keep' });
  });

  it('suggest：threshold 下调 0.05（覆盖率高时）', () => {
    const spec = PARAM_ITEMS.find((i) => i.key === 'autonomy-conf' && i.param === 'threshold');
    const cfg = DEFAULT_INSPECT_CFG;
    const s = { adopted: 10, override_rate: 0.4, escalate_rate: 0.1, fatigue_rate: 0 };
    // 0.7 - 0.05 = 0.65（浮点：用 closeTo）
    expect(suggest(spec, 0.7, s, cfg)).toBeCloseTo(0.65, 5);
  });

  it('buildSample：adopted/override/biz_fail_rate/hit_rate 计算正确', () => {
    const rows = [
      { scenario_id: 'A', human_disposition: 'OVERRIDDEN', outcome_verified: 'lost', attribution: { category: 'precedent' } },
      { scenario_id: 'A', human_disposition: null, outcome_verified: 'won', attribution: { category: 'precedent' } },
      { scenario_id: 'A', human_disposition: null, outcome_verified: 'stalled', attribution: {} },
    ];
    const s = buildSample(rows);
    expect(s.sample_size).toBe(3);
    expect(s.adopted).toBe(2); // 仅 2 条非 OVERRIDDEN
    expect(s.biz_fail_rate).toBeCloseTo(1 / 2, 5); // adopted=2，失败=stalled 1 条（OVERridden 不计入 adopted）
    expect(s.hit_rate).toBeCloseTo(2 / 3, 5); // 3 条中 2 条 attribution.category=precedent
  });

  it('context-routing 红线：inspectAll 该键只 review，不出 patches', async () => {
    const out = await inspectAll({ tenantId: 'system', query: async () => ({ rows: [] }) });
    const cr = out.items.find((i) => i.key === 'context-routing');
    expect(cr).toBeTruthy();
    expect(cr.verdict).toBe('review');
    // context-routing 不出 adjust 处方（A/B 由 routingReview 独立闭环）
    expect(out.patches.every((p) => !String(p.target).startsWith('context-routing'))).toBe(true);
  });

  it('fail-open：无 rule 键兜底 healthy/keep（不阻断其余键）', () => {
    const spec = PARAM_ITEMS.find((i) => i.key === 'billing-plans');
    const cfg = DEFAULT_INSPECT_CFG;
    expect(judge(spec, null, {}, cfg)).toEqual({ health: 'healthy', verdict: 'keep' });
  });

  it('DEFAULT_KNOB_MAP：prescribe 护栏驱动配置含 max/min_step', () => {
    expect(Array.isArray(DEFAULT_KNOB_MAP.knob_map)).toBe(true);
    const first = DEFAULT_KNOB_MAP.knob_map[0];
    expect(first).toMatchObject({ root_cause_class: 'PARAM_DRIFT', max_step: 0.05, min_step: 0.01 });
    expect(first.sensitivity_k).toBeGreaterThan(0);
  });

  it('readKnobMap 兜底：DB 返回空 knob_map([]) 必须回退 DEFAULT_KNOB_MAP（否则静默抑制全部出厂旋钮→自动处方恒 0）', async () => {
    const { readKnobMap } = mod;
    const cfg = await import('../../src/config/configStore.js');
    vi.mocked(cfg.readConfig).mockImplementationOnce(async (key) => {
      if (key === 'retro-knob-map') return { value: { knob_map: [] } }; // 生产库实测：空数组曾致全抑制
      return { value: null };
    });
    const km = await readKnobMap({ tenantId: 'system' });
    expect(km).toBe(DEFAULT_KNOB_MAP);
    expect(Array.isArray(km.knob_map) && km.knob_map.length).toBeGreaterThan(0);
  });

  it('处方 value 契约：to_value/from_value 为子键裸值（非 {param:val} 包裹）—— ConfigStoreStrategy.apply 直接赋 next[sub]=toValue，包裹会写成嵌套对象', async () => {
    // 造一个 adjust 场景：autonomy-conf.threshold 覆写率高 → drift/adjust + suggest 0.65
    const spec = PARAM_ITEMS.find((i) => i.key === 'autonomy-conf' && i.param === 'threshold');
    const cfg = { ...DEFAULT_INSPECT_CFG, ...{ rules: { 'autonomy-conf.threshold': DEFAULT_INSPECT_CFG.rules['autonomy-conf.threshold'] } } };
    // 手工执行 inspectAll 的处方生成路径：adjust + suggest + prescribe 命中 → patches[0]
    // 复用 judge/suggest 确认值，再从 inspectAll 走真实链路
    const out = await inspectAll({
      tenantId: 'system',
      query: async (sql, params) => {
        // decisions：样本带 adopted+覆写高 → autonomy drift
        if (String(sql).includes('crm.decision')) return { rows: [
          { scenario_id: 'A', human_disposition: 'OVERRIDDEN', outcome_verified: 'lost' },
          { scenario_id: 'A', human_disposition: null, outcome_verified: 'won' },
        ] };
        return { rows: [] };
      },
    });
    const p = out.patches.find((x) => x.target === 'autonomy-conf.threshold');
    expect(p).toBeTruthy();
    // 裸值契约：to_value 是数字（非 {threshold:0.65} 包裹对象）
    expect(typeof p.to_value).toBe('number');
    expect(p.from_value).toBe(0.7); // 裸数字
  });

  it('Bug B 回归：rubric-thresholds.good verdict=adjust 时必须产出 PENDING 处方（不被 prescribe measured=0 抑制）', async () => {
    const out = await inspectAll({
      tenantId: 'system',
      query: async (sql) => {
        if (String(sql).includes('crm.decision')) {
          // 场景 A：10 行中 3 行 won → scene_pass_rate=0.3 → |0.3-0.75|=0.45>0.2 → adjust
          const rows = [];
          for (let i = 0; i < 3; i++) rows.push({ scenario_id: 'A', human_disposition: null, outcome_verified: 'won' });
          for (let i = 0; i < 7; i++) rows.push({ scenario_id: 'A', human_disposition: null, outcome_verified: 'lost' });
          return { rows };
        }
        return { rows: [] };
      },
    });
    const p = out.patches.find((x) => x.target === 'rubric-thresholds.good');
    expect(p).toBeTruthy();
    // 裸值契约：to_value 是数字（非 {good:0.6} 包裹对象）
    expect(typeof p.to_value).toBe('number');
    expect(p.from_value).toBe(0.75);
    // suggest 目标 = clamp(0.75 + (0.3-0.75)*0.5) = clamp(0.525) → max(0.6,..)=0.6
    expect(p.to_value).toBeCloseTo(0.6, 5);
    expect(p.risk).toBe('MEDIUM');
  });
});
