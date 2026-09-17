// test/sync/factory.channels.test.js
// T1：SYNC_PROVIDER_FACTORY 增 generic-email/calendar/meeting/wechat 4 键（指向通用实现）
// 设计：docs/2026-09-17-channel-adapter-unified-design.md §3 / §4（同 generic-rest 范式）
// 判据：4 键必须存在且返回 {kind, verifyAuth, discoverObjects, readIncremental}（mount 可装配，防零接线假绿）
import { describe, it, expect } from 'vitest';
import { SYNC_PROVIDER_FACTORY } from '../../src/sync/factory.js';

describe('SYNC_PROVIDER_FACTORY 通道键', () => {
  const KINDS = ['generic-email', 'generic-calendar', 'generic-meeting', 'generic-wechat'];
  for (const kind of KINDS) {
    it(`${kind} 已注册且返回 {kind, verifyAuth, discoverObjects, readIncremental}`, () => {
      const f = SYNC_PROVIDER_FACTORY[kind];
      expect(f).toBeTypeOf('function');
      const inst = f({});
      expect(inst.kind).toBe(kind);
      expect(typeof inst.verifyAuth).toBe('function');
      expect(typeof inst.discoverObjects).toBe('function');
      expect(typeof inst.readIncremental).toBe('function');
    });
  }
  it('既有 generic-rest 零回归', () => {
    const inst = SYNC_PROVIDER_FACTORY['generic-rest']({});
    expect(inst.kind).toBe('generic-rest');
  });
});
