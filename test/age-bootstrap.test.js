// test/age-bootstrap.test.js — P0 启动探活：ensureGraph 设置 isAvailable 反映真实可用性
import { describe, it, expect } from 'vitest';
import { ensureGraph, isAvailable } from '../src/decision/ageGraph.js';

describe('P0 启动探活', () => {
  it('ensureGraph 调用后 isAvailable 反映真实可用性', async () => {
    const r = await ensureGraph();
    expect(typeof r.ok).toBe('boolean');
    expect(isAvailable()).toBe(r.ok);
  });
});
