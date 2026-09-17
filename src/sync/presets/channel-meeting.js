// src/sync/presets/channel-meeting.js — 需求②通道预设：generic-meeting（Zoom/Teams/腾讯会议）
// 设计：docs/2026-09-17-channel-adapter-unified-design.md §3.3
// 纯数据模板：差异全由 descriptor 表达；构造走 createGenericRestSyncProvider（token-flow 通用模型已支持）+ channelProvider。
// 落点（§3.3）：参会人/时长/纪要摘要 → meeting 事件；纪要点名客户/竞品 → 意图/异议信号 → meeting_intents 汇入。
export const CHANNEL_MEETING_PRESET = {
  id: 'channel-meeting',
  kind: 'generic-meeting',
  label: '会议（Zoom/Teams/腾讯会议）',
  objects: [
    {
      name: 'meeting',
      label: '会议记录',
      since_field: 'start_time',
      request: { method: 'GET' },
      response: { rowsPath: 'data', sincePath: 'data.start_time' },
    },
  ],
  auth: { type: 'token-flow' },           // 会议平台走 token-flow（既有通用模型）；租户 descriptor 覆盖 steps
  verify: { probe: 'meeting_api_list' },  // verifyScope 契约：拉会话列表真探测，fail-closed
};
