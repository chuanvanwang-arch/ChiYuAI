// src/signal/followupRouter.js — 对象变化事件 → followup 重评（T06）
// 设计输入：docs/2026-09-15-final-design-coexistence-and-proactive.md §T06
// 契约：onObjectChanged({object,externalId,tenantId}) → engine.reevaluate → appendMemory（合并不覆盖子键）
// 事件域：订阅 bus 'external' 域的 object_changed 事件（S2 同步写入 external_ref 时 emit）
import { on, emit } from '../events/bus.js';

export function createFollowupRouter({ engine } = {}) {
  let registered = false;
  // 订阅对象变化事件域（external-ref 写入/更新时 emit('external', 'object_changed', ...)）
  function register() {
    if (registered) return () => {};
    registered = true;
    const off = on('external', async (msg) => {
      try {
        if (msg?.type !== 'object_changed') return;
        await onObjectChanged(msg.payload || {});
      } catch (e) {
        // 重评失败不阻断事件总线（隔离）
        // eslint-disable-next-line no-console
        console.warn('[followup] reeval failed:', e.message);
      }
    });
    return off;
  }

  // 对象变化 → 触发重评：调 engine.reevaluate（事件驱动即时，节律兜底）
  // 返回 engine 完整结果 { ok, signal, memory }（ok 为 false 时透传错误语义）
  async function onObjectChanged({ object, externalId, tenantId = 'system', changedAt } = {}) {
    if (!engine || typeof engine.reevaluate !== 'function') return false;
    const r = await engine.reevaluate({ object, externalId, tenantId, changedAt: changedAt || new Date().toISOString() }).catch(() => ({ ok: false, error: 'reevaluate_threw' }));
    return r;
  }

  // 重评完成 → 广播结果（供 digest/销售自动化页消费）
  function emitResult(result) {
    emit('external', 'reeval_done', result);
  }

  return { register, onObjectChanged, emitResult };
}
