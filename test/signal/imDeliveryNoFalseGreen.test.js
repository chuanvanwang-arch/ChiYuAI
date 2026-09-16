// test/signal/imDeliveryNoFalseGreen.test.js — P0-5：占位渠道禁止写 sent（去假绿）
// 背景：im.js 占位分支不发起任何 HTTP 却写 status:'sent' → 污染专门用于防假绿的 crm.signal_delivery 账本。
// 契约：未接入真实推送时，流水必须为 skipped + last_error='im_not_implemented'，且 delivered_at 为空。
import { describe, it, expect } from 'vitest';
import { createImProvider } from '../../src/signal/delivery/im.js';

function memStore() {
  const rows = [];
  return { rows, store: { async record(p) { rows.push(p); return p; } } };
}

describe('im 渠道占位不写 sent（P0-5 去假绿）', () => {
  it('配了 webhook 但未接真实推送 → skipped + last_error，绝不 sent', async () => {
    const { rows, store } = memStore();
    const p = createImProvider({ webhookUrl: 'https://example.invalid/hook' });
    const r = await p.send({ signal: { signal_id: 's1', tenant_id: 't1' }, deliveryStore: store });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('skipped');
    expect(rows[0].last_error).toBe('im_not_implemented');
    expect(r.ok).toBe(false);
  });

  it('未配 webhook → failed + im_webhook_not_configured（既有 fail-closed 不回归）', async () => {
    const { rows, store } = memStore();
    const p = createImProvider({});
    const r = await p.send({ signal: { signal_id: 's2', tenant_id: 't1' }, deliveryStore: store });
    expect(r.ok).toBe(false);
    expect(rows[0].status).toBe('failed');
    expect(rows[0].last_error).toBe('im_webhook_not_configured');
  });
});
