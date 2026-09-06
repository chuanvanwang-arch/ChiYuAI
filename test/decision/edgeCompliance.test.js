import { describe, it, expect } from 'vitest';
import { computeEdgeCompliance, CATEGORY_STATES, requiredEdgesForDims } from '../../src/monitor/attribution.js';
import { classifyRootCause } from '../../src/decision/rootCauseClassifier.js';

describe('T29 computeEdgeCompliance（E1-E7 应存/实存/缺 三元组）', () => {
  it('实际存在的边标 present，其余标 missing（全列）', () => {
    const ec = computeEdgeCompliance(['DECIDED_ON', 'REFERENCED_PRECEDENT']);
    expect(ec.DECIDED_ON).toBe('present');
    expect(ec.REFERENCED_PRECEDENT).toBe('present');
    expect(ec.CAUSED).toBe('missing');
    expect(ec.OVERRIDES).toBe('missing');
    // 7 类投影 + required_edges/required_missing/known 三元组键
    expect(ec.required_edges).toEqual([]);
    expect(ec.required_missing).toEqual([]);
    expect(ec.known).toBe(false); // 未给 requiredEdges/requiredDims → 无应连依据
  });

  it('空实际边集 → 全部 missing 且 known=false（无应连依据不臆断 E 缺）', () => {
    const ec = computeEdgeCompliance([]);
    expect(ec.DECIDED_ON).toBe('missing');
    expect(ec.OVERRIDES).toBe('missing');
    expect(ec.known).toBe(false);
  });

  it('requiredEdgesForDims：服务必填维的边 = 应连边（7×7 交叉校验语义）', () => {
    const req = requiredEdgesForDims(['identity', 'structure']);
    expect(req).toContain('DECIDED_ON'); // identity/structure 均由 DECIDED_ON 服务
    expect(req).not.toContain('CAUSED');
    // 无必填维 → null（不可判）
    expect(requiredEdgesForDims(null)).toBeNull();
    expect(requiredEdgesForDims([])).toEqual([]);
  });

  it('传 requiredEdges → 三元组：应连未连清单 + known=true', () => {
    const ec = computeEdgeCompliance(['DECIDED_ON'], { requiredEdges: ['DECIDED_ON', 'DERIVED_FROM_EXCEPTION'] });
    expect(ec.required_edges).toEqual(['DECIDED_ON', 'DERIVED_FROM_EXCEPTION']);
    expect(ec.required_missing).toEqual(['DERIVED_FROM_EXCEPTION']);
    expect(ec.known).toBe(true);
    // 全连上 → required_missing 空（无 E 缺）
    const ecFull = computeEdgeCompliance(['DECIDED_ON', 'DERIVED_FROM_EXCEPTION'], { requiredEdges: ['DECIDED_ON', 'DERIVED_FROM_EXCEPTION'] });
    expect(ecFull.required_missing).toEqual([]);
    expect(ecFull.known).toBe(true);
  });

  it('CATEGORY_STATES 含七类根因码（四象限升级为七态）', () => {
    expect(CATEGORY_STATES).toContain('FIELD_MISMATCH');
    expect(CATEGORY_STATES).toContain('EDGE_MISSING');
    expect(CATEGORY_STATES).toContain('DATA_QUALITY_PRECEDENT');
  });
});

describe('T29 根因分类器消费 edge_compliance 三元组 → EDGE_MISSING', () => {
  it('usable=false & major & 无粒子三检 & required_missing 非空 → EDGE_MISSING', () => {
    const r = classifyRootCause({
      feedback: { usable: false, major_deviation: true },
      attribution: { edge_compliance: { DECIDED_ON: 'present', CAUSED: 'missing', required_missing: ['CAUSED'], known: true } },
      particleChecks: { field_mismatch: false, info_incomplete: false, input_stale: false },
    });
    expect(r.code).toBe('EDGE_MISSING');
    expect(r.knob).toBe('EDGE_BINDING');
  });

  it('投影 missing 但无 required_missing（known=false）→ 不判 E 缺 → DATA_QUALITY_PRECEDENT', () => {
    const r = classifyRootCause({
      feedback: { usable: false, major_deviation: true },
      attribution: { edge_compliance: { DECIDED_ON: 'present', CAUSED: 'missing' } }, // 旧投影，无三元组
      particleChecks: { field_mismatch: false, info_incomplete: false, input_stale: false },
    });
    expect(r.code).toBe('DATA_QUALITY_PRECEDENT');
    expect(r.knob).toBe('PRECEDENT_DISTILL');
  });

  it('L+E 全齐（required_missing 空）→ DATA_QUALITY_PRECEDENT（参考先例/标杆污染）', () => {
    const r = classifyRootCause({
      feedback: { usable: false, major_deviation: true },
      attribution: { edge_compliance: { required_missing: [], known: true } },
      particleChecks: { field_mismatch: false, info_incomplete: false, input_stale: false },
    });
    expect(r.code).toBe('DATA_QUALITY_PRECEDENT');
    expect(r.knob).toBe('PRECEDENT_DISTILL');
  });
});