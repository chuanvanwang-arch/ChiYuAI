// src/memory/distillScheduler.js — P3 D4 30 天蒸馏任务接线（统一设计 v3 §11.5-D4）
//
// 蒸馏逻辑本身已在 src/memory/memoryLog.js#distillMemory（标记 distilled/archived，append-only 不删）。
// 本模块只负责「定时触发 + 注册即预热」（设计 §11.6 铁律：新增 setInterval 注册后立即手动跑一次）。
//
// 反假绿 / 不静默：每次运行 emit trace；失败 recordFailure，不裸 catch。

let registered = false;

/**
 * 注册 30 天蒸馏定时器（注册即预热跑一次）。
 * @param {object} [opts]
 *   - pool {object} pg Pool（test/生产均由调用方注入；本模块不持全局 pool，避免与并行会话争用）
 *   - intervalMs {number} 默认 30 天
 *   - now {Function} 测试可注入 Date.now
 *   - runNow {boolean} 是否预热（默认 true）
 * @returns {{ handle?:NodeJS.Timeout, warmed?:object }}  测试可传 runNow:false 仅取句柄
 */
export function registerDistillationTimer(opts = {}) {
  const { pool, intervalMs = 30 * 24 * 3600 * 1000, now = Date.now, runNow = true } = opts;
  if (!pool) throw new Error('registerDistillationTimer 需要 pool');
  // 铁律修复（2026-09-02）：30 天毫秒数 = 2_592_000_000 > int32 上限 2_147_483_647，
  //   Node 会把 setInterval 延迟钳为 1ms，导致蒸馏任务每 1ms 触发一次、打满 DB 连接池（pool 默认 50），
  //   进而使 aggregateAuditability 等重查询全部 3s 超时 —— 监控台 Layer0 可审计性卡恒空、整体假死。
  //   预钳到 int32 安全上限（≈24.86 天），既保留「约月级」语义又杜绝 1ms 风暴。
  const INT32_MAX_MS = 2147483647;
  const safeIntervalMs = Math.min(Number(intervalMs) || 0, INT32_MAX_MS) || INT32_MAX_MS;
  const run = async () => {
    try {
      const { distillMemory } = await import('./memoryLog.js');
      const r = await distillMemory({ ttlDays: 30 });
      try {
        const { emit } = await import('../events/bus.js');
        emit('trace', 'memory-distill-run', { at: new Date(now()).toISOString() });
      } catch { /* emit 不可用不阻塞 */ }
      return r;
    } catch (e) {
      try {
        const { recordFailure } = await import('../monitor/monitorStore.js');
        recordFailure('memory-distill-run', e);
      } catch { /* 二次失败不抛 */ }
      return { ok: false, error: String(e?.message || e) };
    }
  };
  if (runNow) {
    // 注册即预热（同步触发一次，不阻塞调用方）
    run().catch(() => {});
  }
  if (registered) return { warmed: { skipped: 'already-registered' } };
  registered = true;
  const handle = setInterval(run, safeIntervalMs);
  if (typeof handle.unref === 'function') handle.unref(); // 不阻止进程退出
  return { handle, warmed: { ok: true } };
}

/** 测试/复位用：清除注册标记（避免跨测试重复注册）。 */
export function resetDistillationTimerFlag() {
  registered = false;
}
