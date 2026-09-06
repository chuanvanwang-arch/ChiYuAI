// test/portal/sevenDimRender.test.js — S20 七维矩阵渲染（parity + 校验 + 渲染）
// 浏览器模块零服务端 import（/sevenDimensions/* 未被静态托管），故用 Node 侧 import constants.js 断言 parity
import { describe, it, expect } from 'vitest';
import {
  SEVEN_KEYS, SEVEN_LABELS, ON_MISSING,
  toDimMap, toRequiredDims, validateRequiredDimsPatch, renderSevenDimMatrix,
} from '../../src/portal/sevenDimRender.js';
import { SEVEN_DIMS, DIM_KEYS } from '../../src/sevenDimensions/constants.js';

describe('单一事实源 parity（禁止另写维表）', () => {
  it('SEVEN_KEYS 与 constants.DIM_KEYS 逐键一致', () => {
    expect(SEVEN_KEYS).toEqual(DIM_KEYS);
    expect(SEVEN_KEYS).toEqual(SEVEN_DIMS.map((d) => d.key));
  });
  it('SEVEN_LABELS 覆盖全部维', () => {
    for (const k of SEVEN_KEYS) expect(SEVEN_LABELS[k]).toBeTruthy();
  });
  it('ON_MISSING 与后端 decisionScenario.ON_MISSING 一致', async () => {
    const { ON_MISSING: back } = await import('../../src/portal/decisionScenario.js');
    expect(ON_MISSING).toEqual(back);
  });
});

describe('toDimMap / toRequiredDims 往返', () => {
  it('required_dims → map → required_dims 无损', () => {
    const rd = [{ dim: 'identity', on_missing: 'block' }, { dim: 'semantics', on_missing: 'warn' }];
    expect(toDimMap(rd)).toEqual({ identity: 'block', semantics: 'warn' });
    expect(toRequiredDims(toDimMap(rd))).toEqual(rd);
  });
  it('非法/缺失 on_missing 降级为 warn', () => {
    expect(toDimMap([{ dim: 'identity', on_missing: 'nuke' }])).toEqual({ identity: 'warn' });
    expect(toDimMap([{ dim: 'identity' }])).toEqual({ identity: 'warn' });
  });
  it('非数组输入不崩溃', () => {
    expect(toDimMap(null)).toEqual({});
    expect(toDimMap({ risk: 'low' })).toEqual({});
  });
  it('未配置的维不出现在 required_dims', () => {
    expect(toRequiredDims({ identity: 'warn', structure: '' })).toEqual([{ dim: 'identity', on_missing: 'warn' }]);
  });
});

describe('validateRequiredDimsPatch', () => {
  it('合法通过', () => {
    const v = validateRequiredDimsPatch([{ dim: 'identity', on_missing: 'block' }, { dim: 'structure' }]);
    expect(v.ok).toBe(true);
    expect(v.normalized).toEqual([{ dim: 'identity', on_missing: 'block' }, { dim: 'structure', on_missing: 'warn' }]);
  });
  it('空数组合法（清空全部要求）', () => {
    expect(validateRequiredDimsPatch([]).ok).toBe(true);
    expect(validateRequiredDimsPatch([]).normalized).toEqual([]);
  });
  it('未知维度 → 拒绝', () => {
    const v = validateRequiredDimsPatch([{ dim: 'context' }]);
    expect(v.ok).toBe(false);
    expect(v.errors.join()).toContain('未知维度');
  });
  it('重复维度 → 拒绝', () => {
    expect(validateRequiredDimsPatch([{ dim: 'identity' }, { dim: 'identity' }]).ok).toBe(false);
  });
  it('非数组 → 拒绝', () => {
    expect(validateRequiredDimsPatch('identity').ok).toBe(false);
  });
});

describe('renderSevenDimMatrix', () => {
  const payload = {
    dims: SEVEN_DIMS.map((d) => ({ key: d.key, label: d.label, desc: d.desc })),
    scenarios: [
      { scenario_id: 'QUOTE_PRICING', stage: '四、商务报价', default_tier: 'HIGH', autonomous_allowed: false,
        required_dims: [{ dim: 'identity', on_missing: 'block' }] },
      { scenario_id: 'LEAD_FOLLOW_UP', stage: '一、线索', default_tier: 'LEAD', autonomous_allowed: true, required_dims: [] },
    ],
    default_strictness: 'warn',
  };

  it('渲染表头 7 维 + 全局严格度 select', () => {
    const html = renderSevenDimMatrix(payload);
    expect(html).toContain('id="sd7-strict"');
    for (const k of SEVEN_KEYS) expect(html).toContain(`data-dim="${k}"`);
  });

  it('每行渲染场景 + 已配置的严格度选中', () => {
    const html = renderSevenDimMatrix(payload);
    expect(html).toContain('data-id="QUOTE_PRICING"');
    expect(html).toContain('data-id="LEAD_FOLLOW_UP"');
    expect(html).toContain('value="block" selected');
    expect(html).toContain('四、商务报价');
    expect(html).toContain('HIGH');
  });

  it('空场景列表仍渲染表格（空态可操作）', () => {
    const html = renderSevenDimMatrix({ ...payload, scenarios: [] });
    expect(html).toContain('id="sd7-matrix"');
    expect(html).toContain('暂无决策场景');
  });

  it('dims 缺省时回退本地 SEVEN_KEYS', () => {
    const html = renderSevenDimMatrix({ scenarios: payload.scenarios, default_strictness: 'block' });
    for (const k of SEVEN_KEYS) expect(html).toContain(`data-dim="${k}"`);
  });

  it('阶段名 HTML 转义', () => {
    const html = renderSevenDimMatrix({ ...payload, scenarios: [{ scenario_id: 'X', stage: '<img src=x>', default_tier: 'HIGH', required_dims: [] }] });
    expect(html).not.toContain('<img src=x>');
    expect(html).toContain('&lt;img');
  });
});