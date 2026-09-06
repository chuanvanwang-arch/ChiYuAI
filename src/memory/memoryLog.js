// src/memory/memoryLog.js — memory_log 扩展读写 + 蒸馏 + 检索
import { query, queryWrite } from '../db.js';
import { judgeWorthiness } from './judge.js';

// 纯函数：选出应标 distilled / archived 的行（测试用，无 DB）
export function classifyForDistill(rows, { ttlDays = 30, now = new Date() } = {}) {
  const ttlMs = ttlDays * 86400000;
  const nowMs = now.getTime();
  return rows.map((r) => {
    const age = nowMs - new Date(r.created_at).getTime();
    return { ...r, _markDistilled: !r.distilled && age >= ttlMs, _markArchived: age >= ttlMs * 2 };
  });
}

// 纯函数：通道解析（测试用）
export function resolveChannel({ channel = 'auto', layer } = {}) {
  if (channel && channel !== 'auto') return channel;
  if (layer === 'L-User') return 'note';
  return 'log';
}

// A2（2026-09-02）：entityId = 客户锚点。锚点不再编码进 topic 字符串——
//   原两处约定互相矛盾（rrfSearch 用 'entity:<id>'、timelineSource 用 'account:<id>'）
//   且都与生产数据（topic 全为 'event:*' / 'decision:*'）不匹配，导致按客户聚合恒空。
//   改由独立列 entity_id 承载，topic 回归业务分类语义。存量调用方不传 entityId 则恒为 NULL，零破坏。
export async function appendMemory({ topic, kind = 'event', payload, layer = 'L-Workspace', actor, eventType, ttlDays = 30, explicit = false, valueHorizonDays = 30, entityId = null }) {
  const verdict = judgeWorthiness(payload, { explicit, valueHorizonDays });
  if (!verdict.ok) return { ok: false, gate: 'worthiness', code: verdict.code, reason: verdict.reason };
  const r = await queryWrite(
    `INSERT INTO crm.memory_log (topic, kind, payload, layer, actor, event_type, ttl_days, entity_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [topic, kind, payload, layer, actor, eventType, ttlDays, entityId]
  );
  return { ok: true, row: r.rows[0] };
}

export async function retrieveMemory({ layer, topic, topicLike, channel = 'auto', limit = 50, tenantId = 'system' } = {}) {
  const ch = resolveChannel({ channel, layer, topic });
  if (ch === 'note') {
    const r = await query(`SELECT * FROM crm.memory_note WHERE layer=$1 AND topic=$2 AND archived=false AND tenant_id=$3`, [layer, topic, tenantId]);
    return { channel: 'note', rows: r.rows };
  }
  if (topicLike) {
    const r = await query(`SELECT * FROM crm.memory_log WHERE topic LIKE $1 AND archived=false AND tenant_id=$3 ORDER BY created_at DESC LIMIT $2`, [topicLike, limit, tenantId]);
    return { channel: 'log', rows: r.rows };
  }
  const r = await query(`SELECT * FROM crm.memory_log WHERE topic=$1 AND archived=false AND tenant_id=$2 ORDER BY created_at DESC LIMIT $3`, [topic, tenantId, limit]);
  return { channel: 'log', rows: r.rows };
}

// ───────────────────── G6 RRF 融合召回（dense+sparse）─────────────────────
// 测试计划 §5.5：dense = hashVector(payload 文本) 余弦；sparse = LIKE 命中加权；
// RRF 公式 score = Σ 1/(rank+60)，两路排名融合后按总分降序返回 topk。
// 设计输入：dev-plan §2（G6 依赖 ontology/embedding.js:hashVector）。
import { hashVector } from '../ontology/embedding.js';

// 余弦相似度（两向量同维，规范化输入）
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const den = Math.sqrt(na) * Math.sqrt(nb) || 1;
  return dot / den;
}

// payload 文本指纹：topic + kind + payload 序列化（含实体锚定，避免跨实体串扰）
function rowText(row) {
  return `${row.topic} ${row.kind} ${JSON.stringify(row.payload || {})}`;
}

export async function rrfSearch(queryText, { entityId = null, k = 5, denseWeight = 0.5, tenantId = 'system' } = {}) {
  const q = String(queryText || '').trim();
  // A2（2026-09-02）：锚点改走 entity_id 列（原 topic='entity:<id>' 与实际数据形态不符，恒空）
  // 2026-09-03：加 tenant_id 过滤（客户记忆按租户隔离，设计 §15）
  const params = [];
  let where = `archived=false AND tenant_id=$${params.length + 1}`;
  params.push(tenantId);
  if (entityId) { params.push(entityId); where += ` AND entity_id=$${params.length}`; }
  const rows = (await query(
    `SELECT id, topic, kind, payload, created_at, tenant_id FROM crm.memory_log WHERE ${where} ORDER BY created_at DESC LIMIT 200`,
    params
  )).rows;

  // sparse 路：LIKE 命中（词级 AND 简化——关键词在文本中出现即计 1 分）
  const sparseScore = (row) => {
    const t = rowText(row);
    const words = q.split(/\s+/).filter(Boolean);
    if (!words.length) return 0;
    return words.filter((w) => t.toLowerCase().includes(w.toLowerCase())).length / words.length;
  };
  const sparseRanked = rows.map((r) => ({ row: r, s: sparseScore(r) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);

  // dense 路：查询向量与行文本向量余弦
  const qv = hashVector(q);
  const denseRanked = rows.map((r) => ({ row: r, s: cosine(qv, hashVector(rowText(r))) }))
    .sort((a, b) => b.s - a.s);

  // RRF 融合：rank 从 1 起；score = Σ 1/(rank+60)；dense 全量参与，sparse 仅命中者参与
  const K = 60;
  const acc = new Map();
  for (let i = 0; i < denseRanked.length; i++) {
    const r = denseRanked[i].row;
    acc.set(r.id, (acc.get(r.id) || 0) + denseWeight * (1 / (i + 1 + K)));
  }
  for (let i = 0; i < sparseRanked.length; i++) {
    const r = sparseRanked[i].row;
    acc.set(r.id, (acc.get(r.id) || 0) + (1 - denseWeight) * (1 / (i + 1 + K)));
  }

  return [...acc.entries()]
    .map(([id, score]) => {
      const row = rows.find((r) => r.id === id);
      return { id, topic: row.topic, kind: row.kind, payload: row.payload, created_at: row.created_at, score, tenant_id: row.tenant_id };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

export async function distillMemory({ ttlDays = 30 } = {}) {
  await queryWrite(`UPDATE crm.memory_log SET distilled=true WHERE archived=false AND distilled=false AND created_at < now() - ($1 || ' days')::interval`, [ttlDays]);
  await queryWrite(`UPDATE crm.memory_log SET archived=true WHERE archived=false AND created_at < now() - (($1 * 2) || ' days')::interval`, [ttlDays]);
  await queryWrite(`UPDATE crm.memory_note SET archived=true WHERE archived=false AND updated_at < now() - (ttl_days || ' days')::interval`);
  return { ok: true };
}
