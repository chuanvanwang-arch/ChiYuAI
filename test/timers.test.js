// test/timers.test.js — 定时器（③ 定时规则驱动的数据产生）
// 设计输入：12 文档 §7-3（nightly 蒸馏 24h + crm-risk 30min 扫描）；纯逻辑测试，不依赖 PG
import { describe, it, expect, vi, afterEach } from 'vitest';

// 隔离 SLA 物化模块：预热断言只关心「是否被调用」，不触碰测试库
const slaMock = vi.fn(async () => ({ ok: true, inserted: 1 }));
vi.mock('../src/decision/auditabilitySla.js', () => ({
  materializeAuditabilitySla: (...a) => slaMock(...a),
}));

import { ensureTimers, timerCount, clearTimers } from '../src/scheduler/timers.js';

afterEach(() => { clearTimers(); slaMock.mockClear(); });

// 基线数量（timers.js 启动时实注册，逐项对应 timers.set 调用）：
//   nightly-distill / crm-risk-scan / lead-pool-recycle / decision-retro-boot
//   / sales-daily-scan / named-visit-scan / auditability-sla-snapshot / ready-queue-pump
//   / provenance-patrol（C2 审计链巡检，2026-09-03）/ integration-poll（外部数据接入, 2026-09-14）
//   / calibration-sla-scan（D6 校准 SLA 超时升级扫描，2026-09-14）
//   / signal-schedule-scan（S5 T15 时间型信号扫描，2026-09-16）/ prospect-scan（S5 T16 拓客信号扫描，2026-09-16）
//   / research-scheduler（S5 T17 L3 主动研究调度，2026-09-16）
//   / grant-sweep（S6 T19 常驻授权凭证巡检，2026-09-16）
//   / signal-observability-scan（S7 T20 信号链路观测巡检，2026-09-16）
//   / signal-dispatch（全链集成 Q1-3 信号投递编排泵，2026-09-16）
// 注：decision-retro 与 decision-retro-boot 互斥——boot 是次日志对齐的 setTimeout，
//     触发后才注册 decision-retro 常驻 interval，故启动瞬间为 17（11 基线 + S5 三定时器 + S6 一定时器 + S7 一定时器 + 全链集成 Q1 一定时器）。
const EXPECTED_TIMERS = 17;

describe('定时器（③ 规则驱动）', () => {
  it('ensureTimers 返回注册数量（17 个：含 ready-queue-pump、C2 审计链巡检、integration-poll、calibration-sla-scan、S5 signal/prospect/research 三定时器、S6 grant-sweep、S7 signal-observability-scan、Q1 signal-dispatch）', async () => {
    const n = await ensureTimers({ now: '2026-08-25T00:00:00Z' });
    expect(n).toBe(EXPECTED_TIMERS);
  });

  // 幂等性断言刻意不写死数字：新增定时器不应破坏「不叠加」这一不变式，
  // 只需保证重复注册后数量与首次一致（未来扩展免维护）。
  it('幂等单例：重复 ensureTimers 不叠加（防双实例）', async () => {
    const n1 = await ensureTimers({});
    await ensureTimers({});
    expect(timerCount()).toBe(n1);
    expect(n1).toBe(EXPECTED_TIMERS);
  });

  it('clearTimers 后计时器清空，可重新注册', async () => {
    const n1 = await ensureTimers({});
    clearTimers();
    expect(timerCount()).toBe(0);
    const n2 = await ensureTimers({});
    expect(n2).toBe(n1);
  });

  // 2026-09-02 修复「闭环 0 数据」：setInterval 首次触发需等满一个周期（默认 6h），
  // 生产实测 agent_sla 仅 1 行（服务重启后首屏恒空 6 小时）→ 注册时立即预热一次。
  it('SLA 快照启动预热：ensureTimers 时立即物化一次（非等满首个 6h 周期）', async () => {
    // 先排空上一用例泄漏的异步预热（afterEach 清 mock 时其 promise 可能尚未 resolve）
    await new Promise((r) => setTimeout(r, 0));
    slaMock.mockClear();
    await ensureTimers({});
    await new Promise((r) => setTimeout(r, 0)); // 排空动态 import 的微任务链
    expect(slaMock).toHaveBeenCalledTimes(1);
    expect(slaMock.mock.calls[0][0]).toMatchObject({ limit: 50 });
  });

  it('预热失败不外抛（留痕不阻断启动）', async () => {
    slaMock.mockRejectedValueOnce(new Error('db down'));
    await expect(ensureTimers({})).resolves.toBe(EXPECTED_TIMERS);
    await new Promise((r) => setTimeout(r, 0));
    expect(slaMock).toHaveBeenCalled();
  });
});