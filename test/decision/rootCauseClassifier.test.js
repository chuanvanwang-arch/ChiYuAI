// test/decision/rootCauseClassifier.test.js — T27 七类根因分类器（纯单测）
import { describe, it, expect } from 'vitest';
import { classifyRootCause, ROOT_CAUSES } from '../../src/decision/rootCauseClassifier.js';

describe('T27 rootCauseClassifier（七类命中）', () => {
  it('R0: usable=false & major & field_mismatch → FIELD_MISMATCH', () => {
    const r = classifyRootCause({
      feedback: { usable: false, major_deviation: true },
      attribution: { required_fill: { missing: [] }, edge_compliance: {} },
      particleChecks: { field_mismatch: true },
    });
    expect(r.code).toBe('FIELD_MISMATCH');
    expect(r.severity).toBe('major');
    expect(r.knob).toBe('META_ATTR_MAP');
  });

  it('info_incomplete → INFO_INCOMPLETE', () => {
    const r = classifyRootCause({
      feedback: { usable: false, major_deviation: true },
      attribution: { required_fill: { missing: [] }, edge_compliance: {} },
      particleChecks: { info_incomplete: true },
    });
    expect(r.code).toBe('INFO_INCOMPLETE');
  });

  it('input_stale → INPUT_STALE', () => {
    const r = classifyRootCause({
      feedback: { usable: false, major_deviation: true },
      attribution: { required_fill: { missing: [] }, edge_compliance: {} },
      particleChecks: { input_stale: true },
    });
    expect(r.code).toBe('INPUT_STALE');
  });

  it('L 维度缺失 → DIM_MISSING', () => {
    const r = classifyRootCause({
      feedback: { usable: false, major_deviation: true },
      attribution: { required_fill: { missing: ['identity'] }, edge_compliance: {} },
      particleChecks: {},
    });
    expect(r.code).toBe('DIM_MISSING');
  });

  it('E 边缺失（required_missing 非空）→ EDGE_MISSING', () => {
    const r = classifyRootCause({
      feedback: { usable: false, major_deviation: true },
      attribution: {
        required_fill: { missing: [] },
        edge_compliance: { CAUSED: 'missing', required_missing: ['CAUSED'], known: true },
      },
      particleChecks: {},
    });
    expect(r.code).toBe('EDGE_MISSING');
  });

  it('E 边仅投影 missing（known=false 无应连依据）→ 不判 E 缺 → DATA_QUALITY_PRECEDENT', () => {
    const r = classifyRootCause({
      feedback: { usable: false, major_deviation: true },
      attribution: {
        required_fill: { missing: [] },
        edge_compliance: { CAUSED: 'missing' }, // 旧投影形态，无 required_missing/known
      },
      particleChecks: {},
    });
    expect(r.code).toBe('DATA_QUALITY_PRECEDENT');
  });

  it('R0 末路: L+E 全齐 & major → DATA_QUALITY_PRECEDENT（参考先例污染，最隐蔽一类）', () => {
    const r = classifyRootCause({
      feedback: { usable: false, major_deviation: true },
      attribution: { required_fill: { missing: [] }, edge_compliance: { CAUSED: 'present' } },
      particleChecks: {},
    });
    expect(r.code).toBe('DATA_QUALITY_PRECEDENT');
    expect(r.knob).toBe('PRECEDENT_DISTILL');
  });

  it('R1: usable=false & 非 major & L+E 齐 → NEED_DIM_ORDER', () => {
    const r = classifyRootCause({
      feedback: { usable: false, major_deviation: false },
      attribution: { required_fill: { missing: [] }, edge_compliance: { CAUSED: 'present' } },
      particleChecks: {},
    });
    expect(r.code).toBe('NEED_DIM_ORDER');
    expect(r.severity).toBe('minor');
  });

  it('R2: usable=true → UNKNOWN（正向强化，无干预）', () => {
    const r = classifyRootCause({ feedback: { usable: true, major_deviation: false } });
    expect(r.code).toBe('UNKNOWN');
    expect(r.severity).toBe('none');
  });

  it('R3: 无反馈信号 → UNKNOWN', () => {
    const r = classifyRootCause({});
    expect(r.code).toBe('UNKNOWN');
  });

  it('七类根因定义齐备（含中文名）', () => {
    expect(Object.keys(ROOT_CAUSES).length).toBe(8); // 7 类 + UNKNOWN
    expect(ROOT_CAUSES.DATA_QUALITY_PRECEDENT.name).toBe('数据质量·参考先例/标杆');
  });
});
