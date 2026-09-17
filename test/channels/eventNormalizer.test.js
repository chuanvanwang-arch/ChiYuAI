// test/channels/eventNormalizer.test.js
// T3：§3.0 统一事件行契约——4 通道原始行 → 归一化事件行
// 判据：participants 抽取（to/cc）、domain 取对方域名、kind 按状态映射、仅结构化片段（500 截断）
import { describe, it, expect } from 'vitest';
import { normalizeChannelRow } from '../../src/channels/eventNormalizer.js';

describe('eventNormalizer §3.0 统一事件行', () => {
  it('email 原始行 → 事件行（participants/domain 抽取）', () => {
    const row = {
      channel: 'email', external_id: 'msg-1', received_at: '2026-09-17T08:00:00Z',
      from: 'alice@sales.com', to: 'bob@acme.com', subject: '拜访安排', body: '下周约见贵司采购',
    };
    const ev = normalizeChannelRow(row);
    expect(ev.channel).toBe('email');
    expect(ev.external_id).toBe('msg-1');
    expect(ev.actor.email).toBe('alice@sales.com');
    expect(ev.participants.some((p) => p.email === 'bob@acme.com')).toBe(true);
    expect(ev.domain).toBe('acme.com'); // 对方域名（排除我方 sales.com）
    expect(ev.kind).toBe('contact_change'); // 默认交互类
    expect(ev.content.subject).toBe('拜访安排');
    expect(ev.ts).toBe('2026-09-17T08:00:00Z');
  });

  it('cc 也进 participants；同我方域名不选为 domain', () => {
    const ev = normalizeChannelRow({
      channel: 'email', external_id: 'm2', from: 'me@sales.com', to: 'a@acme.com', cc: 'b@other.com',
    });
    expect(ev.participants.map((p) => p.email)).toEqual(['a@acme.com', 'b@other.com']);
    expect(ev.domain).toBe('acme.com'); // 第一个非我方域名
  });

  it('calendar 改期/取消 → kind=meeting_confirmed', () => {
    const ev = normalizeChannelRow({ channel: 'calendar', external_id: 'evt-1', status: 'cancelled', dtstart: '2026-09-18T10:00:00Z' });
    expect(ev.kind).toBe('meeting_confirmed');
  });

  it('snippet 仅结构化片段且截断 500 字（不落原始全文）', () => {
    const body = 'x'.repeat(1000);
    const ev = normalizeChannelRow({ channel: 'email', external_id: 'm3', body });
    expect(ev.content.snippet.length).toBeLessThanOrEqual(500);
    expect(ev.content.snippet).not.toContain(body); // 未落全文（§8 决策② 仅结构化字段）
  });

  it('空行 fail-safe 返回结构化空事件（不抛）', () => {
    const ev = normalizeChannelRow({});
    expect(ev.channel).toBe('email'); // 默认通道（行无 channel 时向后兼容）
    expect(ev.external_id).toBeUndefined();
    expect(ev.domain).toBeNull();
  });
});
