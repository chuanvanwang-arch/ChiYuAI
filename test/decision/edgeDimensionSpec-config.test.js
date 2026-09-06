// test/decision/edgeDimensionSpec-config.test.js — T32 边绑定配置加载（运行时接线）
// 契约：loadEdgeDimensionSpecFromConfig(value)：
//   · value.edge_bindings 非空数组 → 校验通过则返回该 spec（不通过→回退默认+errors 提示）
//   · 无配置 / 非数组 / 空数组 / 校验失败 → 回退 DEFAULT_EDGE_DIMENSION_SPEC
// 纯函数（传入 config 值即可，不碰 DB），供 relation.js 写边时加载覆盖。
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_EDGE_DIMENSION_SPEC,
  loadEdgeDimensionSpecFromConfig,
  primaryDimension,
} from '../../src/decision/edgeDimensionSpec.js';

const FULL = DEFAULT_EDGE_DIMENSION_SPEC;

describe('T32 loadEdgeDimensionSpecFromConfig', () => {
  it('无配置 / undefined → 默认 spec', () => {
    expect(loadEdgeDimensionSpecFromConfig(undefined).spec).toBe(DEFAULT_EDGE_DIMENSION_SPEC);
    expect(loadEdgeDimensionSpecFromConfig(null).spec).toBe(DEFAULT_EDGE_DIMENSION_SPEC);
    expect(loadEdgeDimensionSpecFromConfig({}).spec).toBe(DEFAULT_EDGE_DIMENSION_SPEC);
  });

  it('cfg.edge_bindings 合法 → 返回配置 spec', () => {
    const r = loadEdgeDimensionSpecFromConfig({ edge_bindings: FULL });
    expect(r.spec).toEqual(FULL);
    expect(r.loaded).toBe(true);
  });

  it('cfg.edge_bindings 非数组 / 空数组 → 回退默认', () => {
    expect(loadEdgeDimensionSpecFromConfig({ edge_bindings: 'nope' }).loaded).toBe(false);
    expect(loadEdgeDimensionSpecFromConfig({ edge_bindings: [] }).loaded).toBe(false);
  });

  it('cfg.edge_bindings 校验失败（缺边/悬空边）→ 回退默认 + errors 提示', () => {
    const bad = FULL.filter((r) => r.edge_type !== 'INFLUENCED');
    const r = loadEdgeDimensionSpecFromConfig({ edge_bindings: bad });
    expect(r.loaded).toBe(false);
    expect(r.spec).toBe(DEFAULT_EDGE_DIMENSION_SPEC);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('配置覆盖后 primaryDimension 取配置主维度', () => {
    const ov = [
      ...FULL.filter((r) => r.edge_type !== 'REFERENCED_PRECEDENT'),
      { edge_type: 'REFERENCED_PRECEDENT', serves_dimension: ['governance'], direction: 'decision->decision' },
    ];
    const r = loadEdgeDimensionSpecFromConfig({ edge_bindings: ov });
    expect(r.loaded).toBe(true);
    expect(primaryDimension('REFERENCED_PRECEDENT', r.spec)).toBe('governance');
  });
});