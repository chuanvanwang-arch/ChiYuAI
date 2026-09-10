// test/connectors/discovery/waterfall.test.js
import { describe, it, expect } from 'vitest';
import { runWaterfall } from '../../../src/connectors/discovery/waterfall.js';

const mkAdapter = (id, costTier, hit, log) => ({
  id, costTier, coverageFields: ['email', 'phone'],
  async enrich(entity, fields) {
    log.push([id, fields[0]]);
    return hit
      ? { [fields[0]]: { value: `${id}-val`, confidence: 0.9, cost: costTier, provider: id } }
      : {};
  },
});

describe('waterfall', () => {
  it('按 costTier 升序扫描，首个命中即停（更贵者不被调用）', async () => {
    const log = [];
    const adapters = [mkAdapter('a', 3, false, log), mkAdapter('c', 2, true, log), mkAdapter('b', 1, true, log)];
    const out = await runWaterfall(adapters, { name: 'X' }, ['email']);
    expect(out.values.email.provider).toBe('b'); // 最廉命中者胜
    expect(log.some(([id]) => id === 'c')).toBe(false); // c 从未被调用
    expect(out.cost).toBe(1);
    expect(out.calls.map((c) => c.provider)).toEqual(['b']);
  });

  it('不取并集覆盖：同字段只记最廉一次，第二源不被调用', async () => {
    const log = [];
    const adapters = [mkAdapter('a', 1, true, log), mkAdapter('b', 2, true, log)];
    const out = await runWaterfall(adapters, { name: 'X' }, ['email']);
    expect(out.values.email.provider).toBe('a');
    expect(log.filter(([, f]) => f === 'email').length).toBe(1);
  });

  it('多字段各自独立 waterfall，成本累计', async () => {
    const log = [];
    const adapters = [mkAdapter('a', 1, true, log), mkAdapter('b', 2, true, log)];
    const out = await runWaterfall(adapters, { name: 'X' }, ['email', 'phone']);
    expect(Object.keys(out.values)).toEqual(['email', 'phone']);
    expect(out.cost).toBe(2);
  });

  it('全 miss 返回空 values + cost 0，不抛', async () => {
    const log = [];
    const adapters = [mkAdapter('a', 1, false, log), mkAdapter('b', 2, false, log)];
    const out = await runWaterfall(adapters, { name: 'X' }, ['email']);
    expect(out.values).toEqual({});
    expect(out.cost).toBe(0);
    expect(out.calls.length).toBe(2);
  });

  it('单适配器抛错不中断，记入 calls[].error 后继续降级', async () => {
    const boom = { id: 'boom', costTier: 0, async enrich() { throw new Error('provider down'); } };
    const ok = mkAdapter('b', 1, true, []);
    const out = await runWaterfall([boom, ok], { name: 'X' }, ['email']);
    expect(out.values.email.provider).toBe('b');
    expect(out.calls.find((c) => c.provider === 'boom').error).toContain('provider down');
  });
});
