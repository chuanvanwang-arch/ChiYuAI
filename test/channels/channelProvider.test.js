// test/channels/channelProvider.test.js
// T4：channelProvider 工厂——fetchIncremental（复用 generic-rest 模板引擎）→ 事件行归一化
// 判据：契约三方法（mount 可装配）；fetchIncremental 输出归一化事件行；凭据缺失 fail-closed；
//       实例 kind 保留通道名（cursor 分表防串）
import { describe, it, expect } from 'vitest';
import { createChannelProvider, buildChannelFactories } from '../../src/channels/channelProvider.js';

describe('channelProvider（T4）', () => {
  it('fetchIncremental：原始行 → 归一化事件行（domain/participants 抽取）', async () => {
    const provider = createChannelProvider({
      kind: 'generic-email',
      objects: [{ name: 'email', since_field: 'received_at' }],
    })({
      endpoint: 'https://mock',
      token: 'mock-token', // 静态凭据（否则 ensureAuth 恒 credentials_missing）
      auth: { type: 'static' },
      __fetch: async () => ({ ok: true, json: async () => ({ data: [
        { channel: 'email', external_id: 'm1', from: 'a@sales.com', to: 'b@acme.com', subject: '拜访', received_at: '2026-09-17T08:00:00Z' },
      ] }) }),
    });
    const r = await provider.readIncremental({ object: 'email', cursor: null });
    expect(r.ok).toBe(true);
    expect(r.rows[0]).toMatchObject({ channel: 'email', external_id: 'm1', domain: 'acme.com' });
    expect(r.rows[0].participants.some((p) => p.email === 'b@acme.com')).toBe(true);
  });

  it('凭据缺失 fail-closed：verifyAuth → credentials_missing/endpoint_missing', async () => {
    const provider = createChannelProvider({ kind: 'generic-email', objects: [{ name: 'email' }] })({});
    const v = await provider.verifyAuth();
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/credentials_missing|endpoint_missing/);
  });

  it('契约三方法齐备（mount 可装配）', () => {
    const p = createChannelProvider({ kind: 'generic-wechat', objects: [{ name: 'wechat_msg' }] })({});
    for (const m of ['verifyAuth', 'discoverObjects', 'readIncremental']) expect(typeof p[m]).toBe('function');
  });

  it('实例 kind 保留通道名（cursor 分表防串）', () => {
    const p = createChannelProvider({ kind: 'generic-calendar', objects: [{ name: 'calendar' }] })({});
    expect(p.kind).toBe('generic-calendar');
  });

  it('buildChannelFactories：presets 列表 → {kind: factory}（presets/index.js 消费）', () => {
    const factories = buildChannelFactories([
      { kind: 'generic-email', objects: [{ name: 'email' }] },
      { kind: 'generic-wechat', objects: [{ name: 'wechat_msg' }] },
    ]);
    expect(typeof factories['generic-email']).toBe('function');
    expect(typeof factories['generic-wechat']).toBe('function');
    const inst = factories['generic-email']({});
    expect(inst.kind).toBe('generic-email');
  });
});
