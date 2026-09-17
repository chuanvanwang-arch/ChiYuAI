// src/sync/presets/channel-wechat.js — 需求②通道预设：generic-wechat（企微会话/群聊）—— 只给契约与边界
// 设计：docs/2026-09-17-channel-adapter-unified-design.md §3.4
// 纯数据模板：差异全由 descriptor 表达；构造走 createGenericRestSyncProvider + channelProvider。
// 🔴 边界（红线，§3.4 原文）：
//   1) 个人微信无开放 API（历史假绿已识破）——本预设只接「企业微信（企微）」会话读取；
//   2) 企微会话读取需企业授权 + 合规审批（接入=四类动作 first-connect 过 review-gate）；
//   3) 未接通不得宣称已接通（对齐需求④ Q2-5 红线）。
export const CHANNEL_WECHAT_PRESET = {
  id: 'channel-wechat',
  kind: 'generic-wechat',
  label: '企业微信会话（仅企微授权租户）',
  boundary: {
    personal_wechat_no_open_api: true,   // 个人微信无开放 API —— 不做假接通
    requires_corp_auth: true,            // 需企业授权 + 合规审批（first-connect 人工闸）
    claim_policy: 'unconnected_until_proven', // 未接通不得宣称已接通
  },
  objects: [
    {
      name: 'wechat_msg',
      label: '企微会话消息摘要',
      since_field: 'msg_time',
      request: { method: 'GET' },
      response: { rowsPath: 'data', sincePath: 'data.msg_time' },
    },
  ],
  auth: { type: 'token-flow' },          // 企微 API（corpId/agentId/secret）走 token-flow 通用模型
  verify: { probe: 'wecom_api' },        // verifyScope 契约：企微 API 真探测，fail-closed
};
