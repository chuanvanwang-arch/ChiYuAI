import { describe, it, expect } from 'vitest';
import { buildTrendPolyline, getTrendSamples } from '../../src/http/render/systemOverviewShared.js';

describe('buildTrendPolyline', () => {
  it('空数组返回空串', () => {
    expect(buildTrendPolyline([])).toBe('');
  });
  it('单点返回中点', () => {
    expect(buildTrendPolyline([10])).toBe('0.0,20.0');
  });
  it('多点线性映射到 200x40（max→y5, min→y35）', () => {
    const p = buildTrendPolyline([0, 10, 5, 20]);
    const pts = p.split(' ');
    expect(pts.length).toBe(4);
    expect(pts[0]).toBe('0.0,35.0');        // min=0 → y=35
    expect(pts[3]).toBe('200.0,5.0');       // max=20 → y=5
    expect(pts[1].startsWith('66.7,')).toBe(true); // x=66.7 处
  });
  it('恒定序列不产生除零（全部取中线）', () => {
    const p = buildTrendPolyline([7, 7, 7]);
    expect(p).toBe('0.0,20.0 100.0,20.0 200.0,20.0');
  });
});

describe('getTrendSamples (注入 query)', () => {
  it('按 metric+tenant 升序返回 value 数组', async () => {
    const fakeQuery = async () => ({ rows: [
      { value: 3 }, { value: 6 }, { value: 9 },
    ] });
    const vals = await getTrendSamples('k_method_skill', { tenantId: 'system', days: 30, deps: { query: fakeQuery } });
    expect(vals).toEqual([3, 6, 9]);
  });
  it('查询异常安全降级为空数组', async () => {
    const fakeQuery = async () => { throw new Error('no table'); };
    const vals = await getTrendSamples('k_method_skill', { tenantId: 'system', deps: { query: fakeQuery } });
    expect(vals).toEqual([]);
  });
});
