// test/web/alertRuleConfig.test.js
import { test, expect, beforeEach } from 'vitest';
import {
  KIND_LABELS, kindLabel, renderCheckParams, renderAlertRules, alertRuleSummary, validateCheckParams,
} from '../../src/portal/alertRuleConfig.js';
import { createAlertRuleConfigRouter } from '../../src/portal/alertRuleConfig.js';
import { resetAlertRegistry, updateAlertRule } from '../../src/alerts/alertRegistry.js';

const RULES = [
  { kind: 'deal_stuck', match: { particleTypes: ['CRM_DEAL'], actions: ['stage_update'] }, check_params: { stuck_days: 30 }, severity: 'medium', target_role: 'sales', enabled: true, version: 1 },
  { kind: 'lead_overdue', match: { particleTypes: ['CRM_DEAL'], actions: ['followup'] }, check_params: { overdue_days: 30 }, severity: null, target_role: null, enabled: false, version: 1 },
];

test('KIND_LABELS / kindLabel', () => {
  expect(KIND_LABELS.deal_stuck).toBe('商机停滞');
  expect(kindLabel('lead_overdue')).toBe('线索逾期');
  expect(kindLabel('named_visit_overdue')).toBe('指名应访逾期');
  expect(kindLabel('unknown')).toBe('unknown');
});

test('renderCheckParams 渲染已知阈值字段', () => {
  const html = renderCheckParams('deal_stuck', { stuck_days: 30 });
  expect(html).toContain('stuck_days');
  expect(html).toContain('value="30"');
});

test('renderAlertRules 表格含 5 关键字段', () => {
  const html = renderAlertRules(RULES);
  expect(html).toContain('deal_stuck');
  expect(html).toContain('商机停滞');
  expect(html).toContain('checked'); // enabled 开关
  expect(html).toContain('severity');
  expect(html).toContain('target_role');
});

test('renderAlertRules 空态', () => {
  expect(renderAlertRules([])).toContain('尚未配置任何预警规则');
});

test('alertRuleSummary 统计', () => {
  expect(alertRuleSummary(RULES)).toEqual({ count: 2, enabled: 1 });
});

test('validateCheckParams 合法/非法', () => {
  expect(validateCheckParams({ stuck_days: 30 })).toBe(true);
  expect(validateCheckParams(null)).toBe(false);
  expect(validateCheckParams([1, 2])).toBe(false);
  expect(validateCheckParams('x')).toBe(false);
});

function makeDeps(over = {}) {
  const persisted = [];
  return {
    listRules: () => [{ kind: 'deal_stuck', check_params: { stuck_days: 30 }, enabled: true }],
    updateCache: (kind, patch) => updateAlertRule(kind, patch),
    persist: async (kind, patch) => { persisted.push({ kind, patch }); return { ok: true }; },
    produceDecision: async () => ({ decisionId: 'd-1', ok: true }),
    _persisted: persisted,
    ...over,
  };
}

beforeEach(() => resetAlertRegistry());

test('GET /api/alert-rules 返回 listRules', async () => {
  const router = createAlertRuleConfigRouter(makeDeps());
  let body = null;
  const res = { json: (p) => { body = p; return res; }, status: () => res };
  await router.handlers.list({}, res);
  expect(body.rules).toBeDefined();
  expect(Array.isArray(body.rules)).toBe(true);
});

test('PUT 未知 kind → 404', async () => {
  const router = createAlertRuleConfigRouter(makeDeps());
  let code = 0, body = null;
  const res = { status: (c) => { code = c; return { json: (p) => { body = p; } }; }, json: (p) => { body = p; } };
  await router.handlers.put({ params: { kind: 'nope' }, body: { enabled: false } }, res);
  expect(code).toBe(404);
  expect(body.error).toContain('rule_not_found');
});

test('PUT 合法 → updateCache + persist + 决策闸', async () => {
  const deps = makeDeps();
  const router = createAlertRuleConfigRouter(deps);
  let code = 0, body = null;
  const res = { status: (c) => { code = c; return { json: (p) => { body = p; } }; }, json: (p) => { body = p; } };
  await router.handlers.put({ params: { kind: 'deal_stuck' }, body: { enabled: false, check_params: { stuck_days: 45 } } }, res);
  expect(body.ok).toBe(true);
  expect(body.decision).toBe('d-1');
  expect(deps._persisted.length).toBe(1);
  expect(deps._persisted[0].kind).toBe('deal_stuck');
  // 缓存已改
  const updated = updateAlertRule('deal_stuck', {});
  expect(updated.rule.check_params.stuck_days).toBe(45);
  expect(updated.rule.enabled).toBe(false);
});

test('PUT check_params 非法 → 400', async () => {
  const router = createAlertRuleConfigRouter(makeDeps());
  let code = 0, body = null;
  const res = { status: (c) => { code = c; return { json: (p) => { body = p; } }; }, json: (p) => { body = p; } };
  await router.handlers.put({ params: { kind: 'deal_stuck' }, body: { check_params: 'bad' } }, res);
  expect(code).toBe(400);
  expect(body.error).toContain('对象');
});

test('无 DELETE 路由', () => {
  const router = createAlertRuleConfigRouter(makeDeps());
  expect(router.handlers.delete).toBeUndefined();
});
