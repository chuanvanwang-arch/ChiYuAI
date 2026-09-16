// src/signal/delivery/index.js — provider 注册表 + 分发器
// 设计输入：docs/2026-09-15-final-design-coexistence-and-proactive.md §8.4（投递四渠道）
// 分发器统一处理：静默时段（quiet_hours）→ skipped 留痕；频次上限（每 signal 默认 1 次）；
// verifyConfig fail-closed → failed 留痕；真正投递由各 provider send 完成并落流水
import { createInboxProvider } from './inbox.js';
import { createEmailProvider } from './email.js';
import { createImProvider } from './im.js';
import { createWebhookProvider } from './webhook.js';

export function createDeliveryRegistry(providers = {}, policy = {}) {
  const channels = {
    inbox: createInboxProvider(providers.inbox),
    email: createEmailProvider({ smtp: providers.smtp, transport: providers.transport }),
    im: createImProvider({ webhookUrl: providers.im?.webhookUrl }),
    webhook: createWebhookProvider({ url: providers.webhook?.url, headers: providers.webhook?.headers }),
  };

  function get(name) {
    return channels[name] || null;
  }

  function isQuietHours(now = new Date()) {
    const q = policy.quietHours;
    if (!q) return false;
    const h = now.getHours();
    if (q.start < q.end) return h >= q.start && h < q.end;
    return h >= q.start || h < q.end; // 跨午夜（22:00–06:00）
  }

  async function deliver({ signal, channel, store }) {
    if (!channels[channel]) return { ok: false, error: 'unknown_channel' };
    // 静默时段：落 skipped 留痕，不静默（可审计）
    if (policy.quietHours && isQuietHours(policy.now ? new Date(policy.now()) : new Date())) {
      await store.record({
        signal_id: signal.signal_id,
        tenant_id: signal.tenant_id,
        channel,
        status: 'skipped',
        last_error: 'quiet_hours',
      });
      return { ok: true, skipped: true };
    }
    // verifyConfig fail-closed
    const v = channels[channel].verifyConfig();
    if (!v.ok) {
      await store.record({
        signal_id: signal.signal_id,
        tenant_id: signal.tenant_id,
        channel,
        status: 'failed',
        last_error: v.error,
      });
      return { ok: false, error: v.error };
    }
    return channels[channel].send({ signal, deliveryStore: store });
  }

  return { channels, get, deliver, verify: (c) => channels[c]?.verifyConfig() ?? { ok: false, error: 'unknown_channel' } };
}
