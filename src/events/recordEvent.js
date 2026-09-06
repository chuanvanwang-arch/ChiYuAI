// src/events/recordEvent.js — L0 原始轨迹统一落库通道（Lightfield ground truth 层）
//
// 设计输入：docs/2026-09-02-lightfield-memory-decision-study.md §7.2 A1
//   Lightfield 的记忆栈是「raw 轨迹先落 → schema 后贴 → 故事派生」，其中 raw 层是唯一真相源：
//     "ground truth = raw, unstructured customer conversations"
//     "Reality comes first. Everything else is computed from it."
//   本项目的 L0 层（crm.events）长期恒 0 行——全仓仅 2 处裸 INSERT 且都 .catch(()=>{}) 静默吞错，
//   导致故事线（timelineSource）四源中 events 源永远为空、backfill 无从谈起。
//
// 本模块是 events 落库的**唯一收敛点**，承担三件事：
//   ① 规范 payload 形态（entity_id 客户锚点 + raw_text 原话），保证故事线能按客户聚合
//   ② 落库成功后才广播内存总线（先落真相源，避免"幽灵事件"——库里没有但订阅者已收到）
//   ③ 失败 fail-safe 但**不静默**（项目不静默铁律）：返回结构化错误码 + emit trace 留痕
//
// 多租户说明：crm.events 表无 tenant_id 列（既有设计），租户隔离信息写入 payload.tenant_id，
//   查询侧由调用方自行过滤。此处不擅自扩表，避免与并行会话的迁移冲突。
import { queryWrite } from '../db.js';
import { emit } from './bus.js';

// 保留键：由本模块独占赋值，调用方通过 extra 无法覆盖（防锚点被伪造）
const RESERVED_KEYS = ['entity_id', 'entity_type', 'raw_text', 'tenant_id', 'unanchored'];

// 纯函数：组装事件 payload（可无 DB 单测）
// 约定：无客户锚点时不省略标记，而是显式 unanchored:true —— 让"这条进不了故事线"可被观测，
//       而不是等故事线查询时静默返回空集（反假绿纪律）。
export function buildEventPayload({ entityId = null, entityType = null, rawText = null, tenantId = null, extra = {} } = {}) {
  const p = {};
  for (const [k, v] of Object.entries(extra || {})) {
    if (RESERVED_KEYS.includes(k)) continue; // 保留键不接受 extra 覆盖
    p[k] = v;
  }
  if (entityId) p.entity_id = entityId;
  if (entityType) p.entity_type = entityType;
  if (rawText) p.raw_text = rawText;
  if (tenantId) p.tenant_id = tenantId;
  if (!entityId) p.unanchored = true;
  return p;
}

// 纯函数：该 payload 是否带客户锚点（故事线/记忆检索按此过滤）
export function isAnchoredPayload(payload) {
  return !!(payload && payload.entity_id);
}

// 落库 + 广播。返回 {ok,...}，不抛异常（调用方在写路径上，抛异常会打断业务主流程）。
export async function recordEvent({
  domain, type, entityId = null, entityType = null,
  rawText = null, tenantId = null, actor = 'system', payload = {},
} = {}) {
  if (!domain || !type) return { ok: false, code: 'missing_identity', reason: 'domain 与 type 必填' };

  const p = buildEventPayload({ entityId, entityType, rawText, tenantId, extra: payload });
  try {
    const r = await queryWrite(
      `INSERT INTO crm.events (domain, type, payload, actor)
       VALUES ($1,$2,$3::jsonb,$4) RETURNING id, created_at`,
      [domain, type, JSON.stringify(p), actor || 'system']
    );
    // 落库成功后才广播：库里没有的事件不该被订阅者看到（否则 AGE 镜像/记忆捕获会与真相源分叉）
    emit(domain, type, p);
    return { ok: true, id: r.rows[0].id, createdAt: r.rows[0].created_at, anchored: isAnchoredPayload(p) };
  } catch (e) {
    // 不静默：留痕到 trace 域，供监控台捞取（原两处裸写均为 .catch(()=>{})，生产 100% 丢痕）
    emit('trace', 'event-record-failed', { domain, type, error: e?.message || String(e) });
    return { ok: false, code: 'insert_failed', error: e?.message || String(e) };
  }
}
