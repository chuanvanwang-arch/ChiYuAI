// src/signal/delivery/webhook.js — HTTP POST 到配置 URL
// 设计输入：docs/2026-09-15-final-design-coexistence-and-proactive.md §8.4（投递四渠道）
// fail-closed：未配置 url → verifyConfig 拒绝；HTTP 非 2xx → 落 failed 流水
export function createWebhookProvider({ url, headers = {} } = {}) {
  return {
    name: 'webhook',
    verifyConfig() {
      if (!url) return { ok: false, error: 'webhook_url_not_configured' };
      return { ok: true };
    },
    async send({ signal, deliveryStore }) {
      const v = this.verifyConfig();
      if (!v.ok) {
        await deliveryStore.record({
          signal_id: signal.signal_id,
          tenant_id: signal.tenant_id,
          channel: 'webhook',
          status: 'failed',
          last_error: v.error,
        });
        return { ok: false, error: v.error };
      }
      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify(signal),
        });
        if (!resp.ok) throw new Error(`webhook http ${resp.status}`);
        await deliveryStore.record({
          signal_id: signal.signal_id,
          tenant_id: signal.tenant_id,
          channel: 'webhook',
          status: 'sent',
        });
        return { ok: true };
      } catch (e) {
        await deliveryStore.record({
          signal_id: signal.signal_id,
          tenant_id: signal.tenant_id,
          channel: 'webhook',
          status: 'failed',
          last_error: String(e?.message || e),
        });
        return { ok: false, error: String(e?.message || e) };
      }
    },
  };
}
