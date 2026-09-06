// test/decision/edgeDimensionSpec.test.js — T1 边↔维度规范（纯单测，无 PG）
import { describe, it, expect } from 'vitest';
import {
  DIMENSIONS, EDGES, DEFAULT_EDGE_DIMENSION_SPEC,
  loadEdgeDimensionSpec, validateEdgeDimensionSpec, primaryDimension, edgesServingDimension,
} from '../../src/decision/edgeDimensionSpec.js';

describe('T1 edgeDimensionSpec（7 边 × 7 维）', () => {
  it('默认规范 7 边全覆盖 7 维，无悬空 → valid:true', () => {
    const r = validateEdgeDimensionSpec(DEFAULT_EDGE_DIMENSION_SPEC);
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('每维 ≥1 条边服务', () => {
    for (const d of DIMENSIONS) {
      const edges = edgesServingDimension(d.key);
      expect(edges.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('7 边全部有绑定', () => {
    expect(DEFAULT_EDGE_DIMENSION_SPEC.length).toBe(7);
    for (const e of EDGES) {
      expect(DEFAULT_EDGE_DIMENSION_SPEC.some((r) => r.edge_type === e.key)).toBe(true);
    }
  });

  it('悬空维 → valid:false', () => {
    const bad = [{ edge_type: 'DECIDED_ON', serves_dimension: ['identity'], direction: 'x' }];
    const r = validateEdgeDimensionSpec(bad);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('维度未被任何边服务'))).toBe(true);
  });

  it('悬空边（指向未知维度）→ valid:false', () => {
    const bad = [{ edge_type: 'DECIDED_ON', serves_dimension: ['unknown_dim'], direction: 'x' }];
    const r = validateEdgeDimensionSpec(bad);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('悬空维'))).toBe(true);
  });

  it('loadEdgeDimensionSpec 默认返回定稿映射；override 非空时优先', () => {
    expect(loadEdgeDimensionSpec().length).toBe(7);
    const ov = [{ edge_type: 'DECIDED_ON', serves_dimension: ['identity'], direction: 'x' }];
    expect(loadEdgeDimensionSpec(ov)).toBe(ov);
  });

  it('primaryDimension: REFERENCED_PRECEDENT → decision_history', () => {
    expect(primaryDimension('REFERENCED_PRECEDENT')).toBe('decision_history');
  });

  it('中文名 + 一句话意思双双保留（供 7×7 巡检卡）', () => {
    expect(EDGES.find((e) => e.key === 'OVERRIDES').name).toBe('推翻翻案');
    expect(DIMENSIONS.find((d) => d.key === 'governance').meaning).toContain('治理');
  });
});
