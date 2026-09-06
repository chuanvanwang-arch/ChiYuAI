// test/decision/interception.test.js — T3 纯函数 decideInterception 单测（无 DB 依赖）
import { describe, it, expect } from 'vitest';
import { decideInterception, missingContextMessage } from '../../src/decision/interception.js';

describe('decideInterception', () => {
  it('allowed=true → 透传（blocked=false）', () => {
    const r = decideInterception({ required: [], missing: [], level: 'ok', allowed: true });
    expect(r.blocked).toBe(false);
    expect(r.missing).toEqual([]);
  });

  it('allowed=false（block 维缺失）→ blocked=true 且回显缺失维', () => {
    const r = decideInterception({
      required: [{ dim: 'identity', on_missing: 'warn' }, { dim: 'time', on_missing: 'block' }],
      missing: [{ dim: 'time', on_missing: 'block' }],
      level: 'block',
      allowed: false,
    });
    expect(r.blocked).toBe(true);
    expect(r.missing).toEqual(['time']);
    expect(r.level).toBe('block');
  });

  it('missing 为纯字符串数组时也能规整', () => {
    const r = decideInterception({ missing: ['a', 'b'], allowed: false });
    expect(r.blocked).toBe(true);
    expect(r.missing).toEqual(['a', 'b']);
  });

  it('check 为 undefined → 默认放行（不误伤既有写流程）', () => {
    const r = decideInterception(undefined);
    expect(r.blocked).toBe(false);
  });

  it('missing_context 消息格式稳定（前端可识别）', () => {
    const msg = missingContextMessage(decideInterception({ missing: ['time', 'identity'], allowed: false }));
    expect(msg).toBe('missing_context: 维度缺失 time,identity');
  });
});
