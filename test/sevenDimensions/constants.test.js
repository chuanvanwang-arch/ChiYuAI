// test/sevenDimensions/constants.test.js — Task 3: SEVEN_DIMS 七维常量（D3 唯一源）
// 设计输入：docs/2026-08-26-frontend-config-pages-master-blueprint.md S20 + D3 决策（Oleg 产品情境七维度）
import { describe, it, expect } from 'vitest';
import { SEVEN_DIMS, DIM_KEYS } from '../../src/sevenDimensions/constants.js';

describe('SEVEN_DIMS 七维常量（D3 唯一源）', () => {
  it('DIM_KEYS 精确七维', () => {
    expect(DIM_KEYS).toEqual([
      'identity', 'structure', 'semantics', 'time_config',
      'decision_history', 'operational_state', 'governance',
    ]);
  });

  it('SEVEN_DIMS 含 7 项，每项 key/label/desc', () => {
    expect(SEVEN_DIMS).toHaveLength(7);
    for (const d of SEVEN_DIMS) {
      expect(d).toHaveProperty('key');
      expect(d).toHaveProperty('label');
      expect(d).toHaveProperty('desc');
    }
  });

  it('label 中文可读', () => {
    const labels = SEVEN_DIMS.map((d) => d.label);
    expect(labels).toContain('身份');
    expect(labels).toContain('决策历史');
    expect(labels).toContain('治理');
  });
});