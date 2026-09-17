// test/signal/deliveryAttemptAccounting.test.js
// 2026-09-17 新增：守卫「attempts 只统计真实投递尝试」这一语义。
//
// 缺陷实证（demo-datadriven 真库，本轮日期驱动演示发现）：
//   该租户 signal-delivery.retry=1，但 crm.signal_delivery 中 email/im 的 attempts=6，
//   且 6 恰好等于「首次投递(19:55) → 现在(20:25)」的 5 分钟泵周期数。
//   根因：dispatcher 的 skip 分支（含 retry_exhausted）也调 deliveryStore.record()，
//   而 record 的累加**无条件** ⇒ 越过 retryLimit 之后，每轮泵都 +1。
//   `attempts` 于是退化为「泵轮次计数器」并无界增长。
//   F-6(b) 只治了「每次调用插新行」（行数增长），未治「skip 也累加」——
//   症状从「行数线性增长」平移为「attempts 线性增长」，同一根因的第二种形态。
//
// 本文件用**行为级**断言（捕获 record 实参与 SQL 参数），不用源码 grep：
//   grep 断言会被自己写下的说明注释命中（本仓已登记两次的同族教训）。
import { describe, it, expect, vi } from 'vitest';
import { createDispatcher } from '../../src/signal/dispatcher.js';
import { createDeliveryStore } from '../../src/signal/delivery/signalDeliveryStore.js';

// 替身形状必须与生产同形：attemptCount 读 MAX(attempts) → 返回 { c }（见 dispatcher.test.js 的同族说明）
function fakeQuery({ signals = [], sent = [], counts = {} } = {}) {
  return async (sql, params) => {
    if (/SELECT DISTINCT channel/.test(sql)) return { rows: sent.map((c) => ({ channel: c })) };
    if (/MAX\(attempts\)/.test(sql)) return { rows: [{ c: counts[`${params[0]}|${params[1]}`] ?? 0 }] };
    if (/FROM crm\.signal\b/.test(sql)) return { rows: signals };
    return { rows: [] };
  };
}

function captureStore() {
  const calls = [];
  return { calls, record: vi.fn(async (r) => { calls.push(r); return r; }) };
}

function makeDispatcher({ decisions, signals = [{ signal_id: 's1', tenant_id: 't1' }], sent = [], counts = {}, retryLimit = 1 }) {
  const store = captureStore();
  const registry = { deliver: vi.fn(async () => ({ ok: true })) };
  const d = createDispatcher({
    query: fakeQuery({ signals, sent, counts }),
    deliveryRegistry: registry,
    deliveryStore: store,
    router: { ALL_CHANNELS: ['inbox', 'email', 'im', 'webhook'], resolve: vi.fn(async () => ({ configured: true, reason: null, policy: { channels: ['inbox', 'email'], retryLimit }, decisions })) },
  });
  return { d, store, registry };
}

describe('attempts 语义：只有真实投递尝试才累加', () => {
  it('渠道级 skip（no_recipient）→ record 必须带 countAttempt:false', async () => {
    const { d, store, registry } = makeDispatcher({
      decisions: [{ channel: 'email', recipient: null, skip: true, reason: 'no_recipient' }],
    });
    await d.pumpOnce({ tenantId: 't1' });
    expect(registry.deliver).not.toHaveBeenCalled();
    expect(store.calls).toHaveLength(1);
    expect(store.calls[0]).toMatchObject({ channel: 'email', status: 'skipped', last_error: 'no_recipient', countAttempt: false });
  });

  it('超重试上限（retry_exhausted）→ record 必须带 countAttempt:false（否则每轮泵 +1，无界增长）', async () => {
    const { d, store } = makeDispatcher({
      decisions: [{ channel: 'email', recipient: 'a@b.c', skip: false, reason: null }],
      counts: { 's1|email': 9 },   // 9 > retryLimit(1) ⇒ 走终结分支
    });
    await d.pumpOnce({ tenantId: 't1' });
    expect(store.calls).toHaveLength(1);
    expect(store.calls[0]).toMatchObject({ status: 'skipped', last_error: 'retry_exhausted', countAttempt: false });
  });

  it('正常投递路径 dispatcher 不自记（provider 内部负责），故不出现 countAttempt:false', async () => {
    const { d, store, registry } = makeDispatcher({
      decisions: [{ channel: 'email', recipient: 'a@b.c', skip: false, reason: null }],
      counts: { 's1|email': 0 },
    });
    await d.pumpOnce({ tenantId: 't1' });
    expect(registry.deliver).toHaveBeenCalledTimes(1);
    expect(store.calls).toHaveLength(0);
  });
});

describe('store 层：countAttempt 必须真正落到 SQL 参数（不得只在编排层传、store 层忽略）', () => {
  function capturePool() {
    const seen = [];
    return { seen, query: async (sql, params) => { seen.push({ sql, params }); return { rows: [{ delivery_id: 'x' }] }; } };
  }

  it('countAttempt=false → SQL 参数第 10 位为 false，且 SQL 不无条件累加', async () => {
    const pool = capturePool();
    const store = createDeliveryStore(pool);
    await store.record({ signal_id: 's1', channel: 'email', status: 'skipped', last_error: 'retry_exhausted', countAttempt: false });
    const [q] = pool.seen;
    expect(q.params[9], 'countAttempt 未透传到 SQL 参数').toBe(false);
    // 累加表达式必须受参数约束（CASE WHEN $10::boolean ...）——否则 skip 会无界累加
    expect(q.sql).toMatch(/attempts\s*=\s*CASE WHEN \$10::boolean THEN signal_delivery\.attempts \+ 1 ELSE signal_delivery\.attempts END/);
    expect(q.sql).toMatch(/VALUES \([^)]*CASE WHEN \$10::boolean THEN 1 ELSE 0 END/);
  });

  it('默认（未传）→ 视为真实尝试：参数为 true，attempts 递增', async () => {
    const pool = capturePool();
    const store = createDeliveryStore(pool);
    await store.record({ signal_id: 's1', channel: 'email', status: 'failed', last_error: 'smtp_error' });
    const [q] = pool.seen;
    expect(q.params[9]).toBe(true);
  });

  it('反回退守卫：SQL 中不得存在无条件的 attempts 自增（剥离注释后断言）', async () => {
    const pool = capturePool();
    const store = createDeliveryStore(pool);
    await store.record({ signal_id: 's1', channel: 'email', status: 'failed' });
    const codeOnly = pool.seen[0].sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    // 无条件形态：attempts = signal_delivery.attempts + 1（前面没有 CASE WHEN $10）
    const unconditional = /attempts\s*=\s*signal_delivery\.attempts \+ 1/;
    expect(unconditional.test(codeOnly.replace(/CASE WHEN \$10::boolean THEN signal_delivery\.attempts \+ 1 ELSE signal_delivery\.attempts END/g, '«guarded»')),
      '存在无条件的 attempts 自增 → skip 会随每轮泵无界增长').toBe(false);
  });
});
