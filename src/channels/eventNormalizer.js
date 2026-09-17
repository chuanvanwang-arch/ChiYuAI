// src/channels/eventNormalizer.js — 需求② §3.0 统一事件行契约：4 通道原始行 → 归一化事件行
// 设计：docs/2026-09-17-channel-adapter-unified-design.md §3.0
// 纯函数：无 DB、无 IO——单测零依赖。只落结构化字段（subject/snippet/participants/domain），
//        不落原始明文（红线：邮箱/微信内容只抽结构化字段，见 §8 决策点②默认 30 天可配）。
const KIND_DEFAULT = 'contact_change';
// 日历改期/取消 → 会议信号（§3.0 kind 取值）
const KIND_BY_STATUS = { cancelled: 'meeting_confirmed', rescheduled: 'meeting_confirmed' };

function domainOf(email) { return (email || '').split('@')[1] || null; }

export function normalizeChannelRow(row = {}) {
  const channel = row.channel || 'email';
  const actor = row.from ? { name: row.from_name || null, email: row.from } : (row.actor || {});
  const participants = [];
  // 收件人/抄送 → 参与者（§3.0 participant 抽取出参方）
  for (const k of ['to', 'cc']) {
    for (const e of (row[k] || '').split(',').map((s) => s.trim()).filter(Boolean)) {
      participants.push({ name: null, email: e, corp: domainOf(e) });
    }
  }
  if (row.participants) for (const p of row.participants) participants.push(p);
  // 对方域名：取第一个非我方参与者域名（§3.0 domain 回填）
  const mine = (actor && actor.email && domainOf(actor.email)) || null;
  const theirs = participants.map((p) => p.corp || domainOf(p.email)).find((d) => d && d !== mine);
  const domain = theirs || null;
  const kind = KIND_BY_STATUS[row.status] || (row.kind || KIND_DEFAULT);
  return {
    channel,
    kind,
    ts: row.received_at || row.dtstart || row.start_time || row.msg_time || row.ts || null,
    actor: { name: actor.name || null, email: actor.email || null },
    participants,
    content: {
      subject: row.subject || row.summary || row.title || null,
      snippet: (row.body || row.snippet || row.notes || '').slice(0, 500), // 仅结构化片段（§8②）
      url: row.url || row.link || null,
    },
    external_id: row.external_id,
    domain,
  };
}
