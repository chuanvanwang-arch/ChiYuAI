import { describe, it, expect } from 'vitest';
import { runRetroOnce } from '../../src/scheduler/timers.js';

describe('runRetroOnce 夜报生成', () => {
  it('三段独立 catch 互不传染：①抛错仍生成报告且返回 null 段', async () => {
    const calls = { retro: 0, routing: 0, param: 0, save: 0 };
    const err = new Error('LLM down');
    const res = await runRetroOnce({
      retroFn: async () => { calls.retro++; throw err; },
      routingFn: async () => { calls.routing++; return { closed: 1, patches: [], nextArms: [], insufficient: [], errors: [] }; },
      paramFn: async () => { calls.param++; return { inspected: 22, healthy: 20, drift: 2, unknown: 0, patches: [] }; },
      saveReportFn: async () => { calls.save++; },
    });
    expect(res.retro).toBeNull();        // ①失败→null，不传染
    expect(res.routing.closed).toBe(1);  // ②正常
    expect(res.param.inspected).toBe(22); // ③正常
    expect(calls.save).toBe(1);          // 报告仍生成
  });

  it('②/③抛错不阻断①与报告', async () => {
    const res = await runRetroOnce({
      retroFn: async () => ({ report_id: 'r1', decisions_scanned: 3, clusters: [], draft_patches: [] }),
      routingFn: async () => { throw new Error('routing down'); },
      paramFn: async () => { throw new Error('param down'); },
      saveReportFn: async () => {},
    });
    expect(res.retro.report_id).toBe('r1');
    expect(res.routing).toBeNull();
    expect(res.param).toBeNull();
  });
});
