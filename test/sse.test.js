// test/sse.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { on, emit } from '../src/events/bus.js';
import { createSseHub } from '../src/events/sse.js';

beforeEach(() => {
  // 清理跨测试订阅（bus 为模块级单例）
});

describe('event bus', () => {
  it('emit 广播：域订阅 + 全量订阅（payload 包装 domain/type/ts）', () => {
    const got = [];
    const off1 = on('task', (m) => got.push(['task', m.type]));
    const off2 = on('*', (m) => got.push(['all', m.domain]));
    emit('task', 'done', { id: 'x' });
    expect(got).toContainEqual(['task', 'done']);
    expect(got).toContainEqual(['all', 'task']);
    off1();
    off2();
    emit('task', 'done', { id: 'y' }); // 退订后不再收到
    expect(got.length).toBe(2);
  });

  it('订阅者异常隔离：一个 handler 抛错不影响其他 handler', () => {
    const got = [];
    on('*', () => {
      throw new Error('boom');
    });
    on('*', (m) => got.push(m.type));
    emit('particle', 'created', {});
    expect(got).toEqual(['created']);
  });
});

describe('SSE hub', () => {
  it('SSE 连接接收广播（模拟 res 写入）', () => {
    const hub = createSseHub();
    const writes = [];
    const fakeRes = {
      write: (s) => writes.push(s),
      flushHeaders: () => {},
      on: () => {},
    };
    hub.connect(fakeRes);
    emit('task', 'done', { id: 't1' });
    expect(writes.some((s) => s.includes('event: task') && s.includes('done'))).toBe(true);
    hub.close();
  });
});
