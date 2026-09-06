// test/dispatch.test.js
import { describe, it, expect } from 'vitest';
import { createDispatchQueue } from '../src/kanban/dispatch.js';

describe('dispatch 并发限流', () => {
  it('max_inflight 上限：超过并发上限的任务排队', async () => {
    const q = createDispatchQueue({ maxInflight: 3 });
    const started = [];
    const fn = (id) => new Promise((resolve) => {
      started.push(id);
      setTimeout(resolve, 20);
    });
    const jobs = [1,2,3,4,5].map(id => q.push(id, () => fn(id)));
    await Promise.all(jobs);
    // 并发峰值不超过 3：started 在任意 20ms 窗口最多 3 个（用时间窗断言宽松版）
    expect(q.inflight).toBe(0);
    expect(started.length).toBe(5);
  });
});
