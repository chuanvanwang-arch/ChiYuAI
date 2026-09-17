// src/signal/delivery/index.js — provider 注册表 + 分发器
// 设计输入：docs/2026-09-15-final-design-coexistence-and-proactive.md §8.4（投递四渠道）
// 分发器统一处理：静默时段（quiet_hours）→ skipped 留痕；频次上限（每 signal 默认 1 次）；
// verifyConfig fail-closed → failed 留痕；真正投递由各 provider send 完成并落流水
import { createInboxProvider } from './inbox.js';
import { createEmailProvider } from './email.js';
import { createImProvider } from './im.js';
import { createWebhookProvider } from './webhook.js';

// 渠道实现状态 = 单一事实源（2026-09-17 前台可见性审计补）
//   为什么需要它：配置页要如实告诉运营「这个渠道打开后会发生什么」。
//   若只显示 verifyConfig（凭据是否齐），运营会以为「配好凭据就能送达」——而 im 渠道
//   **已实现 verifyConfig、未实现 send**（send 恒落 skipped/im_not_implemented，2026-09-16 P0-5 去假绿刻意如此）。
//   两件事必须分开呈现：① 凭据是否齐（运行时探测）② 渠道是否已实现（本表，代码事实）。
//   ⚠ 本表是「渠道是否已实现」的唯一解释权所在；页面/文档不得各自再写一份（判据⑥单源）。
export const CHANNEL_IMPL_STATUS = {
  inbox: {
    implemented: true, needs_credentials: false, env: [],
    note: '平台内视角消费 crm.signal，无外部收件人、无外发副作用，恒可用',
  },
  email: {
    implemented: true, needs_credentials: true, env: ['SMTP_USER', 'SMTP_PASS'],
    note: 'SMTP 真实外发（缺省 Brevo/163）；未配置凭据 fail-closed，绝不静默失败。'
      + '⚠ verifyConfig 只校验凭据**是否已配置**（非空），**不校验有效性** —— 实证（2026-09-17）：'
      + 'SMTP_PASS 为占位符 `__REPLACE_WI…` 时 verifyConfig 仍返 ok，而真实投递 4/4 落 '
      + 'failed("Invalid login: 550 User has no permission")。故「能否送达」必须以投递台账为准'
      + '（GET /api/signals/delivery-status 的 last/verdict 字段），不得由凭据存在性推断。',
  },
  webhook: {
    implemented: true, needs_credentials: true, env: ['SIGNAL_WEBHOOK_URL'],
    note: 'HTTP POST 到自定义 URL；sent 行代表真实 2xx 往返（本渠道是唯一能自证「送达」的渠道）。',
  },
  im: {
    implemented: false, needs_credentials: true, env: ['IM_WEBHOOK_URL（未接线，占位）'],
    note: '钉钉/企微/飞书签名推送**未实现**。两条路径都不写假 sent，但落账状态不同，必须分清：'
      + '① 生产装配 `createDeliveryRegistry({})` 不注入 webhookUrl → `verifyConfig` 先失败 → '
      + '台账落 **failed / im_webhook_not_configured**（实证 2026-09-17，3/3）；'
      + '② 若调用方显式注入 webhookUrl → 才走到 send() 的 **skipped / im_not_implemented**。'
      + '⚠ 原先本注只写了 ②，与生产实况不符（会把「未实现」误呈现为已实现渠道的凭据问题）。'
      + '「IM 通道」当前的正确接法是 **webhook 渠道 + 自建桥接器**（IM_WEBHOOK_URL 未接线）。',
  },
};

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

  async function deliver({ signal, channel, store, recipient = null }) {
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
    // recipient 由调用方（dispatcher）从 route 决策传入，provider 不得自行猜测收件人
    return channels[channel].send({ signal, deliveryStore: store, recipient });
  }

  return { channels, get, deliver, verify: (c) => channels[c]?.verifyConfig() ?? { ok: false, error: 'unknown_channel' } };
}
