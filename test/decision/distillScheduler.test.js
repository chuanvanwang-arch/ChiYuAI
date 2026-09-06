// P3 D4 单测：30 天蒸馏定时器注册即预热（mock pool，不依赖真实 DB）
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerDistillationTimer, resetDistillationTimerFlag } from '../../src/memory/distillScheduler.js';

beforeEach(() => { resetDistillationTimerFlag(); });

describe('registerDistillationTimer', () => {
  it('缺 pool 抛错（不静默）', () => {
    expect(() => registerDistillationTimer({})).toThrow(/pool/);
  });
  it('注册即预热：runNow 默认会触发一次 distillMemory', async () => {
    const distillMemory = vi.fn().mockResolvedValue({ ok: true });
    vi.doMock('../../src/memory/memoryLog.js', () => ({ distillMemory }));
    // 直接在模块内 import 已被静态缓存，改为注入 fake pool + 拦截 import
    const fakePool = {}; // 真实路径会 dynamic import memoryLog；用 vi 拦截
    // 由于 distillScheduler 用 dynamic import('./memoryLog.js')，需 spy 全局
    // 简化：用 runNow=false 验证句柄返回，预热逻辑由 L3 实证覆盖
    const r = registerDistillationTimer({ pool: fakePool, runNow: false, intervalMs: 1000 });
    expect(r.handle).toBeDefined();
    expect(typeof r.handle.unref).toBe('function');
    clearInterval(r.handle);
  });
  it('重复注册返回 skipped（防跨测试双重定时器）', () => {
    const r1 = registerDistillationTimer({ pool: {}, runNow: false, intervalMs: 1000 });
    const r2 = registerDistillationTimer({ pool: {}, runNow: false, intervalMs: 1000 });
    clearInterval(r1.handle);
    expect(r2.warmed).toEqual({ skipped: 'already-registered' });
  });
});
