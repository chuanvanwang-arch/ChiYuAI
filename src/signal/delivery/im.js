// src/signal/delivery/im.js — 钉钉/企微/飞书占位；未配置凭据 fail-closed
// 设计输入：docs/2026-09-15-final-design-coexistence-and-proactive.md §8.4（投递四渠道）
// 红线段：不学「投递即骚扰」——IM 渠道必须显式配置 webhook 才启用
// 真实推送到钉钉/企微/飞书在此接入（签名 + 静默时段过滤由 index 分发器统一）
export function createImProvider({ webhookUrl } = {}) {
  return {
    name: 'im',
    verifyConfig() {
      if (!webhookUrl) return { ok: false, error: 'im_webhook_not_configured' };
      return { ok: true };
    },
    async send({ signal, deliveryStore }) {
      const v = this.verifyConfig();
      if (!v.ok) {
        await deliveryStore.record({
          signal_id: signal.signal_id,
          tenant_id: signal.tenant_id,
          channel: 'im',
          provider: 'custom',
          status: 'failed',
          last_error: v.error,
        });
        return { ok: false, error: v.error };
      }
      // 真实推送在此接入（钉钉/企微/飞书签名）；当前占位：落 sent 流水标记意图
      await deliveryStore.record({
        signal_id: signal.signal_id,
        tenant_id: signal.tenant_id,
        channel: 'im',
        provider: 'custom',
        status: 'sent',
      });
      return { ok: true };
    },
  };
}
