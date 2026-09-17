// test/signal/derivationWiring.test.js — 派生器生产接线守卫
// 为什么需要：本仓已有 5 次以上「模块全绿但生产零接线」的事故（createDeliveryRegistry 0 调用点、
//   alertStore persister 未挂、connectorActions 未注册…）。判据必须是「生产侧存在 import 方 +
//   定时器已注册 + 有 VITEST 护栏」，而不是"函数被定义了"。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const timers = readFileSync(new URL('../../src/scheduler/timers.js', import.meta.url), 'utf8');

describe('派生扫描的生产接线', () => {
  it('timers.js 引入并装配派生器（不是只定义了模块）', () => {
    expect(timers).toContain("import { createActivityDerivation }");
    expect(timers).toContain('createActivityDerivation(');
    expect(timers).toContain('deriveAllTenants');
  });

  it('注册定时器 activity-derivation-scan，且带 VITEST 护栏', () => {
    expect(timers).toContain("timers.set('activity-derivation-scan'");
    const idx = timers.indexOf("timers.set('activity-derivation-scan'");
    expect(idx).toBeGreaterThanOrEqual(0);
    const block = timers.slice(Math.max(0, idx - 1500), idx);
    expect(block).toContain('process.env.VITEST');
  });

  it('间隔来自环境变量（零硬编码字面量阈值）', () => {
    expect(timers).toMatch(/ACTIVITY_DERIVATION_MS/);
  });

  it('零投递/零命中不静默：失败与 missing 均 emit', () => {
    const idx = timers.indexOf("timers.set('activity-derivation-scan'");
    expect(idx).toBeGreaterThanOrEqual(0);
    const block = timers.slice(Math.max(0, idx - 2000), idx);
    expect(block).toContain('emit(');
    expect(block).toMatch(/missing|failures/);
  });
});
