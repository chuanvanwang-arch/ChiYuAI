// src/particles/interactionIndex.js — ATTIO C 桶：交互渠道维度 + first/last/next 计算指针
// 设计输入：11 增量设计 §3.4（渠道枚举 email/calendar/call/meeting/general；写时维护）
import { query, queryWrite } from '../db.js';
import { recordEvent } from '../events/recordEvent.js';

export const INTERACTION_CHANNELS = ['email', 'calendar', 'call', 'meeting', 'general'];

export function emptyInteractionIndex() {
  const idx = {};
  for (const ch of INTERACTION_CHANNELS) idx[ch] = { first_at: null, last_at: null, next_at: null };
  return idx;
}

export function applyInteraction(index, { channel, at, kind }) {
  if (!INTERACTION_CHANNELS.includes(channel)) throw new Error(`未知交互渠道: ${channel}`);
  if (!['first', 'last', 'next'].includes(kind)) throw new Error(`未知指针类型: ${kind}`);
  const idx = JSON.parse(JSON.stringify(index || emptyInteractionIndex()));
  const cur = idx[channel];
  const t = at; // 保留输入原值（UTC ISO 字符串），不重格式化避免精度损失
  if (kind === 'first') {
    if (!cur.first_at || t < cur.first_at) cur.first_at = t;
  } else if (kind === 'last') {
    if (!cur.last_at || t > cur.last_at) cur.last_at = t;
  } else {
    if (!cur.next_at || t < cur.next_at) cur.next_at = t;
  }
  return idx;
}

export async function recordInteraction({ relatedType, relatedId, channel, at, kind = 'last' }) {
  if (!INTERACTION_CHANNELS.includes(channel)) throw new Error(`未知交互渠道: ${channel}`);
  if (!['first', 'last', 'next'].includes(kind)) throw new Error(`未知指针类型: ${kind}`);
  const r = await query(`SELECT * FROM particles WHERE id=$1`, [relatedId]);
  const p = r.rows[0];
  if (!p) throw new Error(`粒子不存在: ${relatedId}`);
  const idx = applyInteraction(p.payload?.interaction_index, { channel, at, kind });
  const np = await queryWrite(
    `UPDATE particles SET payload = payload || $1::jsonb, updated_at=now() WHERE id=$2 RETURNING *`,
    [JSON.stringify({ interaction_index: idx }), relatedId]
  );
  const row = np.rows[0];
  // 事件平面 L2 双写 —— A1 收敛到统一落库通道
  //    原先「落库」与「emit」是两个独立动作，且落库 .catch(()=>{}) 静默吞错：
  //    库写失败、订阅者仍收到 → 幽灵事件（AGE 镜像/记忆捕获与真相源分叉）。
  //    recordEvent 内部保证「先落库成功、后广播」，且失败 emit trace 留痕。
  await recordEvent({
    domain: 'particle',
    type: 'interaction-recorded',
    entityId: relatedId,
    entityType: relatedType,
    actor: 'system',
    payload: { channel, kind, at, edge_source: 'interaction-index' },
  });
  return row;
}