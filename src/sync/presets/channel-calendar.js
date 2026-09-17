// src/sync/presets/channel-calendar.js — 需求②通道预设：generic-calendar（iCal/CalDAV/Exchange 日历）
// 设计：docs/2026-09-17-channel-adapter-unified-design.md §3.2
// 纯数据模板：差异全由 descriptor 表达；构造走 createGenericRestSyncProvider + channelProvider。
// 联动（设计 §3.2 落点）：日程信号 → 日期驱动（tender_deadline/visit 信号）复用既有 signal 规则。
export const CHANNEL_CALENDAR_PRESET = {
  id: 'channel-calendar',
  kind: 'generic-calendar',
  label: '日历（iCal/CalDAV/Exchange）',
  objects: [
    {
      name: 'calendar',
      label: '日历日程',
      since_field: 'dtstart',           // 日程开始时间作增量游标
      request: { method: 'GET' },
      response: { rowsPath: 'data', sincePath: 'data.dtstart' },
    },
  ],
  auth: { type: 'static' },             // 覆盖为 caldav 凭据 / ms365
  verify: { probe: 'caldav_propfind' }, // verifyScope 契约：CalDAV PropFind 真探测，fail-closed
};
