// src/signal/delivery/webhook.js — HTTP POST 到配置 URL
// 设计输入：docs/2026-09-15-final-design-coexistence-and-proactive.md §8.4（投递四渠道）
// fail-closed：未配置 url → verifyConfig 拒绝；HTTP 非 2xx → 落 failed 流水
//
// URL 来源（2026-09-17 补齐，与 email.js 的 SMTP_USER/SMTP_PASS 同惯例）：
//   显式注入 url（装配方） > SIGNAL_WEBHOOK_URL（部署环境） > 未配置 → fail-closed。
//   ⚠ 此前**无 env 兜底**：生产装配 `createDeliveryRegistry({})` 不传 providers ⇒ 本渠道
//     **结构性恒 fail-closed**（永远 webhook_url_not_configured），「全渠道可配置」在设计上成立、
//     在部署上不可达。这与 email（有 env 兜底）不对称，属「设计有、接线无」的同类缺口。
//   ⚠ 未配置即拒绝，绝不静默降级为「已投递」——本渠道的 sent 行代表**真实 HTTP 2xx 往返**。
export function createWebhookProvider({ url, headers = {} } = {}) {
  // env 兜底在**构造期**解析一次：verifyConfig 与实际 send 用同一个 URL 常量，
  //   避免「校验通过但发送时无 URL」的形状漂移（替身与生产形状不一致是假绿的常见成因）。
  const target = url || process.env.SIGNAL_WEBHOOK_URL || null;
  return {
    name: 'webhook',
    verifyConfig() {
      if (!target) return { ok: false, error: 'webhook_url_not_configured' };
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
        const resp = await fetch(target, {
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
