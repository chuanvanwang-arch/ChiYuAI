// src/events/sse.js — SSE 事件总线端：单连接广播 5 事件域（task/trace/approval/particle/payment）
// 呼应 03 编排设计「观测面板与编排数据同源，SSE 单连接实时刷新」
import { on } from './bus.js';

export function createSseHub() {
  const clients = new Set();

  function connect(res) {
    // 生产 Express res 有 writeHead；测试用简化 fakeRes 可能无，容错跳过
    if (typeof res.writeHead === 'function') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
    }
    res.flushHeaders?.();
    clients.add(res);
    res.on?.('close', () => clients.delete(res));
    res.write(`event: connected\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
  }

  // 全量订阅：任意域事件 → 向所有 SSE 客户端写帧
  const unsubscribe = on('*', (msg) => {
    const frame = `event: ${msg.domain}\ndata: ${JSON.stringify(msg)}\n\n`;
    for (const res of clients) {
      try {
        res.write(frame);
      } catch {
        /* 客户端断开，下个 close 事件会清理 */
      }
    }
  });

  return {
    connect,
    clients,
    close: () => {
      unsubscribe();
      clients.clear();
    },
  };
}
