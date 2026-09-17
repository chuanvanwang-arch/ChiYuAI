// test/scheduler/channel-poll.test.js
// T5：timers ⑩ 同步轮询装配守卫——通道预设（generic-email/calendar/meeting/wechat）必须并入
//     syncFactories，否则 kind=generic-* 的租户描述符会被 mount 静默跳过（零接线假绿）。
// 判据（源码级守卫，防「预设做了却没接线」）：
//   1) timers.js ⑩ 合并处引用了 presetFactories（通道预设随预设并入 syncFactories）；
//   2) PRESET_FACTORIES 真实含 4 通道键（presets/index.js 已 buildChannelFactories）。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { PRESET_FACTORIES } from '../../src/sync/presets/index.js';

const timersSrc = readFileSync(new URL('../../src/scheduler/timers.js', import.meta.url), 'utf8');

describe('timers ⑩ 通道装配（T5）', () => {
  it('timers.js ⑩ 合并处引用 presetFactories（通道预设随预设并入 syncFactories）', () => {
    expect(timersSrc).toContain('presetFactories');
    expect(timersSrc).toContain('PRESET_FACTORIES');
  });
  it('PRESET_FACTORIES 真实含 4 通道键（非零接线：mount 能构造）', () => {
    for (const kind of ['generic-email', 'generic-calendar', 'generic-meeting', 'generic-wechat']) {
      expect(PRESET_FACTORIES[kind]).toBeTypeOf('function');
      const inst = PRESET_FACTORIES[kind]({});
      expect(typeof inst.readIncremental).toBe('function');
    }
  });
});
