// src/kanban/dispatch.js — 并发限流派发队列
// 设计输入：docs/2026-08-24-ai-native-sales-crm-design.md §03 编排设计（max_inflight=3）
// 并发上限保护下游 LLM / 工具额度；指数退避 + 抖动用于失败重试
import { MAX_INFLIGHT } from './types.js';

export function createDispatchQueue({ maxInflight = MAX_INFLIGHT, backoffMs = 200 } = {}) {
  let inflight = 0;
  const queue = [];

  function pump() {
    while (inflight < maxInflight && queue.length > 0) {
      const { fn, resolve, reject } = queue.shift();
      inflight++;
      fn()
        .then(resolve, reject)
        .finally(() => { inflight--; pump(); });
    }
  }

  return {
    // inflight 暴露为 getter：反映真实并发（闭包变量），调度循环结束后归 0
    get inflight() { return inflight; },
    get inflightCount() { return inflight; },
    // 入队：push(id, fn)；超过 maxInflight 的任务在 pump 中排队
    push(id, fn) {
      return new Promise((resolve, reject) => {
        queue.push({ id, fn, resolve, reject });
        pump();
      });
    },
    // 指数退避 + 抖动（attempt 从 0 计）
    backoff(attempt) {
      return backoffMs * Math.pow(2, attempt) + Math.floor(Math.random() * 50);
    },
  };
}
