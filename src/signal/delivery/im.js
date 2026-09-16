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
      // ⚠ 去假绿（2026-09-16 P0-5）：占位分支**禁止**写 status:'sent'
      //   本渠道此刻不发起任何 HTTP（未接入钉钉/企微/飞书签名推送）。写 sent 会让
      //   crm.signal_delivery（专门用于防「投递即已完成」假绿）沉淀假账，一旦接线将掩盖未送达事实。
      //   契约：未实现 → skipped + last_error='im_not_implemented'（可被 failures() 检出 + 可重投）。
      //   真实推送接入时替换本段：签名请求 → 成功写 sent / 失败写 failed。
      await deliveryStore.record({
        signal_id: signal.signal_id,
        tenant_id: signal.tenant_id,
        channel: 'im',
        provider: 'custom',
        status: 'skipped',
        last_error: 'im_not_implemented',
      });
      return { ok: false, error: 'im_not_implemented' };
    },
  };
}
