// src/sync/presets/channel-email.js — 需求②通道预设：generic-email（IMAP/Exchange/企业邮）
// 设计：docs/2026-09-17-channel-adapter-unified-design.md §3.1 + §4.5（verifyScope 真探测 fail-closed）
// 纯数据模板：差异全由 descriptor 表达；构造走 createGenericRestSyncProvider（factory.js）+ channelProvider。
// 边界（红线）：密码/授权码直进 credentialVault（明文不落会话/审计）；verifyScope 真探测不 mock 代真；
//              默认信任档 L1 只读；未接通不得宣称已接通。
export const CHANNEL_EMAIL_PRESET = {
  id: 'channel-email',
  kind: 'generic-email',
  label: '邮箱（IMAP/Exchange/企业邮）',
  objects: [
    {
      name: 'email',
      label: '邮件',
      since_field: 'received_at',      // 增量游标字段（设计 §3.1 fetchIncremental by since）
      request: { method: 'GET' },      // 真实 endpoint/鉴权由租户 descriptor 覆盖（P4 实测时填）
      response: { rowsPath: 'data', sincePath: 'data.received_at' },
    },
  ],
  auth: { type: 'static' },            // 覆盖为 token-flow（ms365）或 IMAP 凭据
  verify: { probe: 'imap_login' },     // verifyScope 契约（§4.5.1 ②）：真实探测 IMAP LOGIN，fail-closed
};
