// src/signal/delivery/inbox.js — 默认渠道：写入工作台第 7 视角（DB 消费）
// 设计输入：docs/2026-09-15-final-design-coexistence-and-proactive.md §8.4（投递四渠道，inbox 默认）
// inbox 恒可用：工作台视角消费 crm.signal 完成「投递」，此处只落流水标记发送意图
export function createInboxProvider(opts = {}) {
  return {
    name: 'inbox',
    verifyConfig() { return { ok: true }; },
    async send({ signal, deliveryStore }) {
      await deliveryStore.record({
        signal_id: signal.signal_id,
        tenant_id: signal.tenant_id,
        channel: 'inbox',
        provider: 'inbox',
        status: 'sent',
      });
      return { ok: true };
    },
  };
}
