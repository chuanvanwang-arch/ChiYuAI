import { test, expect } from 'vitest';
import { LLM_FIELDS, validateLlmPatch, renderLlmForm } from '../../src/portal/llmConfigRender.js';
import { SEVEN_KEYS, validateRequiredDimsPatch, renderSevenDimMatrix } from '../../src/portal/sevenDimRender.js';
import { POOL_KEYS, validatePoolPatch, renderPoolTabs } from '../../src/portal/poolConfigRender.js';

// —— LLM ——
test('LLM_FIELDS 白名单', () => {
  expect(LLM_FIELDS).toEqual(expect.arrayContaining(['provider', 'model', 'temp']));
});
test('validateLlmPatch 合法/非法', () => {
  expect(validateLlmPatch({ provider: 'siliconflow', model: 'deepseek-v4', temp: 0.7 }).ok).toBe(true);
  expect(validateLlmPatch({ unknown: 1 }).ok).toBe(false);
  expect(validateLlmPatch({ temp: 99 }).ok).toBe(false); // temp 越界
});
test('renderLlmForm 含 provider select + temp 输入', () => {
  const html = renderLlmForm({ provider: 'siliconflow', model: 'deepseek-v4', temp: 0.7 });
  expect(html).toContain('provider');
  expect(html).toContain('deepseek-v4');
  expect(html).toContain('temp');
});
test('renderLlmForm 未配置空态', () => {
  expect(renderLlmForm(null)).toContain('未配置');
});

// —— 七维（S20 场景×七维矩阵形态）——
test('SEVEN_KEYS 白名单（与引擎单一事实源一致）', () => {
  expect(SEVEN_KEYS).toEqual(expect.arrayContaining(['identity', 'governance']));
});
test('validateRequiredDimsPatch 合法/非法', () => {
  expect(validateRequiredDimsPatch([{ dim: 'identity', on_missing: 'warn' }]).ok).toBe(true);
  expect(validateRequiredDimsPatch([{ dim: 'unknown' }]).ok).toBe(false);
  expect(validateRequiredDimsPatch('identity').ok).toBe(false);
});
test('renderSevenDimMatrix 含维度列 + 场景行', () => {
  const html = renderSevenDimMatrix({
    dims: SEVEN_KEYS.map((k) => ({ key: k, label: k })),
    scenarios: [{ scenario_id: 'LEAD_FOLLOW_UP', stage: '一、线索', default_tier: 'LEAD', required_dims: [] }],
  });
  expect(html).toContain('data-dim="identity"');
  expect(html).toContain('data-id="LEAD_FOLLOW_UP"');
});

// —— 池 ——
// 2026-09-11 T5 契约迁移：原断言锁定 pickRule/recycleAfterDays，与引擎实际消费键
//   （pool.js checkPickRule/checkRecycleRule）不对齐——页面改的键引擎不认。按设计改为对齐键集。
test('POOL_KEYS 白名单（与引擎消费键对齐）', () => {
  expect(POOL_KEYS).toEqual(expect.arrayContaining(['daily_limit', 'pick_interval_hours', 'prev_owner_only', 'new_data_only', 'recycle_days']));
});
test('validatePoolPatch 合法/非法', () => {
  expect(validatePoolPatch({ daily_limit: 10, recycle_days: 30 }).ok).toBe(true);
  expect(validatePoolPatch({ unknown: 1 }).ok).toBe(false);
  expect(validatePoolPatch({ recycle_days: -1 }).ok).toBe(false);
  expect(validatePoolPatch({ daily_limit: 0 }).ok).toBe(false);
});
test('renderPoolTabs 含三池 TAB + 引擎键输入', () => {
  const html = renderPoolTabs({ pools: [{ id: 'pool-new', type: 'new', label: '新线索公海', pick_rule: { daily_limit: 10 }, recycle_rule: { recycle_days: 30 } }] });
  expect(html).toContain('data-pool="pool-new"');
  expect(html).toContain('daily_limit');
  expect(html).toContain('recycle_days');
});