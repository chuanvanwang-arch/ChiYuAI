// src/events/bus.js — 进程内事件总线（同步分发，订阅者异常隔离）
// 订阅者抛错绝不阻断业务写路径（写时三钩子/编排派发都依赖 emit 不降级）
const handlers = new Map();

// 订阅某域（'*' 为全量订阅）；返回退订函数
export function on(domain, fn) {
  if (!handlers.has(domain)) handlers.set(domain, new Set());
  handlers.get(domain).add(fn);
  return () => handlers.get(domain)?.delete(fn);
}

export function off(domain, fn) {
  handlers.get(domain)?.delete(fn);
}

// emit(domain, type, payload) → 包装 { domain, type, ts, summary } 广播给全量 + 域订阅者
export function emit(domain, type, payload) {
  const msg = { domain, type, ts: Date.now(), summary: payload || {} };
  const all = handlers.get('*');
  if (all) {
    for (const fn of [...all]) {
      try {
        fn(msg);
      } catch (e) {
        console.error('[bus] handler error:', e?.message);
      }
    }
  }
  const set = handlers.get(domain);
  if (set) {
    for (const fn of [...set]) {
      try {
        fn(msg);
      } catch (e) {
        console.error('[bus] handler error:', e?.message);
      }
    }
  }
  return msg;
}
