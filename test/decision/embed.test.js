// P3 D3 单测：可插拔 embedding（纯函数 + hash/dynamic provider 降级）
import { describe, it, expect } from 'vitest';
import { embedText, conceptVector, compareRecall } from '../../src/knowledge/embed.js';

describe('conceptVector（V3 概念向量）', () => {
  it('同概念同向量（确定性）', () => {
    const a = conceptVector('BANT', 'budget', '预算');
    const b = conceptVector('BANT', 'budget', '预算');
    expect(a).toEqual(b);
    expect(a.length).toBe(384);
  });
  it('不同概念向量不同', () => {
    const a = conceptVector('BANT', 'budget', '预算');
    const b = conceptVector('MEDDICC', 'E', '经济买家');
    expect(a).not.toEqual(b);
  });
});

describe('compareRecall（A/B 召回对比）', () => {
  it('完全重叠返回 jaccard=1', () => {
    expect(compareRecall(['a', 'b'], ['a', 'b']).jaccard).toBe(1);
  });
  it('无重叠返回 jaccard=0', () => {
    const r = compareRecall(['a'], ['b']);
    expect(r.jaccard).toBe(0);
    expect(r.onlyA).toBe(1);
    expect(r.onlyB).toBe(1);
  });
  it('双空集视为完美重叠（不假绿）', () => {
    expect(compareRecall([], []).jaccard).toBe(1);
  });
});

describe('embedText 可插拔 provider', () => {
  it('hash 默认：确定性、非降级', async () => {
    const r1 = await embedText('线索升级为商机');
    const r2 = await embedText('线索升级为商机');
    expect(r1.provider).toBe('hash');
    expect(r1.degraded).toBe(false);
    expect(r1.vector).toEqual(r2.vector);
    expect(r1.vector.length).toBe(384);
  });
  it('未知 provider 抛错（不让非法 provider 静默通过）', async () => {
    await expect(embedText('x', { provider: 'unknown' })).rejects.toThrow(/未知/);
  });
  // siliconflow 未配置时降级 hash + degraded:true（反假绿，不抛错、不静默）
  it('siliconflow 未配置 → 降级 hash 并标 degraded', async () => {
    const r = await embedText('线索升级为商机', { provider: 'siliconflow' });
    expect(r.provider).toBe('hash');
    expect(r.degraded).toBe(true);
    expect(r.reason).toMatch(/降级/);
  });
});
