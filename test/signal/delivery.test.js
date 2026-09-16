import { describe, it, expect } from 'vitest';
import { createDeliveryStore } from '../../src/signal/delivery/signalDeliveryStore.js';
import { createDeliveryRegistry } from '../../src/signal/delivery/index.js';

// 注入式替身 store（不依赖共享库并发；对齐计划 §Task 3 契约测试）
function makeMemStore() {
  const rows = [];
  return {
    rows,
    store: {
      async record(params) {
        const row = { ...params };
        rows.push(row);
        return row;
      },
      async listBySignal() { return rows; },
      async failures() { return rows.filter(r => r.status === 'failed' || r.status === 'skipped'); },
    },
  };
}

describe('signal delivery 契约', () => {
  it('未配置凭据的 email 渠道 verifyConfig 拒绝启用（fail-closed）', () => {
    const registry = createDeliveryRegistry({});
    const email = registry.get('email');
    const res = email.verifyConfig({});
    expect(res.ok).toBe(false);
    expect(res.error).toBe('smtp_not_configured');
  });

  it('send 调用后 signal_delivery 落 sent 或 failed 行（防假绿）', async () => {
    const { store, rows } = makeMemStore();
    // 注入 fake transport（不真发 SMTP；计划 §Task 3 契约：createEmailProvider 支持 transport 注入）
    const fakeTransport = { sendMail: async () => ({ messageId: 'm1' }) };
    const registry = createDeliveryRegistry({ smtp: { host: 'smtp.test', from: 'a@b.c' }, transport: fakeTransport });
    const res = await registry.deliver({
      signal: { signal_id: 's1', tenant_id: 't1', payload: { subject: 'x', to: 'u@b.c' } },
      channel: 'email',
      store,
    });
    expect(res.ok).toBe(true);
    expect(rows.some(r => r.status === 'sent' || r.status === 'failed')).toBe(true);
    expect(rows.every(r => r.signal_id === 's1')).toBe(true);
  });

  it('静默时段投递落 skipped 且留痕（不静默）', async () => {
    const { store, rows } = makeMemStore();
    const registry = createDeliveryRegistry(
      { smtp: { host: 'smtp.test', from: 'a@b.c' } },
      { quietHours: { start: 22, end: 6 }, now: () => new Date('2026-09-16T23:00:00') },
    );
    const res = await registry.deliver({
      signal: { signal_id: 's2', tenant_id: 't1', payload: {} },
      channel: 'email',
      store,
    });
    expect(res.skipped).toBe(true);
    expect(rows.some(r => r.status === 'skipped')).toBe(true);
  });

  it('webhook 无 URL 时 verifyConfig 拒绝（fail-closed）', () => {
    const registry = createDeliveryRegistry({});
    const res = registry.verify('webhook');
    expect(res.ok).toBe(false);
    expect(res.error).toBe('webhook_url_not_configured');
  });

  it('未知渠道 deliver 拒绝（unknown_channel）', async () => {
    const { store } = makeMemStore();
    const registry = createDeliveryRegistry({});
    const res = await registry.deliver({ signal: { signal_id: 's3', tenant_id: 't1' }, channel: 'fax', store });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('unknown_channel');
  });
});
