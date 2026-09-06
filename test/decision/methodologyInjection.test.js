// P3 D1 单测：纯函数 indexMethodology / enrichConceptRefs（不依赖 DB）
import { describe, it, expect } from 'vitest';
import { indexMethodology, enrichConceptRefs } from '../../src/knowledge/methodologyInjection.js';

const MD = [
  { methodology_id: 'BANT', dim_key: 'budget', label: '预算 Budget', weight: 1, required: true },
  { methodology_id: 'BANT', dim_key: 'authority', label: '决策权限 Authority', weight: 1, required: true },
  { methodology_id: 'BANT', dim_key: 'timeline', label: '时间线 Timeline', weight: 0.8, required: false },
  { methodology_id: 'MEDDICC', dim_key: 'E', label: '经济买家', weight: 1, required: true },
];

describe('indexMethodology', () => {
  it('按 methodology_id|dim_key 建索引', () => {
    const idx = indexMethodology(MD);
    expect(idx.get('BANT|budget').required).toBe(true);
    expect(idx.get('BANT|timeline').required).toBe(false);
    expect(idx.get('BANT|timeline').weight).toBe(0.8);
    expect(idx.has('NOPE|x')).toBe(false);
  });
});

describe('enrichConceptRefs 双轨闭合', () => {
  const idx = indexMethodology(MD);
  it('补全 canonical weight/required/label', async () => {
    const refs = [{ methodology_id: 'BANT', dimension_key: 'budget', hit: true }];
    const out = await enrichConceptRefs(refs, idx, null);
    expect(out[0].weight).toBe(1);
    expect(out[0].required).toBe(true);
    expect(out[0].label).toBe('预算 Budget');
  });
  it('不在方法论矩阵的维度诚实保留调用方值（不假造）', async () => {
    const refs = [{ methodology_id: 'CUSTOM', dimension_key: 'x', hit: true, weight: 0.5 }];
    const out = await enrichConceptRefs(refs, idx, null);
    expect(out[0].weight).toBe(0.5); // 未被覆盖
    expect(out[0].methodology_id).toBe('CUSTOM');
  });
  it('非数组入参原样返回（fail-open）', async () => {
    expect(await enrichConceptRefs(null, idx, null)).toBeNull();
    expect(await enrichConceptRefs(undefined, idx, null)).toBeUndefined();
  });
  // MISS 留痕（2026-09-03）：引用的维键不在方法论矩阵时触发 onMiss 回调，
  // 返回语义不变（诚实保留调用方值），仅额外留痕以便审计可见盲区。
  it('onMiss：未命中维度触发回调，返回语义不变', async () => {
    const misses = [];
    const refs = [{ methodology_id: 'CUSTOM', dimension_key: 'x', hit: true, weight: 0.5 }];
    const out = await enrichConceptRefs(refs, idx, null, { onMiss: (r) => misses.push(r) });
    expect(out[0].weight).toBe(0.5);              // 返回不变（不假造）
    expect(misses).toHaveLength(1);               // 留痕生效
    expect(misses[0].dimension_key).toBe('x');
  });
  it('onMiss 未传时不报错、行为向后兼容', async () => {
    const refs = [{ methodology_id: 'CUSTOM', dimension_key: 'x', hit: true, weight: 0.5 }];
    const out = await enrichConceptRefs(refs, idx, null); // 无第 4 参
    expect(out[0].weight).toBe(0.5);
  });
});
