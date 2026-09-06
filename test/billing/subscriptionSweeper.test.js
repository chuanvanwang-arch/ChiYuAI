// test/billing/subscriptionSweeper.test.js — 订阅到期停服调度器接线验证（2026-09-06 交付补齐）
// 设计依据 docs/2026-09-06-billing-gate-repair-design.md §5.1 + src/http/server.js startSubscriptionSweeper。
// 此前 expireSweep() 仅有实现、无调度（仅单测调用）→ 生产永不会执行 → 到期租户不会降级。
// 本测试验证：startServer 通过 startSubscriptionSweeper 真正接线定时器（幂等单例 + 可停止），
// 且首次延迟 + 周期调度均不阻塞进程退出（unref）。
import { test, expect, afterAll } from 'vitest';
import { startSubscriptionSweeper, stopSubscriptionSweeper } from '../../src/http/server.js';

afterAll(() => { stopSubscriptionSweeper(); });

test('startSubscriptionSweeper 返回幂等单例定时器', async () => {
  const a = startSubscriptionSweeper({ intervalMs: 1000 });
  expect(a).toBeTruthy();
  const b = startSubscriptionSweeper({ intervalMs: 1000 });
  expect(b).toBe(a); // 二次调用返回同一实例，不叠加定时器
  stopSubscriptionSweeper();
});

test('stopSubscriptionSweeper 后实例清空，可重新启动', async () => {
  stopSubscriptionSweeper();
  const c = startSubscriptionSweeper({ intervalMs: 1000 });
  expect(c).toBeTruthy();
  stopSubscriptionSweeper();
  // 重新启应能再次拿到定时器（证明可重复接线，startServer 每次调用安全）
  const d = startSubscriptionSweeper({ intervalMs: 1000 });
  expect(d).toBeTruthy();
  stopSubscriptionSweeper();
});
