// src/signal/ics.js — 信号 → 标准 iCalendar（VEVENT）纯函数
// 设计输入：docs/2026-09-16-signal-export-calendar-design.md §3.2（L2）
//
// 立论：原主张「系统自动……建立日历」在全仓 VEVENT / .ics / caldav / calendar API 均为 **0 命中**
//   （审计 §模块2），属纯零实现。本模块只负责**载体生成**：把带日期语义的信号渲染为标准 .ics 文本；
//   出网通道有两条（互不依赖）—— delivery/email.js 挂附件、http/routes.js 暴露下载端点。
//
// 铁律：
//   ① 零第三方依赖。不引 ical-generator：本需求只需 11 行固定骨架，引入一个会拖传递依赖、
//      且其默认行为（本地时区、自动 DTSTAMP）恰好违反下条 ③。
//   ② **缺日期不造日程**：无 payload.event_at（或非法）→ 返回 null。禁止用 now() 兜底，
//      否则用户日历里会出现从未安排过的「幽灵日程」——这是比"没做"更坏的失败模式。
//   ③ 时间一律转 **UTC**（`Z` 后缀）。按本地时区渲染会让同一信号在不同机器显示不同时刻，
//      且日历客户端导入时会二次换算（双重偏移）。
//   ④ 行折叠按 RFC 5545 §3.1：**75 字节**（不是 75 字符）为限，续行以单个空格开头。
//      中文按字符数折叠会正好劈在多字节边界上 → 产出非法 UTF-8 行、客户端解析失败。
//   ⑤ 文本转义按 §3.3.11（反斜杠 → 分号 → 逗号 → 换行，顺序不可颠倒）。

const MAX_LINE_BYTES = 75;

function escapeText(s) {
  return String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

function toUtcStamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`
    + `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

// 按**字节**折叠，且回退到 UTF-8 字符边界（见铁律 ④）
function foldLine(line) {
  const buf = Buffer.from(line, 'utf8');
  if (buf.length <= MAX_LINE_BYTES) return line;
  const parts = [];
  let start = 0;
  let limit = MAX_LINE_BYTES;
  while (start < buf.length) {
    let end = Math.min(start + limit, buf.length);
    while (end > start && end < buf.length && (buf[end] & 0xc0) === 0x80) end -= 1;
    if (end === start) end = Math.min(start + limit, buf.length); // 极端兜底：不致死循环
    parts.push(buf.subarray(start, end).toString('utf8'));
    start = end;
    limit = MAX_LINE_BYTES - 1; // 续行含 1 字节前导空格
  }
  return parts.join('\r\n ');
}

export function buildIcs(signal = {}, { durationMinutes = 30, now = new Date() } = {}) {
  const p = signal.payload || {};
  const raw = p.event_at || null;
  if (!raw) return null;                                   // 铁律 ②
  const start = new Date(raw);
  if (Number.isNaN(start.getTime())) return null;           // 非法日期同样不造（'2026-11-04 前后' 属此类）
  const end = new Date(start.getTime() + durationMinutes * 60000);
  const uid = `${signal.signal_id || 'signal'}@crm-ai-native`;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//ChiYu Enterprise AI Sales//Signal//CN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${toUtcStamp(now)}`,
    `DTSTART:${toUtcStamp(start)}`,
    `DTEND:${toUtcStamp(end)}`,
    `SUMMARY:${escapeText(p.subject || signal.kind || '信号')}`,
    `DESCRIPTION:${escapeText(p.body || '')}`,
    `CATEGORIES:${escapeText(signal.kind || '')}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(foldLine).join('\r\n') + '\r\n';
}
