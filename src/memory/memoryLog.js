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

// ── C1 租户寻址（2026-09-10）────────────────────────────────────────────────
// 根因：读侧 retrieveMemory/rrfSearch 早已按 tenant_id 过滤，写侧却从未写入 tenant_id
//   （列 DEFAULT 'system'）→ 业务租户写的记忆 100% 沉到 system，自己永远读不到。
// 兜底链：显式入参 > payload.tenant_id（存量告警记忆 payload 里自带，可零成本救回）
//        > 'system'（兼容 60+ 存量调用点，零破坏）。
// 不静默：回退 system 时 emit trace，缺失可巡检（严格模式 MEMORY_STRICT_TENANT=1 可转拒写）。
export function resolveTenantId({ tenantId = null, payload = null } = {}) {
  if (tenantId && tenantId !== '*') return { tenant_id: String(tenantId), source: 'explicit' };
  const p = payload && typeof payload === 'object' ? payload : null;
  if (p && p.tenant_id && p.tenant_id !== '*') return { tenant_id: String(p.tenant_id), source: 'payload' };
  if (tenantId === '*') return { tenant_id: 'system', source: 'fallback' };
  return { tenant_id: 'system', source: 'fallback' };
}

// ── C2 客户锚点解析（2026-09-10）────────────────────────────────────────────
// 设计取舍：**客户优先于商机**。跨商机累积的才是长期客户记忆；锚商机则该客户换个
// 商机就断链。CRM_DEAL / CRM_CONTACT 一律上溯 payload.account_id。
export function mapEntityType(type = null) {
  const t = String(type || '').toUpperCase();
  if (t.includes('ACCOUNT') || t.includes('CUSTOMER')) return 'ACCOUNT';
  if (t.includes('DEAL') || t.includes('OPPORTUNITY')) return 'DEAL';
  if (t.includes('CONTACT')) return 'CONTACT';
  if (t.includes('LEAD')) return 'LEAD';
  return t || null;
}

export function resolveEntityAnchor({ entityId = null, entityType = null, payload = null, type = null, id = null } = {}) {
  const p = payload && typeof payload === 'object' ? payload : {};
  // ① 显式锚点最高优先级（调用方已知归属，不猜）
  if (entityId) {
    return { entity_id: String(entityId), entity_type: entityType || mapEntityType(type), source: 'explicit' };
  }
  // ② 客户上溯（跨商机累积价值的唯一口径）
  if (p.account_id) return { entity_id: String(p.account_id), entity_type: 'ACCOUNT', source: 'payload.account_id' };
  // ③ 商机锚点（无客户归属时退而求其次，仍强于无锚点）
  if (p.deal_id) return { entity_id: String(p.deal_id), entity_type: 'DEAL', source: 'payload.deal_id' };
  if (id && mapEntityType(type) === 'DEAL') return { entity_id: String(id), entity_type: 'DEAL', source: 'type-id' };
  // ④ 无归属信息：诚实留 NULL（禁止臆造锚点——错锚比无锚更危险，会污染客户画像）
  if (id) return { entity_id: String(id), entity_type: entityType || mapEntityType(type), source: 'id' };
  return { entity_id: null, entity_type: null, source: 'none' };
}

// A2（2026-09-02）：entityId = 客户锚点。锚点不再编码进 topic 字符串——
//   原两处约定互相矛盾（rrfSearch 用 'entity:<id>'、timelineSource 用 'account:<id>'）
//   且都与生产数据（topic 全为 'event:*' / 'decision:*'）不匹配，导致按客户聚合恒空。
//   改由独立列 entity_id 承载，topic 回归业务分类语义。存量调用方不传 entityId 则恒为 NULL，零破坏。
// 2026-09-10（C1/C2）：补 tenantId / entityType 入参，落 tenant_id + entity_type 列。
export async function appendMemory({ topic, kind = 'event', payload, layer = 'L-Workspace', actor, eventType, ttlDays = 30, explicit = false, valueHorizonDays = 30, entityId = null, entityType = null, tenantId = null, type = null, id = null }) {
  const verdict = judgeWorthiness(payload, { explicit, valueHorizonDays });
  if (!verdict.ok) return { ok: false, gate: 'worthiness', code: verdict.code, reason: verdict.reason };

  const strict = process.env.MEMORY_STRICT_TENANT === '1';
  const { tenant_id, source: tsrc } = resolveTenantId({ tenantId, payload });
  if (tsrc === 'fallback') {
    if (strict) return { ok: false, gate: 'tenant', code: 'tenant-missing', reason: 'appendMemory 缺 tenantId（严格模式拒写）' };
    // 动态 import 防循环依赖（capture.js 订阅总线，总线不反向依赖本模块）
    try {
      const { emit } = await import('../events/bus.js');
      emit('trace', 'memory-tenant-missing', { topic, kind });
    } catch { /* 总线不可用不阻断写入 */ }
  }
  const anchor = resolveEntityAnchor({ entityId, entityType, payload, type, id });

  const r = await queryWrite(
    `INSERT INTO crm.memory_log (topic, kind, payload, layer, actor, event_type, ttl_days, entity_id, entity_type, tenant_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [topic, kind, payload, layer, actor, eventType, ttlDays, anchor.entity_id, anchor.entity_type, tenant_id]
  );
  return { ok: true, row: r.rows[0], tenant_id, entity_id: anchor.entity_id, entity_type: anchor.entity_type };
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

// ── C7 决策记忆投影（2026-09-10）────────────────────────────────────────────
// 根因：旧投影只落 5 个控制字段（scenario_id/disposition/decider_type/business_tier/rationale），
//   合计约 210 B，且 rationale 是引擎模板句（"升级人工：置信度…参考先例 0 条"）→ 零业务语义。
//   更致命的是 injector.js#memoryText 只认 payload.text|summary|note|content 四个键，
//   旧投影一个都不含 → **即使读到了记忆也被过滤成空串**（写到读双向落空）。
// 形态照抄全库唯一那条 09-04 customer_memory 样板，不另发明：summary / entities / evidence / gaps。
// 硬约束：① 只加字段不删字段（既有消费方零回归）；② 4 KB 上限 + truncated 标记；
//        ③ 凭证类键过滤；④ 锚点复用 C2（客户优先）。
const CREDENTIAL_KEY = /(password|passwd|secret|token|api[_-]?key|authorization|cookie|smtp[_-]?pass|private[_-]?key)/i;
const PROJECT_MAX_BYTES = 4096;

// 递归剥离凭证类键（深度限 4，防超大 trigger_context 拖慢写路径）
export function stripCredentials(obj, depth = 0) {
  if (depth > 4 || obj == null) return obj;
  if (Array.isArray(obj)) return obj.slice(0, 20).map((x) => stripCredentials(x, depth + 1));
  if (typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj).slice(0, 50)) {
    if (CREDENTIAL_KEY.test(k)) { out[k] = '[redacted]'; continue; }
    out[k] = stripCredentials(v, depth + 1);
  }
  return out;
}

function pickText(o, keys) {
  for (const k of keys) {
    const v = o?.[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number') return String(v);
  }
  return '';
}

function clipText(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/**
 * 纯函数：把决策要素投影为四段式记忆 payload（可单测，无 DB / 无 LLM）。
 * summary 走规则裁剪而非 LLM —— 决策写路径上不引入额外成本与延迟。
 */
export function projectDecisionMemory(input = {}) {
  const {
    decision_id = null, scenario_id = null, disposition = null, business_tier = null,
    decider_type = null, rationale = '', trigger_context = null, involved_entities = null,
    conditions_evaluated = null, entity_id = null, entity_type = null,
  } = input;

  const tc = trigger_context && typeof trigger_context === 'object' ? stripCredentials(trigger_context) : {};
  const conds = Array.isArray(conditions_evaluated) ? conditions_evaluated : [];
  const isMet = (c) => c && (c.met === true || c.satisfied === true || c.passed === true);
  const nameOf = (c) => String(c?.key || c?.name || c?.id || c?.label || '');
  const met = conds.filter(isMet).map(nameOf).filter(Boolean);
  const unmet = conds.filter((c) => !isMet(c)).map(nameOf).filter(Boolean);

  const entities = (Array.isArray(involved_entities) ? involved_entities : []).slice(0, 10).map((e) => {
    if (typeof e === 'string') return { type: null, id: e, name: null };
    return { type: mapEntityType(e?.type || e?.label), id: e?.id ?? null, name: e?.name ?? e?.title ?? null };
  });

  // summary：业务主语优先（触发上下文里销售真正在问的事），全无再退回引擎 rationale
  const subject = pickText(tc, ['query', 'summary', 'subject', 'title', 'utterance', 'intent', 'action'])
    || clipText(rationale, 120)
    || '（无业务摘要）';
  const summary = clipText(`决策 ${scenario_id || '—'} → ${disposition || '—'}（${decider_type || '—'}）：${subject}`, 300);

  const evidence = [];
  if (met.length) evidence.push(`达标条件 ${met.length}/${conds.length}：${met.slice(0, 6).join('、')}`);
  for (const k of ['amount', 'discount', 'stage', 'to_stage', 'quantity', 'budget']) {
    if (tc[k] != null) evidence.push(`${k}=${clipText(tc[k], 40)}`);
  }
  if (!evidence.length) evidence.push('无结构化证据');

  const gaps = [];
  if (unmet.length) gaps.push(`未达标条件：${unmet.slice(0, 6).join('、')}`);
  for (const k of ['budget', 'authority', 'need', 'timeline']) {
    if (tc[k] == null && !conds.length) gaps.push(`缺 ${k}`);
  }
  if (!entity_id) gaps.push('缺客户锚点');

  let payload = {
    // ── 新增四段式（消费端 injector.memoryText 认 summary 键）──
    summary, entities, evidence, gaps,
    // ── 保留原 5 字段，既有消费方零回归（只加不删）──
    scenario_id, disposition, rationale, business_tier, decider_type,
    decision_id,
  };
  let truncated = false;
  const size = () => Buffer.byteLength(JSON.stringify(payload), 'utf8');
  if (size() > PROJECT_MAX_BYTES) {
    truncated = true;
    payload = { ...payload, gaps: gaps.slice(0, 3), evidence: evidence.slice(0, 3), entities: entities.slice(0, 3), summary: clipText(summary, 160) };
  }
  return { ...payload, truncated, entity_id, entity_type };
}

export async function distillMemory({ ttlDays = 30 } = {}) {
  await queryWrite(`UPDATE crm.memory_log SET distilled=true WHERE archived=false AND distilled=false AND created_at < now() - ($1 || ' days')::interval`, [ttlDays]);
  await queryWrite(`UPDATE crm.memory_log SET archived=true WHERE archived=false AND created_at < now() - (($1 * 2) || ' days')::interval`, [ttlDays]);
  await queryWrite(`UPDATE crm.memory_note SET archived=true WHERE archived=false AND updated_at < now() - (ttl_days || ' days')::interval`);
  return { ok: true };
}
