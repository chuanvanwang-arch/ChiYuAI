// src/memory/capture.js — 事件总线订阅者（residue 零摩擦单汇点）
import { appendMemory } from './memoryLog.js';
import { on } from '../events/bus.js';

const SKIP_DOMAINS = new Set(['decision']); // 决策由主轴委托写入，避免双写

export async function captureMemory(event) {
  if (!event || !event.type) return { ok: false, reason: 'no-event' };
  const domain = event.domain || 'event';
  if (SKIP_DOMAINS.has(domain)) return { ok: false, reason: 'skipped-domain' };
  const res = await appendMemory({
    topic: event.topic || `event:${domain}:${event.type}`,
    kind: event.kind || 'event',
    payload: event.payload ?? {},
    layer: event.layer || 'L-Workspace',
    actor: event.actor,
    eventType: event.type,
    explicit: !!event.explicit,
    valueHorizonDays: event.valueHorizonDays ?? 30,
  });
  return res;
}

export function registerCaptureSubscriber() {
  return on('*', (msg) => {
    captureMemory({ domain: msg.domain, type: msg.type, payload: msg.summary, actor: msg.summary?.actor })
      .catch(() => {});
  });
}
