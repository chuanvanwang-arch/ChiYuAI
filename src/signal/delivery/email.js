// src/signal/delivery/email.js — SMTP 渠道；未配置凭据 fail-closed
// 设计输入：docs/2026-09-15-final-design-coexistence-and-proactive.md §8.4（投递四渠道）
// SMTP 复用 src/http/activation.js 的既有惯例：SMTP_USER+SMTP_PASS 配置即真发；缺省 Brevo
// fail-closed 铁律：未配置 smtp 凭据 → verifyConfig 拒绝启用，绝不静默失败
export function createEmailProvider({ smtp, transport } = {}) {
  return {
    name: 'email',
    verifyConfig() {
      // smtp 显式配置（host+from）或环境变量 SMTP_USER/SMTP_PASS（既有惯例）均可启用
      if (!smtp?.host || !smtp?.from) {
        if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
          return { ok: false, error: 'smtp_not_configured' };
        }
      }
      return { ok: true };
    },
    async send({ signal, deliveryStore, from = smtp?.from || process.env.SMTP_FROM || process.env.SMTP_USER }) {
      const v = this.verifyConfig();
      if (!v.ok) {
        await deliveryStore.record({
          signal_id: signal.signal_id,
          tenant_id: signal.tenant_id,
          channel: 'email',
          provider: 'smtp',
          recipient: signal.payload?.to || null,
          status: 'failed',
          last_error: v.error,
        });
        return { ok: false, error: v.error };
      }
      try {
        const nodemailer = await import('nodemailer');
        const host = smtp?.host || process.env.SMTP_HOST || 'smtp-relay.brevo.com';
        const port = Number(smtp?.port || process.env.SMTP_PORT || 587);
        const t = transport || nodemailer.createTransport({
          host,
          port,
          secure: process.env.SMTP_SECURE === 'true' || port === 465,
          auth: smtp?.auth || (process.env.SMTP_USER && process.env.SMTP_PASS
            ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
            : undefined),
        });
        await t.sendMail({
          from,
          to: signal.payload?.to,
          subject: signal.payload?.subject || '信号',
          html: signal.payload?.body,
        });
        await deliveryStore.record({
          signal_id: signal.signal_id,
          tenant_id: signal.tenant_id,
          channel: 'email',
          provider: 'smtp',
          recipient: signal.payload?.to || null,
          status: 'sent',
        });
        return { ok: true };
      } catch (e) {
        await deliveryStore.record({
          signal_id: signal.signal_id,
          tenant_id: signal.tenant_id,
          channel: 'email',
          provider: 'smtp',
          recipient: signal.payload?.to || null,
          status: 'failed',
          last_error: String(e?.message || e),
        });
        return { ok: false, error: String(e?.message || e) };
      }
    },
  };
}
