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

// kind → 通道**短名**（§3.0 契约：事件行 `channel` 字段取真实通道语义 email/calendar/meeting/wechat，
//   不取 provider kind `generic-*`）。此前该表私有于 channelProvider.js（本地 CHANNEL_SHORT），
//   现上收本文件，与 KIND_PROBE/CHANNEL_KINDS 同源，避免「通道映射两处解释权」。
export const CHANNEL_SHORT = Object.freeze({
  'generic-email': 'email',
  'generic-calendar': 'calendar',
  'generic-meeting': 'meeting',
  'generic-wechat': 'wechat',
});

// 通道短名 → `CRM_ACCOUNT.payload.enrichment` **落点键**（设计 §3.1–§3.4 逐通道分键）。
// ⚠ 分键是**已批准设计口径**（§3.1 email_intent / §3.2 schedule / §3.3 meeting_intents / §3.4 wechat_intents）：
//   若合并为单一 email_intent[]，则日历改期/会议纪要/企微会话全都落进「邮件意图」＝语义错配，
//   且各通道消费面无法各自读取（同一键两处解释权）。通道语义由**所在键**承载，条目不重复存 channel。
export const ENRICHMENT_KEY = Object.freeze({
  email: 'email_intent',
  calendar: 'schedule',
  meeting: 'meeting_intents',
  wechat: 'wechat_intents',
});

// 兜底键：通道不可判定时按邮件语义落（与归一化默认 channel='email' 一致）
export const DEFAULT_ENRICHMENT_KEY = 'email_intent';

// 通道短名（或 kind）→ 短名；不可判定返回 null
export function channelShortName(channelOrKind) {
  if (typeof channelOrKind !== 'string') return null;
  if (CHANNEL_SHORT[channelOrKind]) return CHANNEL_SHORT[channelOrKind]; // 传 kind
  return Object.prototype.hasOwnProperty.call(ENRICHMENT_KEY, channelOrKind) ? channelOrKind : null; // 已是短名
}

// 通道短名（或 kind）→ enrichment 落点键；不可判定 → DEFAULT_ENRICHMENT_KEY
export function enrichmentKeyOf(channelOrKind) {
  const short = channelShortName(channelOrKind);
  return (short && ENRICHMENT_KEY[short]) || DEFAULT_ENRICHMENT_KEY;
}

export function isChannelKind(kind) {
  return typeof kind === 'string' && CHANNEL_KINDS.has(kind);
}
