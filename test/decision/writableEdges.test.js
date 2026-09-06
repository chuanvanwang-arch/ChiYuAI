// test/decision/writableEdges.test.js — T4(BG-05a) WRITABLE_EDGES 单一事实源 + required_dims 装弹自检
import { describe, it, expect } from 'vitest';
import {
  WRITABLE_EDGES, PENDING_WRITABLE_EDGES, isEdgeWritable,
  requiredEdgesForDims, checkRequiredDimsWritable,
} from '../../src/decision/writableEdges.js';

describe('T4 — WRITABLE_EDGES 单一事实源（BG-03 方案 B 后：全 7 类可写）', () => {
  it('7 类边全部可写（to_id 外键已放宽，含 decision→entity/exception）', () => {
    expect(WRITABLE_EDGES).toEqual([
      'DECIDED_ON', 'REFERENCED_PRECEDENT', 'DERIVED_FROM_EXCEPTION',
      'ESTABLISHES_FRAME', 'OVERRIDES', 'CAUSED', 'INFLUENCED',
    ]);
    expect(PENDING_WRITABLE_EDGES).toEqual([]);
    expect(isEdgeWritable('OVERRIDES')).toBe(true);
    expect(isEdgeWritable('DECIDED_ON')).toBe(true);
    expect(isEdgeWritable('DERIVED_FROM_EXCEPTION')).toBe(true);
  });
});

describe('T4 — requiredEdgesForDims / checkRequiredDimsWritable', () => {
  it('纯决策历史维度依赖可写边 → ok', () => {
    const chk = checkRequiredDimsWritable([{ dim: 'decision_history', on_missing: 'warn' }]);
    expect(chk.ok).toBe(true);
    expect(chk.unwritable).toEqual([]);
  });

  it('identity/structure 依赖 DECIDED_ON（BG-03 后已可写）→ 通过', () => {
    const chk = checkRequiredDimsWritable([{ dim: 'identity', on_missing: 'warn' }, { dim: 'structure', on_missing: 'block' }]);
    expect(chk.ok).toBe(true);
    expect(chk.unwritable).toEqual([]);
  });

  it('operational_state 依赖 DERIVED_FROM_EXCEPTION（BG-03 后已可写）→ 通过', () => {
    const chk = checkRequiredDimsWritable([{ dim: 'operational_state', on_missing: 'warn' }]);
    expect(chk.ok).toBe(true);
    expect(chk.unwritable).toEqual([]);
  });

  it('requiredEdgesForDims 汇聚多维度依赖边集合', () => {
    const edges = requiredEdgesForDims(['decision_history', 'time_config', 'semantics']);
    expect(edges).toEqual(expect.arrayContaining(['REFERENCED_PRECEDENT', 'OVERRIDES', 'CAUSED', 'INFLUENCED', 'ESTABLISHES_FRAME']));
  });

  it('空/非法输入安全', () => {
    expect(checkRequiredDimsWritable([]).ok).toBe(true);
    expect(checkRequiredDimsWritable(null).ok).toBe(true);
    expect(checkRequiredDimsWritable('not-array').ok).toBe(true);
  });
});
