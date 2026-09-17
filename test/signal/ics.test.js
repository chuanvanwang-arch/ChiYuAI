// test/signal/ics.test.js — 信号 → iCalendar 载体（L2，设计 §3.2）
// 为什么需要：原主张「建立日历」在全仓 VEVENT/.ics/text/calendar 均为 0 命中（纯零实现）。
//   本文件锁四条可证伪语义：缺日期不造日程 / UTC 归一 / 字节级折叠 / RFC 转义。
import { describe, it, expect } from 'vitest';
import { buildIcs } from '../../src/signal/ics.js';

const base = {
  signal_id: 'sig-1',
  kind: 'tender_deadline',
  severity: 'high',
  payload: { event_at: '2026-11-04T09:30:00+08:00', subject: '投标截止', body: '宏远项目开标' },
};

describe('buildIcs（纯函数）', () => {
  it('含标准骨架 + UID 取 signal_id', () => {
    const ics = buildIcs(base);
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('BEGIN:VEVENT');
    expect(ics).toContain('END:VEVENT');
    expect(ics).toContain('END:VCALENDAR');
    expect(ics).toContain('UID:sig-1@crm-ai-native');
    expect(ics).toContain('SUMMARY:投标截止');
  });

  it('DTSTART 转 UTC（+08:00 的 09:30 → 01:30Z）', () => {
    const ics = buildIcs(base, { now: new Date('2026-09-16T00:00:00Z') });
    expect(ics).toContain('DTSTART:20261104T013000Z');
    // DTEND 缺省 +30min
    expect(ics).toContain('DTEND:20261104T020000Z');
  });

  it('缺 payload.event_at → 返回 null（不造假日程）', () => {
    expect(buildIcs({ signal_id: 's', payload: {} })).toBeNull();
    expect(buildIcs({ signal_id: 's' })).toBeNull();
    expect(buildIcs({})).toBeNull();
  });

  it('event_at 非法 → 返回 null（不落到 Invalid Date 的 1970）', () => {
    expect(buildIcs({ signal_id: 's', payload: { event_at: '2026-11-04 前后' } })).toBeNull();
  });

  it('RFC 5545 转义：逗号/分号/反斜杠/换行', () => {
    const ics = buildIcs({ ...base, payload: { ...base.payload, subject: 'A, B; C\\D', body: 'L1\nL2' } });
    expect(ics).toContain('SUMMARY:A\\, B\\; C\\\\D');
    expect(ics).toContain('DESCRIPTION:L1\\nL2');
  });

  it('长中文按 75 字节折叠，且折叠后拼接可还原', () => {
    const subject = '投'.repeat(60); // 180 字节 → 必折叠
    const ics = buildIcs({ ...base, payload: { ...base.payload, subject } });
    for (const line of ics.split('\r\n')) {
      expect(Buffer.from(line, 'utf8').length).toBeLessThanOrEqual(75);
    }
    const idx = ics.split('\r\n').findIndex((l) => l.startsWith('SUMMARY:'));
    let joined = ics.split('\r\n')[idx];
    let k = idx + 1;
    while (ics.split('\r\n')[k]?.startsWith(' ')) { joined += ics.split('\r\n')[k].slice(1); k += 1; }
    expect(joined).toBe(`SUMMARY:${subject}`);
  });

  it('CRLF 行尾（RFC 5545 要求）', () => {
    const ics = buildIcs(base);
    expect(ics.endsWith('\r\n')).toBe(true);
    expect(ics.split('\n').every((l) => l === '' || l.endsWith('\r'))).toBe(true);
  });
});
