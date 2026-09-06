// test/context/supplySpec.test.js — A-T1 供给侧 S1–S7 注册表 + 校验
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SUPPLY_OPS, SUPPLY_KINDS, validateSupplySpec, resolveSupplySpec, dimCoverageFromOps,
} from '../../src/context/supplySpec.js';

describe('A-T1 — 默认供给注册表', () => {
  it('恰为 7 操作 S1–S7，kind 合法', () => {
    expect(DEFAULT_SUPPLY_OPS).toHaveLength(7);
    expect(DEFAULT_SUPPLY_OPS.map((o) => o.op)).toEqual(['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7']);
    for (const o of DEFAULT_SUPPLY_OPS) expect(SUPPLY_KINDS).toContain(o.kind);
  });

  it('validateSupplySpec 默认注册表通过（7 操作齐备 + 7 维全覆盖）', () => {
    const v = validateSupplySpec();
    expect(v.valid).toBe(true);
    expect(v.errors).toEqual([]);
    expect(v.coveredDims).toHaveLength(7);
  });

  it('dimCoverageFromOps：每维至少一操作供给', () => {
    const cov = dimCoverageFromOps();
    const keys = Object.keys(cov);
    expect(keys).toHaveLength(7);
    for (const k of keys) { expect(cov[k].supplied).toBe(true); expect(cov[k].ops.length).toBeGreaterThan(0); }
  });
});

describe('A-T1 — 校验拒绝非法注册表', () => {
  it('缺操作 → 无效', () => {
    const bad = DEFAULT_SUPPLY_OPS.filter((o) => o.op !== 'S3');
    const v = validateSupplySpec(bad);
    expect(v.valid).toBe(false);
    expect(v.errors.join(';')).toContain('操作缺失: S3');
  });

  it('维度未覆盖 → 无效', () => {
    // time_config 仅 S5 供给；从 S5 与覆盖全维的 S7 同时移除 → 真正悬空
    const bad = DEFAULT_SUPPLY_OPS.map((o) => {
      if (o.op === 'S5') return { ...o, serves_dims: [] };
      if (o.op === 'S7') return { ...o, serves_dims: o.serves_dims.filter((d) => d !== 'time_config') };
      return o;
    });
    const v = validateSupplySpec(bad);
    expect(v.valid).toBe(false);
    expect(v.errors.join(';')).toContain('维度未被任何操作供给');
  });

  it('非法 kind → 无效', () => {
    const bad = DEFAULT_SUPPLY_OPS.map((o) => (o.op === 'S1' ? { ...o, kind: 'magic' } : o));
    const v = validateSupplySpec(bad);
    expect(v.valid).toBe(false);
    expect(v.errors.join(';')).toContain('kind');
  });
});

describe('A-T1 — resolveSupplySpec 配置覆盖 + fail-safe', () => {
  it('无配置 → 回退默认', () => {
    const r = resolveSupplySpec(null);
    expect(r.loaded).toBe(false);
    expect(r.ops).toEqual(DEFAULT_SUPPLY_OPS);
  });
  it('非法配置 → fail-safe 回退默认（不阻断）', () => {
    const r = resolveSupplySpec({ supply_bindings: DEFAULT_SUPPLY_OPS.slice(0, 3) });
    expect(r.loaded).toBe(false);
    expect(r.ops).toEqual(DEFAULT_SUPPLY_OPS);
  });
  it('合法配置 → 采用', () => {
    const r = resolveSupplySpec({ supply_bindings: DEFAULT_SUPPLY_OPS });
    expect(r.loaded).toBe(true);
    expect(r.ops).toHaveLength(7);
  });
});
