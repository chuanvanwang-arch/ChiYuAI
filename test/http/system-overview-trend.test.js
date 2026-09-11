import { describe, it, expect } from 'vitest';
import { buildTrendPolyline, buildTrendParts, renderTrendChart, getTrendSamples } from '../../src/http/render/systemOverviewShared.js';

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

// 2026-09-11：采样表只有 1 天数据时单点 polyline 画不出任何东西 → 趋势区「看着空白像坏了」。
// 另：.so-trend-empty 这个 class 全仓无样式定义，仅靠 class 会回落黑色填充，深色主题下不可见。
describe('buildTrendParts / renderTrendChart（单点可见 + 空态不依赖外部样式表）', () => {
  it('空数组 → mode=empty', () => {
    expect(buildTrendParts([]).mode).toBe('empty');
  });
  it('单点 → mode=accumulating，圆点贴右端并回显末值', () => {
    const p = buildTrendParts([43]);
    expect(p.mode).toBe('accumulating');
    expect(p.dots).toEqual([{ x: 194, y: 20 }]);
    expect(p.last).toBe(43);
  });
  it('多点 → mode=line，数据点数与采样天数一致', () => {
    const p = buildTrendParts([1, 2, 3]);
    expect(p.mode).toBe('line');
    expect(p.dots.length).toBe(3);
  });
  it('单点渲染出可见圆点 + 末值（不再空白）', () => {
    const svg = renderTrendChart([43], { trendId: 'knowledge-30d' });
    expect(svg).toContain('<circle');
    expect(svg).toContain('今日 43');
    expect(svg).toContain('采样积累中');
    expect(svg).not.toContain('<polyline');
  });
  it('空态文本带内联 fill（class 无样式时不会回落黑色而"看着空白"）', () => {
    const svg = renderTrendChart([], { trendId: 'k' });
    expect(svg).toContain('暂无采样数据');
    expect(svg).toMatch(/<text[^>]*fill="var\(--mut/);
  });
  it('多点渲染折线 + 逐点圆点', () => {
    const svg = renderTrendChart([1, 5, 3], { trendId: 'k' });
    expect(svg).toContain('<polyline');
    expect((svg.match(/<circle/g) || []).length).toBe(3);
  });
});
