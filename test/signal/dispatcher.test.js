// test/signal/dispatcher.test.js — 投递编排器（注入替身 query / store / registry，不依赖 PG）
// 设计输入：docs/2026-09-16-full-chain-integration-design.md v1.1 §3.1 / §3.1.1（D1/D2）
import { describe, it, expect, vi } from 'vitest';
import { createDispatcher } from '../../src/signal/dispatcher.js';

// 极简替身 query：按 SQL 特征分发
// 注意：`/FROM crm\.signal\b/` 的 `\b` 是必需的——否则会把 `crm.signal_delivery` 一并匹配，
//   导致「sent 渠道集合」查询误走 signal 分支（替身形状错误 = 假绿来源之一）。
// 分支顺序亦为契约：`SELECT DISTINCT channel` 必须先于 `FROM crm.signal` 判定。
function fakeQuery({ signals = [], sent = [], counts = {} } = {}) {
  return async (sql, params) => {
    if (/SELECT DISTINCT channel/.test(sql)) {
      return { rows: sent.map((c) => ({ channel: c })) };
    }
    if (/COUNT\(\*\)::int AS c/.test(sql)) {
      return { rows: [{ c: counts[`${params[0]}|${params[1]}`] ?? 0 }] };
    }
    if (/FROM crm\.signal\b/.test(sql)) return { rows: signals };
    return { rows: [] };
  };
}

function fakeStore() {
  const rows = [];
  return { rows, record: vi.fn(async (r) => { rows.push(r); return r; }) };
}

function fakeRouter(decisions, extra = {}) {
  return {
    ALL_CHANNELS: ['inbox', 'email', 'im', 'webhook'],
    resolve: vi.fn(async () => ({ configured: true, reason: null, policy: { channels: ['inbox'] }, decisions, ...extra })),
  };
}

describe('dispatcher 幂等（同一 signal+channel 已 sent 不重投）', () => {
  it('已 sent 的渠道被跳过，registry 不被调用', async () => {
    const registry = { deliver: vi.fn(async () => ({ ok: true })) };
    const store = fakeStore();
    const d = createDispatcher({
      query: fakeQuery({ signals: [{ signal_id: 's1', tenant_id: 't1' }], sent: ['inbox'] }),
      deliveryRegistry: registry,
      deliveryStore: store,
      router: fakeRouter([{ channel: 'inbox', recipient: null, skip: false, reason: null }]),
    });
    const r = await d.pumpOnce({ tenantId: 't1' });
    expect(registry.deliver).not.toHaveBeenCalled();
    expect(store.rows).toHaveLength(0);
    expect(r).toMatchObject({ signals: 1, sent: 0, failed: 0, skipped: 0 });
  });

  it('未 sent 的渠道被投递一次', async () => {
    const registry = { deliver: vi.fn(async () => ({ ok: true })) };
    const store = fakeStore();
    const d = createDispatcher({
      query: fakeQuery({ signals: [{ signal_id: 's2', tenant_id: 't1' }] }),
      deliveryRegistry: registry,
      deliveryStore: store,
      router: fakeRouter([{ channel: 'inbox', recipient: null, skip: false, reason: null }]),
    });
    const r = await d.pumpOnce({ tenantId: 't1' });
    expect(registry.deliver).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ sent: 1 });
  });
});

describe('dispatcher 非静默留痕', () => {
  it('渠道级 skip（no_recipient）→ 落 skipped 行且带 last_error', async () => {
    const registry = { deliver: vi.fn() };
    const store = fakeStore();
    const d = createDispatcher({
      query: fakeQuery({ signals: [{ signal_id: 's3', tenant_id: 't1' }] }),
      deliveryRegistry: registry,
      deliveryStore: store,
      router: fakeRouter([{ channel: 'email', recipient: null, skip: true, reason: 'no_recipient' }]),
    });
    await d.pumpOnce({ tenantId: 't1' });
    expect(registry.deliver).not.toHaveBeenCalled();
    expect(store.rows).toEqual([
      expect.objectContaining({ signal_id: 's3', channel: 'email', status: 'skipped', last_error: 'no_recipient' }),
    ]);
  });

  it('provider 返回 ok:false → 计入 failed（流水由 provider 自行落地，编排器不补记）', async () => {
    const registry = { deliver: vi.fn(async () => ({ ok: false, error: 'smtp_not_configured' })) };
    const store = fakeStore();
    const d = createDispatcher({
      query: fakeQuery({ signals: [{ signal_id: 's4', tenant_id: 't1' }] }),
      deliveryRegistry: registry,
      deliveryStore: store,
      router: fakeRouter([{ channel: 'email', recipient: 'a@b.c', skip: false, reason: null }]),
    });
    const r = await d.pumpOnce({ tenantId: 't1' });
    expect(r.failed).toBe(1);
    expect(store.rows).toHaveLength(0); // 防双记：provider 内部已 record
  });
});

describe('dispatcher 重试上限（retryLimit 来自配置，无配置即 0）', () => {
  it('retryLimit=0 且已有 1 次尝试 → 跳过（不再投递）', async () => {
    const registry = { deliver: vi.fn() };
    const store = fakeStore();
    const d = createDispatcher({
      query: fakeQuery({ signals: [{ signal_id: 's5', tenant_id: 't1' }], counts: { 's5|email': 1 } }),
      deliveryRegistry: registry,
      deliveryStore: store,
      router: fakeRouter([{ channel: 'email', recipient: 'a@b.c', skip: false, reason: null }]),
    });
    const r = await d.pumpOnce({ tenantId: 't1' });
    expect(registry.deliver).not.toHaveBeenCalled();
    expect(r.skipped).toBe(1);
  });

  it('retryLimit=2 且已有 1 次尝试 → 继续投递', async () => {
    const registry = { deliver: vi.fn(async () => ({ ok: true })) };
    const store = fakeStore();
    const d = createDispatcher({
      query: fakeQuery({ signals: [{ signal_id: 's6', tenant_id: 't1' }], counts: { 's6|email': 1 } }),
      deliveryRegistry: registry,
      deliveryStore: store,
      router: fakeRouter([{ channel: 'email', recipient: 'a@b.c', skip: false, reason: null }],
        { policy: { channels: ['email'], retryLimit: 2 } }),
    });
    const r = await d.pumpOnce({ tenantId: 't1' });
    expect(registry.deliver).toHaveBeenCalledTimes(1);
    expect(r.sent).toBe(1);
  });
});

describe('dispatcher 全租户泵（单租户失败不中断其余）', () => {
  it('pumpAllTenants 收集失败项而非抛出', async () => {
    let call = 0;
    const q = async (sql) => {
      if (/SELECT DISTINCT tenant_id/.test(sql)) return { rows: [{ tenant_id: 't1' }, { tenant_id: 't2' }] };
      call += 1;
      if (call === 1) throw new Error('db down');
      return { rows: [] };
    };
    const d = createDispatcher({
      query: q,
      deliveryRegistry: { deliver: vi.fn() },
      deliveryStore: fakeStore(),
      router: fakeRouter([]),
    });
    const r = await d.pumpAllTenants({});
    expect(r.tenants).toBe(2);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0].tenant_id).toBe('t1');
  });

  // ---- D1（设计 §3.1.1 修正，2026-09-16）：泵范围必须含 system ----
  it('D1：候选租户集 SQL 不得排除 system（负向断言，防 D1 回归）', async () => {
    const seen = [];
    const d = createDispatcher({
      query: async (sql) => { seen.push(sql); return { rows: [] }; },
      deliveryRegistry: { deliver: vi.fn() },
      deliveryStore: fakeStore(),
      router: fakeRouter([]),
    });
    await d.pumpAllTenants({});
    const candidateSql = seen.find((s) => /SELECT DISTINCT tenant_id/.test(s));
    expect(candidateSql).toBeTruthy();
    // ⚠ 守卫方式说明：**不可**用「grep dispatcher.js 禁该串」做守卫 —— 该文件注释里就有这个字面量
    //   （用于说明为何禁用），grep 会命中注释产生假红（代码写得越清楚越红）。唯一正确的守卫是
    //   对**传给 query 的 SQL 字符串**断言，即本用例。
    expect(candidateSql).not.toMatch(/tenant_id\s*<>\s*'system'/);
  });

  it('D1：system 租户的 signal 确实被泵（pumpOnce 以 system 调用）', async () => {
    const pumped = [];
    const d = createDispatcher({
      query: async (sql, params) => {
        if (/SELECT DISTINCT tenant_id/.test(sql)) return { rows: [{ tenant_id: 'system' }] };
        if (/SELECT DISTINCT channel/.test(sql)) return { rows: [] };
        if (/FROM crm\.signal\b/.test(sql)) { pumped.push(params[0]); return { rows: [] }; }
        return { rows: [] };
      },
      deliveryRegistry: { deliver: vi.fn() },
      deliveryStore: fakeStore(),
      router: fakeRouter([]),
    });
    const r = await d.pumpAllTenants({});
    expect(pumped).toEqual(['system']);
    expect(r.tenants).toBe(1);
  });

  // ---- D2（设计 §3.1.1 修正）：候选集受时间窗约束，且窗口只收窄、不删行 ----
  it('D2：候选集 SQL 含时间窗谓词，且全程零 DELETE/UPDATE', async () => {
    const seen = [];
    const d = createDispatcher({
      query: async (sql) => { seen.push(sql); return { rows: [] }; },
      deliveryRegistry: { deliver: vi.fn() },
      deliveryStore: fakeStore(),
      router: fakeRouter([]),
      readConfig: async () => ({ value: { max_age_days: 3 } }), // 平台级旋钮
    });
    await d.pumpAllTenants({});
    const candidateSql = seen.find((s) => /SELECT DISTINCT tenant_id/.test(s));
    expect(candidateSql).toMatch(/created_at >= now\(\) - make_interval\(days => \$1\)/);
    expect(seen.some((s) => /DELETE|UPDATE/i.test(s))).toBe(false); // 窗口只收窄候选集，绝不删/迁移行
    expect(await d.resolveWindowDays()).toBe(3);
  });

  it('D2：配置缺省 → 窗口回落到兜底天数（不因配置缺失而泵空/泵满）', async () => {
    const d = createDispatcher({
      query: async () => ({ rows: [] }),
      deliveryRegistry: { deliver: vi.fn() },
      deliveryStore: fakeStore(),
      router: fakeRouter([]),
    });
    expect(await d.resolveWindowDays()).toBe(7); // 无 readConfig 注入 → 兜底值
  });
});

// ---- P-5（执行期修正，2026-09-16）：零投递必须可归因，不得静默空转 ----
// 背景：真实库 crm_native 中 signal-delivery 配置为**零行**（419 条 open signal / signal_delivery 恒 0）。
//   若无本字段，本泵上线后会是「每 5 分钟空转、零日志」——「面板无告警」与「链路已通」不可区分。
describe('dispatcher 空转可归因（P-5：零投递 ≠ 无事发生）', () => {
  it('租户未配置渠道 → pumpOnce 回带 idle 原因（而非静默零）', async () => {
    const registry = { deliver: vi.fn() };
    const d = createDispatcher({
      query: fakeQuery({ signals: [{ signal_id: 's9', tenant_id: 't1' }] }),
      deliveryRegistry: registry,
      deliveryStore: fakeStore(),
      router: {
        ALL_CHANNELS: ['inbox', 'email', 'im', 'webhook'],
        resolve: vi.fn(async () => ({ configured: false, reason: 'delivery_config_missing', policy: {}, decisions: [] })),
      },
    });
    const r = await d.pumpOnce({ tenantId: 't1' });
    expect(registry.deliver).not.toHaveBeenCalled();
    expect(r.sent + r.failed + r.skipped).toBe(0);
    expect(r.idle).toEqual({ delivery_config_missing: 1 });
  });

  it('pumpAllTenants 跨租户聚合 idle 原因', async () => {
    const q = async (sql) => {
      if (/SELECT DISTINCT tenant_id/.test(sql)) return { rows: [{ tenant_id: 't1' }, { tenant_id: 't2' }] };
      if (/FROM crm\.signal\b/.test(sql)) return { rows: [{ signal_id: 's', tenant_id: 'x' }] };
      return { rows: [] };
    };
    const d = createDispatcher({
      query: q,
      deliveryRegistry: { deliver: vi.fn() },
      deliveryStore: fakeStore(),
      router: {
        ALL_CHANNELS: ['inbox', 'email', 'im', 'webhook'],
        resolve: vi.fn(async () => ({ configured: true, reason: 'no_channel_enabled', policy: {}, decisions: [] })),
      },
    });
    const r = await d.pumpAllTenants({});
    expect(r.tenants).toBe(2);
    expect(r.idle).toEqual({ no_channel_enabled: 2 });
    expect(r.sent + r.failed + r.skipped).toBe(0);
  });
});
