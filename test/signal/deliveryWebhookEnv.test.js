// test/signal/deliveryWebhookEnv.test.js — 投递渠道 URL 来源与「已实现/未实现」单源（2026-09-17）
//
// 背景（取证结论）：
//   · `email` 有 env 兜底（SMTP_USER/SMTP_PASS）⇒ 配 env 即可真发。
//   · `webhook` **原无 env 兜底**，而生产装配 `createDeliveryRegistry({})` 不传 providers
//     ⇒ 该渠道**结构性恒 fail-closed**（`webhook_url_not_configured` 永远成立）。
//     「全渠道可配置」在设计上成立、在部署上不可达 —— 属「设计有、接线无」缺口。本次补 `SIGNAL_WEBHOOK_URL`。
//   · `im` 的 send **未实现**（恒落 skipped/im_not_implemented，2026-09-16 P0-5 去假绿刻意如此）
//     ⇒ 它「有 verifyConfig、无 send」。配置页若只显示凭据状态就会把「配好凭据 → 以为能送达」的假象带给运营。
//     故新增 CHANNEL_IMPL_STATUS 作为「渠道是否已实现」的单一事实源，并由本测试锁住 im=未实现。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createWebhookProvider } from '../../src/signal/delivery/webhook.js';
import { createImProvider } from '../../src/signal/delivery/im.js';
import { CHANNEL_IMPL_STATUS } from '../../src/signal/delivery/index.js';

const saved = {};
function clearEnv(keys) {
  for (const k of keys) {
    if (!(k in saved)) saved[k] = process.env[k];
    delete process.env[k];
  }
}
function restoreEnv() {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

describe('webhook provider：URL 三来源与 fail-closed', () => {
  beforeEach(() => clearEnv(['SIGNAL_WEBHOOK_URL']));
  afterEach(() => { restoreEnv(); vi.unstubAllGlobals(); });

  it('① 三来源全缺 → verifyConfig 拒绝（fail-closed，零请求）', () => {
    const p = createWebhookProvider({});
    expect(p.verifyConfig()).toEqual({ ok: false, error: 'webhook_url_not_configured' });
  });

  it('② env SIGNAL_WEBHOOK_URL 提供 URL → 通过（装配零注入时仍可用）', () => {
    process.env.SIGNAL_WEBHOOK_URL = 'https://env.example.com/hook';
    expect(createWebhookProvider({}).verifyConfig()).toEqual({ ok: true });
  });

  it('③ 显式注入 url 优先于 env', () => {
    process.env.SIGNAL_WEBHOOK_URL = 'https://env.example.com/hook';
    const p = createWebhookProvider({ url: 'https://explicit.example.com/hook' });
    expect(p.verifyConfig()).toEqual({ ok: true });
  });

  it('④ send 使用构造期解析的同一个 URL（防「校验过 URL、发送时 URL 为空」的形状漂移）', async () => {
    process.env.SIGNAL_WEBHOOK_URL = 'https://env.example.com/hook';
    const calls = [];
    vi.stubGlobal('fetch', async (u) => { calls.push(u); return { ok: true }; });
    const recs = [];
    const p = createWebhookProvider({});
    const r = await p.send({
      signal: { signal_id: 's1', tenant_id: 't1' },
      deliveryStore: { record: async (x) => recs.push(x) },
    });
    expect(r.ok).toBe(true);
    expect(calls).toEqual(['https://env.example.com/hook']);
    expect(recs[0]).toMatchObject({ channel: 'webhook', status: 'sent' });
  });

  it('⑤ HTTP 非 2xx → 落 failed 且 last_error 非空（不伪造 sent）', async () => {
    process.env.SIGNAL_WEBHOOK_URL = 'https://env.example.com/hook';
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 500 }));
    const recs = [];
    const p = createWebhookProvider({});
    const r = await p.send({
      signal: { signal_id: 's2', tenant_id: 't1' },
      deliveryStore: { record: async (x) => recs.push(x) },
    });
    expect(r.ok).toBe(false);
    expect(recs[0].status).toBe('failed');
    expect(recs[0].last_error).toMatch(/500/);
  });
});

describe('CHANNEL_IMPL_STATUS：渠道「是否已实现」的单一事实源', () => {
  it('四渠道齐备，且 inbox 恒可用（无凭据、无外发副作用）', () => {
    expect(Object.keys(CHANNEL_IMPL_STATUS).sort()).toEqual(['email', 'im', 'inbox', 'webhook']);
    expect(CHANNEL_IMPL_STATUS.inbox).toMatchObject({ implemented: true, needs_credentials: false });
  });

  it('⛔ im 必须标为未实现（有 verifyConfig、无 send）——防止页面谎称「配好凭据就能送达」', () => {
    expect(CHANNEL_IMPL_STATUS.im.implemented).toBe(false);
  });

  it('im.send 的实际行为是 skipped（与 implemented:false 一致，非仅标注）', async () => {
    const recs = [];
    const p = createImProvider({ webhookUrl: 'https://qyapi.weixin.qq.com/x' });
    const r = await p.send({
      signal: { signal_id: 's3', tenant_id: 't1' },
      deliveryStore: { record: async (x) => recs.push(x) },
    });
    expect(r.ok).toBe(false);
    expect(recs[0]).toMatchObject({ status: 'skipped', last_error: 'im_not_implemented' });
    // 反向对照：绝不写 sent（写假账会掩盖未送达事实）
    expect(recs.some((x) => x.status === 'sent')).toBe(false);
  });
});
