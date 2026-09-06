import { describe, it, expect } from 'vitest';
import { getParamDiagnosis } from '../../src/monitor/diagnosis.js';

describe('getParamDiagnosis', () => {
  it('综合智能体+决策+处方，patches 附 recommend', async () => {
    const r = await getParamDiagnosis({ days: 7 });
    expect(r).toHaveProperty('agent');
    expect(r).toHaveProperty('decision');
    expect(r).toHaveProperty('patches');
    expect(Array.isArray(r.patches)).toBe(true);
    expect(r.red_lines).toContain('context-routing');
  });

  it('context-routing 相关处方不出现在 patches（红线）', async () => {
    const r = await getParamDiagnosis({ days: 7 });
    for (const p of r.patches) {
      expect(p.knob).not.toMatch(/routing|context-routing/i);
    }
  });
});
