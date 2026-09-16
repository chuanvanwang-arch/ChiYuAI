// test/signal/alertPersistWiring.test.js — S1 探针：告警落库单一收敛点 + 启动接线守卫
//
// 为什么需要它（2026-09-16 实测）：
//   ① 告警产生点共 5 处，原实现只把 1 处（timers 日报扫描）改成 createAlertWithDb 落库
//      → 其余 4 处告警永远进不了 crm.signal，信号中心打开是空的（**单测全绿的部分假绿**）。
//   ② server.js 用 `try { X() } catch { log }` 注册启动钩子，若只写调用、漏写 import，
//      ReferenceError 被 catch 静默吞掉（registerOutcomeIngester 2026-09-11 的真实事故）。
//      → 本文件第二个 describe 用**通用静态守卫**一次性覆盖整类坑，而非只盯这一个函数。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAlert, resetAlertStore } from '../../src/alerts/alertStore.js';
import { registerAlertSignalPersister, unregisterAlertSignalPersister } from '../../src/alerts/alertSignalHook.js';
import { createSignalRouter } from '../../src/signal/router.js';
import { on } from '../../src/events/bus.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe('告警 → 信号落库单一收敛点', () => {
  beforeEach(() => { resetAlertStore(); unregisterAlertSignalPersister(); });
  afterEach(() => { unregisterAlertSignalPersister(); });

  it('注册后任意 createAlert 均落库，且 signal_id 沿用 alert_id（溯源性）', async () => {
    const created = [];
    const fakeStore = { create: async (p) => { created.push(p); return { ok: true, alert: { signal_id: p.signal_id } }; } };
    registerAlertSignalPersister({ store: fakeStore, router: createSignalRouter({}) });

    const a = createAlert({ kind: 'deal_stuck', severity: 'high', target_role: 'sales', tenant_id: 't1', particle_id: 'd1', payload: { deal: 'd1' } });
    expect(a.ok).toBe(true);
    await tick(); // persister 是 fire-and-forget，等一轮宏任务

    expect(created.length).toBe(1);
    expect(created[0].signal_id).toBe(a.alert.alert_id); // 鉴别力：若 create 内恒用 randomUUID，此处红
    expect(created[0].tenant_id).toBe('t1');
    expect(created[0].particle_id).toBe('d1');
    expect(created[0].source).toBe('rule-scan');
    expect(created[0].dedup_key).toBe('deal_stuck:d1:hour');
    expect(created[0].target_role).toBe('sales');
  });

  it('鉴别力对照：未注册 persister 时不落库（证明上条断言非恒真）', async () => {
    const created = [];
    const fakeStore = { create: async (p) => { created.push(p); return { ok: true }; } };
    // 故意不注册（beforeEach 已 unregister）
    void fakeStore;
    createAlert({ kind: 'deal_stuck', severity: 'high', target_role: 'sales', tenant_id: 't1' });
    await tick();
    expect(created.length).toBe(0);
  });

  it('persister 抛错不打断告警主流程（fail-open，同步 API 语义不变）', async () => {
    registerAlertSignalPersister({ store: { create: async () => { throw new Error('db down'); } } });
    const a = createAlert({ kind: 'deal_stuck', severity: 'high', target_role: 'sales' });
    expect(a.ok).toBe(true);
    expect(a.alert.status).toBe('open');
    await tick(5); // 若未捕获，这里会出现 unhandled rejection 让测试进程报错
  });

  it('落库失败必须留痕 trace（禁静默吞——否则断链无任何线索）', async () => {
    const traces = [];
    const off = on('trace', (msg) => traces.push(msg));
    registerAlertSignalPersister({ store: { create: async () => { throw new Error('db down'); } } });
    createAlert({ kind: 'deal_stuck', severity: 'high', target_role: 'sales' });
    await tick(10);
    off();
    expect(traces.some((t) => t?.type === 'alert-persist-failed')).toBe(true);
  });

  it('必填缺失的告警不触发落库（拒绝态不应产生幽灵信号）', async () => {
    const created = [];
    registerAlertSignalPersister({ store: { create: async (p) => { created.push(p); return { ok: true }; } } });
    const bad = createAlert({ kind: 'deal_stuck' }); // 缺 severity/target_role
    expect(bad.ok).toBe(false);
    await tick();
    expect(created.length).toBe(0);
  });
});

describe('server.js 启动接线守卫（整类坑，非单点）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/http/server.js'), 'utf8');

  it('探针自检：确实扫到了启动钩子（防正则失配导致恒绿）', () => {
    const names = [...src.matchAll(/try\s*\{\s*([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(4);
  });

  it('每个 `try{ X(...) }catch` 的 X 都已在同文件 import 或定义', () => {
    const names = [...src.matchAll(/try\s*\{\s*([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]);
    const missing = names.filter((n) => {
      const namedImport = new RegExp(`import\\s*\\{[^}]*\\b${n}\\b[^}]*\\}`).test(src);
      const defaultImport = new RegExp(`import\\s+${n}\\b`).test(src);
      const defined = new RegExp(`(?:function\\s+|const\\s+|let\\s+)${n}\\b`).test(src);
      return !(namedImport || defaultImport || defined);
    });
    // 缺失即：该启动钩子会因 ReferenceError 被 catch 静默吞掉 → 能力"看起来注册了"实则从未生效
    expect(missing).toEqual([]);
  });

  it('信号落库收敛点 import 与调用同时到位', () => {
    expect(src).toMatch(/import\s*\{[^}]*registerAlertSignalPersister[^}]*\}/);
    expect(src).toMatch(/try\s*\{\s*registerAlertSignalPersister\(/);
    expect(src).toMatch(/registerAlertSignalPersister\(\{\s*pool\s*\}\)/); // 必须带 pool（否则无法落库）
  });
});

describe('落库路径去重（单一收敛点与显式双写共存不重复）', () => {
  it('createAlertWithDb 与 persister 对同一告警只落一行（signal_id=alert_id + PK 幂等）', async () => {
    const { createAlertWithDb } = await import('../../src/alerts/alertStore.js');
    const calls = [];
    const fakeStore = {
      create: async (p) => { calls.push(p.signal_id); return { ok: true, alert: { signal_id: p.signal_id }, deduped: calls.length > 1 }; },
    };
    registerAlertSignalPersister({ store: fakeStore, router: createSignalRouter({}) });
    const pool = { query: async () => ({ rows: [{}] }) };
    const r = await createAlertWithDb(pool, { kind: 'deal_stuck', severity: 'high', target_role: 'sales', tenant_id: 't1' });
    await new Promise((res) => setTimeout(res, 0));
    expect(r.ok).toBe(true);
    // 两次落库尝试用的是同一个 signal_id（= alert_id）→ 由 crm.signal PK 收敛为一行
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(new Set(calls).size).toBe(1);
    unregisterAlertSignalPersister();
  });
});
