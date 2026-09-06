// test/scheduler/retro-catchup.test.js — 决策复盘启动补跑 catch-up（2026-09-03 实证新增）
// 背景：定时器只在进程启动那一刻注册，夜间窗口错过即永久丢失（decision_retro_report 曾长期 0 行）。
// 隔离：db.js / events.bus / monitorStore / decision.retro 全 mock → 不触真实 PG、不发真实 LLM。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ rows: [], traces: [], failures: [] }));

vi.mock('../../src/db.js', () => ({
  query: async () => ({ rows: h.rows, rowsAffected: 0 }),
  default: { query: async () => ({ rows: h.rows, rowsAffected: 0 }) },
}));
vi.mock('../../src/events/bus.js', () => ({
  emit: (domain, type, payload) => h.traces.push({ domain, type, payload }),
}));
vi.mock('../../src/monitor/monitorStore.js', () => ({
  recordFailure: (kind, err) => h.failures.push({ kind, err }),
}));
vi.mock('../../src/decision/retro.js', () => ({
  runDecisionRetro: async () => ({ summary: {}, draft_patches: [] }),
}));

import { catchUpRetro, nextRetroAt, CATCHUP_MAX_AGE_HOURS } from '../../src/scheduler/timers.js';

const HOUR = 3600 * 1000;
// 固定"当天 10:00"作为基线时钟：距次日 02:00 有 16h，远离 near_schedule 护栏
const BASE = new Date('2026-09-03T02:00:00Z').getTime(); // UTC 02:00 = 北京 10:00

beforeEach(() => {
  h.rows = [];
  h.traces = [];
  h.failures = [];
});

describe('复盘 catch-up · 时点计算', () => {
  it('nextRetroAt：今日 02:00 已过 → 顺延次日 02:00', () => {
    const t0 = new Date('2026-09-03T10:00:00+08:00'); // 已过当日 02:00
    const next = nextRetroAt(t0);
    expect(next.getHours()).toBe(2);
    expect(next.getDate()).toBe(t0.getDate() + 1);
  });

  it('nextRetroAt：今日 02:00 未到 → 今日 02:00', () => {
    const t0 = new Date('2026-09-03T00:30:00+08:00');
    const next = nextRetroAt(t0);
    expect(next.getHours()).toBe(2);
    expect(next.getDate()).toBe(t0.getDate());
  });
});

describe('复盘 catch-up · 触发判据', () => {
  it('无历史报告（表空）→ 立即补跑', async () => {
    h.rows = [];
    const run = vi.fn(async () => {});
    const r = await catchUpRetro({ run, nowMs: BASE });
    expect(r).toMatchObject({ ran: true, reason: 'stale' });
    expect(run).toHaveBeenCalledTimes(1);
    expect(h.traces.some((t) => t.type === 'decision-retro-catchup-start')).toBe(true);
  });

  it(`报告距今 < ${CATCHUP_MAX_AGE_HOURS}h → 跳过（天然限流，重启再频繁也不重跑）`, async () => {
    h.rows = [{ run_at: new Date(BASE - 3 * HOUR).toISOString() }];
    const run = vi.fn(async () => {});
    const r = await catchUpRetro({ run, nowMs: BASE });
    expect(r.ran).toBe(false);
    expect(r.reason).toBe('fresh');
    expect(run).not.toHaveBeenCalled();
  });

  it('报告距今 > 24h → 补跑（本次故障的正命中场景）', async () => {
    h.rows = [{ run_at: new Date(BASE - 40 * HOUR).toISOString() }];
    const run = vi.fn(async () => {});
    const r = await catchUpRetro({ run, nowMs: BASE });
    expect(r).toMatchObject({ ran: true, reason: 'stale' });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('距下次 02:00 不足 30min → 交给定时，避免双跑', async () => {
    // 构造：报告很旧（应补跑），但当前时刻距次日 02:00 仅 10 分钟
    const nearNext = nextRetroAt(new Date(BASE)).getTime() - 10 * 60 * 1000;
    h.rows = [{ run_at: new Date(nearNext - 40 * HOUR).toISOString() }];
    const run = vi.fn(async () => {});
    const r = await catchUpRetro({ run, nowMs: nearNext });
    expect(r).toMatchObject({ ran: false, reason: 'near_schedule' });
    expect(run).not.toHaveBeenCalled();
  });
});

describe('复盘 catch-up · 失败留痕（禁裸 catch）', () => {
  it('DB 探测失败 → 返回 error 且 emit trace + recordFailure，不外抛', async () => {
    // 让 query 抛：把 rows getter 改为抛错
    h.rows = [{ get run_at() { throw new Error('db down'); } }];
    const run = vi.fn(async () => {});
    const r = await catchUpRetro({ run, nowMs: BASE }).catch((e) => ({ threw: String(e.message) }));
    expect(r.threw).toBeUndefined();
    expect(r.reason).toBe('error');
    expect(run).not.toHaveBeenCalled();
    expect(h.traces.some((t) => t.type === 'decision-retro-catchup-failed')).toBe(true);
    expect(h.failures.some((f) => f.kind === 'decision-retro-catchup-failed')).toBe(true);
  });
});
