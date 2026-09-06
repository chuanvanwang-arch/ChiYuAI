// test/monitor/dimCoverage.test.js
import { coverageOf, DIM_PREFIX, SEVEN_DIMS } from '../../src/monitor/dimCoverage.js';
import { describe, it, expect } from 'vitest';

describe('coverageOf (legacy view)', () => {
  it('marks provided when a cond matches the dim prefix', () => {
    const cov = coverageOf([{ cond: 'identity_name_present' }, { cond: 'pain_clear' }]);
    expect(cov.identity).toBe('provided');
    expect(cov.semantics).toBe('provided');
    expect(cov.structure).toBe('missing');
  });
  it('handles stringified JSONB', () => {
    expect(coverageOf('[{"cond":"time_window_set"}]').time).toBe('provided');
  });
  it('SEVEN_DIMS length is 7', () => {
    expect(SEVEN_DIMS.length).toBe(7);
  });
  it('DIM_PREFIX has 7 keys', () => {
    expect(Object.keys(DIM_PREFIX).length).toBe(7);
  });
});
