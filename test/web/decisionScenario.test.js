import { test, expect } from 'vitest';
import {
  validateScenarioPatch,
  renderDecisionScenarios,
  createDecisionScenarioRouter,
  EDITABLE_FIELDS,
  TIERS,
  DISPOSITIONS,
  ON_MISSING,
} from '../../src/portal/decisionScenario.js';
// 浏览器实际加载的是 Render 子模块（零 Node-only import），须与 decisionScenario.js 同口径防御
import * as render from '../../src/portal/decisionScenarioRender.js';

// ---- 纯函数：validateScenarioPatch ----
test('validateScenarioPatch 合法 description 通过', () => {
  const r = validateScenarioPatch({ description: '跟不跟/升级/放弃' });
  expect(r.ok).toBe(true);
  expect(r.normalized.description).toBe('跟不跟/升级/放弃');
});

test('validateScenarioPatch default_tier 非法 → 拒绝', () => {
  const r = validateScenarioPatch({ default_tier: 'XXX' });
  expect(r.ok).toBe(false);
  expect(r.errors.join()).toContain('default_tier');
});

test('validateScenarioPatch 含锁定字段 scenario_id → 拒绝', () => {
  const r = validateScenarioPatch({ scenario_id: 'LEAD_FOLLOW_UP', description: 'x' });
  expect(r.ok).toBe(false);
  expect(r.errors.join()).toContain('不可编辑字段');
});

test('validateScenarioPatch eval_dimensions 坏 JSON 串 → 拒绝', () => {
  const r = validateScenarioPatch({ eval_dimensions: '{not json' });
  expect(r.ok).toBe(false);
  expect(r.errors.join()).toContain('eval_dimensions');
});

test('validateScenarioPatch eval_dimensions 数组项缺 weight → 拒绝', () => {
  const r = validateScenarioPatch({ eval_dimensions: [{ cond: 'a', label: 'A' }] });
  expect(r.ok).toBe(false);
  expect(r.errors.join()).toContain('eval_dimensions');
});

test('validateScenarioPatch 全白名单字段归类正确', () => {
  expect(EDITABLE_FIELDS).toEqual([
    'description', 'methodology_ids', 'eval_dimensions', 'default_tier', 'autonomous_allowed', 'dispositions',
    'required_dims', 'focus_rulers', 'rubric_pass_line', 'enabled_rulers',
  ]);
  expect(TIERS).toEqual(['LEAD', 'NORMAL', 'HIGH']);
  expect(DISPOSITIONS).toEqual(['APPROVE', 'REJECT', 'ESCALATE', 'OVERRIDE', 'EXCEPTION']);
  expect(ON_MISSING).toEqual(['warn', 'block']);
});

test('validateScenarioPatch required_dims 合法 → 通过', () => {
  const r = validateScenarioPatch({ required_dims: [{ dim: 'identity', on_missing: 'block' }, { dim: 'structure' }] });
  expect(r.ok).toBe(true);
  expect(r.normalized.required_dims).toEqual([
    { dim: 'identity', on_missing: 'block' },
    { dim: 'structure', on_missing: 'warn' },
  ]);
});

test('validateScenarioPatch required_dims 未知维度 → 拒绝', () => {
  const r = validateScenarioPatch({ required_dims: [{ dim: 'context', on_missing: 'warn' }] });
  expect(r.ok).toBe(false);
  expect(r.errors.join()).toContain('未知维度');
});

test('validateScenarioPatch required_dims 重复维度 → 拒绝', () => {
  const r = validateScenarioPatch({ required_dims: [{ dim: 'identity' }, { dim: 'identity' }] });
  expect(r.ok).toBe(false);
  expect(r.errors.join()).toContain('重复');
});

test('validateScenarioPatch required_dims 非法 on_missing → 拒绝', () => {
  const r = validateScenarioPatch({ required_dims: [{ dim: 'identity', on_missing: 'nuke' }] });
  expect(r.ok).toBe(false);
  expect(r.errors.join()).toContain('on_missing');
});

test('validateScenarioPatch required_dims 非数组 → 拒绝', () => {
  expect(validateScenarioPatch({ required_dims: 'identity' }).ok).toBe(false);
});

// ---- B 2026-09-04：差异化评分三字段校验 ----
test('validateScenarioPatch focus_rulers/enabled_rulers/rubric_pass_line 合法 → 通过', () => {
  const r = validateScenarioPatch({
    focus_rulers: [{ key: 'clarity', weight: 1.5 }, { key: 'relevance' }],
    enabled_rulers: ['clarity', 'relevance', 'logic', 'importance'],
    rubric_pass_line: 0.6,
  });
  expect(r.ok).toBe(true);
  expect(r.normalized.focus_rulers).toEqual([{ key: 'clarity', weight: 1.5 }, { key: 'relevance' }]);
  expect(r.normalized.enabled_rulers).toEqual(['clarity', 'relevance', 'logic', 'importance']);
  expect(r.normalized.rubric_pass_line).toBe(0.6);
});

test('validateScenarioPatch enabled_rulers 越界值（非尺子 key 形态）→ 拒绝', () => {
  const r = validateScenarioPatch({ enabled_rulers: [{ key: 123 }] });
  expect(r.ok).toBe(false);
  expect(r.errors.join()).toContain('enabled_rulers');
});

test('validateScenarioPatch rubric_pass_line 超范围 → 拒绝', () => {
  expect(validateScenarioPatch({ rubric_pass_line: 1.5 }).ok).toBe(false);
  expect(validateScenarioPatch({ rubric_pass_line: -0.1 }).ok).toBe(false);
});

// ---- 纯函数：renderDecisionScenarios ----
const SCENARIOS = [
  { scenario_id: 'LEAD_FOLLOW_UP', stage: '一、线索', description: '新线索跟不跟', default_tier: 'LEAD', autonomous_allowed: true,
    methodology_ids: ['BANT'], eval_dimensions: [{ cond: 'industry_fit', label: '行业匹配', weight: 0.2 }], dispositions: ['APPROVE', 'REJECT'] },
  { scenario_id: 'OPP_QUALIFY', stage: '二、机会评估', description: '真机会/伪需求', default_tier: 'NORMAL', autonomous_allowed: false,
    methodology_ids: ['MEDDICC'], eval_dimensions: [], dispositions: ['APPROVE', 'ESCALATE'] },
];

test('renderDecisionScenarios 按 stage 分组 + 含场景卡', () => {
  const html = renderDecisionScenarios(SCENARIOS);
  expect(html).toContain('data-stage="一、线索"');
  expect(html).toContain('data-id="LEAD_FOLLOW_UP"');
  expect(html).toContain('LEAD'); // tier badge
  expect(html).toContain('industry_fit'); // eval_dimensions chip
  expect(html).toContain('编辑'); // 编辑按钮
});

test('renderDecisionScenarios 空 → 降级', () => {
  expect(renderDecisionScenarios([])).toContain('无决策场景配置');
});

// ---- 回归：eval_dimensions 非数组（历史/演示数据曾写入 JSONB 对象 {"risk":"low"}）----
// 根因：(s.eval_dimensions || []).map 中 || [] 只对 falsy 兜底，对象是 truthy → .map is not a function → 整页「加载失败」
const BAD_EVAL = [
  { scenario_id: 'SC_DEMO_DISCOUNT', stage: 'contract', description: '合同折扣审批', default_tier: 'NORMAL',
    autonomous_allowed: false, methodology_ids: ['method-bant'], eval_dimensions: { risk: 'low' }, dispositions: ['APPROVE'] },
  { scenario_id: 'SC_DEMO_TERMS', stage: 'payment', description: '账期放宽例外', default_tier: 'HIGH',
    autonomous_allowed: false, methodology_ids: ['method-risk-tradeoff'], eval_dimensions: '{"risk":"medium"}', dispositions: ['EXCEPTION'] },
];

for (const [label, fn] of [['decisionScenario', renderDecisionScenarios], ['decisionScenarioRender', render.renderDecisionScenarios]]) {
  test(`renderDecisionScenarios[${label}] eval_dimensions 为对象 → 降级不崩溃`, () => {
    const html = fn(BAD_EVAL);
    expect(html).toContain('data-id="SC_DEMO_DISCOUNT"');
    expect(html).not.toContain('undefined');
  });

  test(`renderDecisionScenarios[${label}] eval_dimensions 为 JSON 数组字符串 → 正常渲染`, () => {
    const html = fn([{ ...BAD_EVAL[1], eval_dimensions: '[{"cond":"payment_days","label":"账期天数","weight":0.35}]' }]);
    expect(html).toContain('payment_days');
    expect(html).toContain('账期天数');
  });

  test(`renderDecisionScenarios[${label}] methodology_ids/dispositions 非数组 → 降级不崩溃`, () => {
    const html = fn([{ ...BAD_EVAL[0], methodology_ids: null, dispositions: null, eval_dimensions: null }]);
    expect(html).toContain('data-id="SC_DEMO_DISCOUNT"');
    expect(html).toContain('—');
  });
}

// ---- handler 单测（注入假 deps，8 行模拟 seed）----
const SEED_SCENARIOS = [
  ...SCENARIOS,
  { scenario_id: 'SOLUTION_VALUE', stage: '三、方案价值', description: '方案取舍', default_tier: 'NORMAL', autonomous_allowed: false, methodology_ids: ['OPP_MATRIX'], eval_dimensions: [], dispositions: ['APPROVE'] },
  { scenario_id: 'QUOTE_PRICING', stage: '四、商务报价', description: '三级报价', default_tier: 'HIGH', autonomous_allowed: false, methodology_ids: ['RISK_TRADEOFF'], eval_dimensions: [], dispositions: ['APPROVE', 'ESCALATE'] },
  { scenario_id: 'SIGN_RISK', stage: '五、签单前风险', description: '卡住策略', default_tier: 'HIGH', autonomous_allowed: false, methodology_ids: ['STOP_LOSS'], eval_dimensions: [], dispositions: ['ESCALATE'] },
  { scenario_id: 'POST_CONTRACT', stage: '六、签约后', description: '回款策略', default_tier: 'NORMAL', autonomous_allowed: true, methodology_ids: ['RISK_TRADEOFF'], eval_dimensions: [], dispositions: ['APPROVE'] },
  { scenario_id: 'LOSS_REVIEW', stage: '七、丢单复盘', description: '放弃/孵化', default_tier: 'LEAD', autonomous_allowed: true, methodology_ids: ['FACT_VS_TALK'], eval_dimensions: [], dispositions: ['APPROVE', 'REJECT'] },
  { scenario_id: 'ATTR_SCHEMA_CHANGE', stage: 'meta', description: '元模型变更', default_tier: 'HIGH', autonomous_allowed: false, methodology_ids: [], eval_dimensions: [], dispositions: ['APPROVE'] },
];

function makeDeps(over = {}) {
  const rows = {};
  for (const s of SEED_SCENARIOS) rows[s.scenario_id] = { ...s };
  const deps = {
    listScenarios: async () => Object.values(rows).map((r) => ({ ...r })),
    listSkillIds: async () => ['BANT', 'MEDDICC', 'OPP_MATRIX', 'RISK_TRADEOFF', 'STOP_LOSS', 'FACT_VS_TALK'],
    updateScenario: async (scenario_id, patch) => {
      rows[scenario_id] = { ...rows[scenario_id], ...patch };
      return rows[scenario_id];
    },
    produceDecision: over.produceDecision || (async () => ({ decisionId: 'd-test' })),
  };
  return deps;
}

test('GET /api/decision-scenarios 返回 8 场景含 LEAD_FOLLOW_UP', async () => {
  const router = createDecisionScenarioRouter(makeDeps());
  let captured = null;
  const res = { json: (x) => { captured = x; return x; } };
  await router.handlers.get({}, res);
  expect(captured.scenarios.length).toBe(8);
  expect(captured.scenarios.map((s) => s.scenario_id)).toContain('LEAD_FOLLOW_UP');
});

test('PUT 改 description 落库 + 产出 decision', async () => {
  let decided = null;
  const deps = makeDeps({ produceDecision: async (d) => { decided = d; return { decisionId: 'd-x' }; } });
  const router = createDecisionScenarioRouter(deps);
  let captured = null;
  const res = { json: (x) => { captured = x; return x; } };
  await router.handlers.put({ body: { scenario_id: 'LEAD_FOLLOW_UP', patch: { description: '修订描述' } } }, res);
  expect(captured.ok).toBe(true);
  expect(captured.row.description).toBe('修订描述');
  expect(captured.decision).toBe('d-x');
  expect(decided.scenario_id).toBe('LEAD_FOLLOW_UP');
});

test('PUT default_tier 非法 → 400', async () => {
  const router = createDecisionScenarioRouter(makeDeps());
  let status = null;
  const res = { status: (s) => { status = s; return { json: () => {} }; } };
  await router.handlers.put({ body: { scenario_id: 'LEAD_FOLLOW_UP', patch: { default_tier: 'XXX' } } }, res);
  expect(status).toBe(400);
});

test('PUT 含锁定字段 → 400', async () => {
  const router = createDecisionScenarioRouter(makeDeps());
  let status = null;
  const res = { status: (s) => { status = s; return { json: () => {} }; } };
  await router.handlers.put({ body: { scenario_id: 'LEAD_FOLLOW_UP', patch: { scenario_id: 'y', description: 'x' } } }, res);
  expect(status).toBe(400);
});

test('PUT 悬空 methodology_ids → 400', async () => {
  const router = createDecisionScenarioRouter(makeDeps());
  let status = null;
  const res = { status: (s) => { status = s; return { json: () => {} }; } };
  await router.handlers.put({ body: { scenario_id: 'LEAD_FOLLOW_UP', patch: { methodology_ids: ['NO_SUCH'] } } }, res);
  expect(status).toBe(400);
});

test('PUT 缺 scenario_id → 400', async () => {
  const router = createDecisionScenarioRouter(makeDeps());
  let status = null;
  const res = { status: (s) => { status = s; return { json: () => {} }; } };
  await router.handlers.put({ body: { patch: { description: 'x' } } }, res);
  expect(status).toBe(400);
});
