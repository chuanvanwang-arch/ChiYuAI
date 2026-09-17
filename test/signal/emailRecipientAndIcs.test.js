// test/signal/emailRecipientAndIcs.test.js — 收件人贯通 + .ics 附件（L2）
// 为什么需要：
//   ① 实测断链：route.resolve 算出的 recipient 在 dispatcher 被丢弃，而 email.js 读的
//      signal.payload.to **无任何生产者** → 即使 SMTP 配好也恒失败（真发不出去）。
//   ② 「建立日历」需要 .ics 作为邮件附件载体，否则日历只存在于平台内、到不了用户日历。
// 断言双向：有 event_at → 必须带 text/calendar 附件；无 event_at → 必须**不带**（不造假日程）。
import { describe, it, expect } from 'vitest';
import { createDeliveryRegistry } from '../../src/signal/delivery/index.js';

function memStore() {
  const rows = [];
  return { rows, record: async (p) => { rows.push(p); return p; } };
}

function fakeTransport(captured) {
  return { sendMail: async (msg) => { captured.push(msg); return { messageId: 'm1' }; } };
}

// ⚠ 环境确定化：**不得**依赖 process.env.SMTP_*（本机 .env 有真实 163 凭据，但干净克隆无 .env →
//   email.verifyConfig 会 fail-closed 返 smtp_not_configured → 本文件全部用例假红）。
//   凡断言投递行为的测试，必须显式注入 smtp 配置（本仓「测试须隔离环境输入」纪律）。
const SMTP = { smtp: { host: 'smtp.test.invalid', from: 'noreply@test.invalid' } };
const makeRegistry = (captured) => createDeliveryRegistry({ ...SMTP, transport: fakeTransport(captured) });

const sig = (extra = {}) => ({
  signal_id: 'sig-1', tenant_id: 't1', kind: 'tender_deadline', severity: 'high',
  target_role: 'sales', payload: { subject: '投标截止', body: '开标' }, ...extra,
});

describe('recipient 贯通（route → dispatcher → provider）', () => {
  it('deliver() 把 recipient 透传给 provider，落流水也用它', async () => {
    const captured = [];
    const store = memStore();
    const registry = makeRegistry(captured);
    const r = await registry.deliver({ signal: sig(), channel: 'email', store, recipient: 'alice@corp.com' });
    expect(r.ok).toBe(true);
    expect(captured[0].to).toBe('alice@corp.com');
    expect(store.rows[0].recipient).toBe('alice@corp.com');
  });

  it('未传 recipient 时回退 payload.to（零回归旧调用方）', async () => {
    const captured = [];
    const registry = makeRegistry(captured);
    await registry.deliver({ signal: sig({ payload: { to: 'legacy@corp.com' } }), channel: 'email', store: memStore() });
    expect(captured[0].to).toBe('legacy@corp.com');
  });
});

describe('email 挂 .ics 附件', () => {
  it('payload.event_at 存在 → 附件含 text/calendar', async () => {
    const captured = [];
    const registry = makeRegistry(captured);
    await registry.deliver({
      signal: sig({ payload: { subject: '投标截止', event_at: '2026-11-04T09:30:00+08:00' } }),
      channel: 'email', store: memStore(), recipient: 'a@b.com',
    });
    expect(captured[0].attachments).toHaveLength(1);
    expect(captured[0].attachments[0].contentType).toContain('text/calendar');
    expect(captured[0].attachments[0].content).toContain('BEGIN:VCALENDAR');
    expect(captured[0].attachments[0].filename).toBe('sig-1.ics');
  });

  it('无 payload.event_at → 不带 attachments（不造假日程）', async () => {
    const captured = [];
    const registry = makeRegistry(captured);
    await registry.deliver({ signal: sig(), channel: 'email', store: memStore(), recipient: 'a@b.com' });
    expect(captured[0].attachments).toBeUndefined();
  });
});
