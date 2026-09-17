// src/channels/kinds.js — 通道 kind 的**单一事实源**（需求②）
// 为什么单列：该集合此前散落多处（sync/factory.js 的通道键、presets/index.js 的 buildChannelFactories、
//   verifyScope.KIND_PROBE、channelIngestWiring.CHANNEL_KINDS、channelRouter 的 `startsWith('generic-')` 前缀判定）。
//   前缀判定尤其危险：`generic-rest/mcp/cli` 同属 `generic-` 前缀却不是通道 → 会被错当通道展示/接入（同名前缀两义）。
//   收敛到本文件后，任何一处漂移都能被「集合一致性」守卫捕获。
export const CHANNEL_KIND_LIST = Object.freeze([
  'generic-email', 'generic-calendar', 'generic-meeting', 'generic-wechat',
]);
export const CHANNEL_KINDS = new Set(CHANNEL_KIND_LIST);

// kind → 预设 verify.probe 名（与 presets/channel-*.js 的 verify.probe 一一对应）
export const KIND_PROBE = Object.freeze({
  'generic-email': 'imap_login',
  'generic-calendar': 'caldav_propfind',
  'generic-meeting': 'meeting_api_list',
  'generic-wechat': 'wecom_api',
});

export function isChannelKind(kind) {
  return typeof kind === 'string' && CHANNEL_KINDS.has(kind);
}
