// D6 校准 SLA 周期扫描定时器单测（依赖注入；Task D）
// 设计：docs/2026-09-14-d6-calibration-approval-flow-plan.md Task D。
// 验证：runCalibrationSlaScanOnce 调用注入 scanFn；翻转>0 时 emit trace；失败时 recordFailure（不静默）。
import { describe, it, expect, vi } from 'vitest';
const { runCalibrationSlaScanOnce } = await import('../../src/scheduler/timers.js');

describe('runCalibrationSlaScanOnce', () => {
  it('调用 scanFn 并在翻转>0 时 emit trace', async () => {
    const scanFn = vi.fn(async () => ({ escalated: 3 }));
    const emit = vi.fn();
    const recordFailure = vi.fn();
    const r = await runCalibrationSlaScanOnce({ scanFn, emit, recordFailure });
    expect(r.escalated).toBe(3);
    expect(scanFn).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('trace', 'calibration-sla-escalated', { count: 3 });
    expect(recordFailure).not.toHaveBeenCalled();
  });

  it('0 翻转 → 不 emit trace（无事件不刷屏）', async () => {
    const scanFn = vi.fn(async () => ({ escalated: 0 }));
    const emit = vi.fn();
    const r = await runCalibrationSlaScanOnce({ scanFn, emit, recordFailure: vi.fn() });
    expect(r.escalated).toBe(0);
    expect(emit).not.toHaveBeenCalled();
  });

  it('scanFn 抛错 → recordFailure 留痕，不抛', async () => {
    const scanFn = vi.fn(async () => { throw new Error('db down'); });
    const emit = vi.fn();
    const recordFailure = vi.fn();
    const r = await runCalibrationSlaScanOnce({ scanFn, emit, recordFailure });
    expect(r).toEqual({ escalated: 0, error: 'db down' });
    expect(emit).toHaveBeenCalledWith('trace', 'calibration-sla-scan-failed', { error: 'db down' });
    expect(recordFailure).toHaveBeenCalledWith('calibration-sla-scan-failed', expect.any(Error));
  });
});
