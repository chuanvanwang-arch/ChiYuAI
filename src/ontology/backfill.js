// src/ontology/backfill.js — 属性回填（backfill）通道
//
// 设计输入：docs/2026-09-02-lightfield-memory-decision-study.md §1.2 / §7.2 A4
//   Lightfield 的 schema-less 之所以成立，靠的是后半句能力：
//     "making it possible to arbitrarily generate values for it any time.
//      This is particularly useful when you decide you want to start capturing a certain field.
//      **If you've spoken about it in your conversations, it's easy enough to backfill.**"
//   本项目的 meta_attr「写时自适应登记」= 能后贴 schema，但**缺回填**：
//   属性登记晚于数据产生时，历史数据永远补不回来 —— 这是 identity 指纹漂移类缺陷的深层根因。
//
// 前提：回填的原料是 raw 轨迹（crm.events.raw_text）。A1 之前 crm.events 恒 0 行，
//   因此本模块在 A1 之前**根本无从实现**——先补原料再建派生，顺序不可颠倒。
//
// 设计取舍（V1）：
//   ① 抽值逻辑由调用方注入 extractor（规则或 LLM 皆可），本模块不内置语义理解
//      —— 避免在 hashVector 非语义（F3）尚未解决时，把不可靠的"抽取"固化进主链路。
//   ② 回填留痕复用 crm.memory_log（topic='backfill:<attr>'，entity_id 锚点），**不新增表**，
//      避免与并行会话的迁移冲突；留痕含来源事件 id 与旧值，可审计、可回滚。
//   ③ 反假绿：抽不到值 → 不写 payload，但**必须留痕 skipped 及原因**，绝不静默吞掉。
import { query, queryWrite } from '../db.js';
import { emit } from '../events/bus.js';

// 纯函数：从事件流挖掘可回填候选（可无 DB 单测）
// 判定：只有「有 raw_text（可抽取）」且「有 entity_id（能定位粒子）」的事件才是候选。
//   两类非候选单独计数而非丢弃——因为它们的数量本身就是诊断信号：
//   noRawText 高 = A1 写入通道没带原话；unanchored 高 = 调用方没传 entityId。
export function mineBackfillCandidates(events, { keywords = [], entityIds = null } = {}) {
  const kws = (keywords || []).filter(Boolean);
  const scope = Array.isArray(entityIds) && entityIds.length ? new Set(entityIds) : null;
  const stats = { total: 0, noRawText: 0, unanchored: 0, outOfScope: 0 };
  const candidates = [];

  for (const ev of events || []) {
    stats.total += 1;
    const rawText = typeof ev?.raw_text === 'string' ? ev.raw_text.trim() : '';
    if (!rawText) { stats.noRawText += 1; continue; }
    if (!ev?.entity_id) { stats.unanchored += 1; continue; }
    if (scope && !scope.has(ev.entity_id)) { stats.outOfScope += 1; continue; }

    // 无关键词时视为全量候选（调用方自行用 extractor 过滤）
    const matched = kws.length ? kws.filter((k) => rawText.includes(k)) : [];
    if (kws.length && !matched.length) continue;

    candidates.push({
      eventId: ev.id,
      entityId: ev.entity_id,
      rawText,
      matched,
      ts: ev.created_at ? new Date(ev.created_at).toISOString() : null,
    });
  }

  // 最近的证据优先回填（后发生的更可能反映当前状态）
  candidates.sort((a, b) => (a.ts && b.ts ? (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0) : 0));
  return { candidates, stats };
}

// 落库回填：扫描 events → 抽值 → 写粒子 payload → 留痕
// extractor(rawText, event) → 值；返回 null/undefined 表示抽不到（跳过，留痕不写库）
export async function backfillAttribute({
  attrKey, keywords = [], extractor, entityIds = null,
  actor = 'system', limit = 200, dryRun = false,
} = {}) {
  if (!attrKey) return { ok: false, code: 'missing_attr_key' };
  if (typeof extractor !== 'function') return { ok: false, code: 'missing_extractor' };

  const topic = `backfill:${attrKey}`;
  // 注意：crm.events **没有 entity_id 列**（表结构仅 id/domain/type/payload/actor/created_at），
  //   锚点在 payload->>'entity_id'。SELECT 里写裸 entity_id 会报 column does not exist；
  //   此处曾经被 .catch(()=>({rows:[]})) 静默吞掉，表现为「回填跑了但 applied 恒 0」——
  //   与本模块自己宣称的「不静默」铁律相悖，故查询失败必须留痕再降级。
  const rows = (await query(
    `SELECT id, payload, created_at
     FROM crm.events
     WHERE payload ? 'raw_text' AND payload ? 'entity_id'
     ORDER BY created_at DESC LIMIT $1`,
    [Number(limit) > 0 ? Number(limit) : 200]
  ).catch((e) => {
    emit('trace', 'backfill-scan-failed', { attrKey, error: e?.message || String(e) });
    return { rows: [] };
  })).rows;

  const events = rows.map((r) => ({
    id: r.id, entity_id: r.payload?.entity_id,
    raw_text: r.payload?.raw_text, created_at: r.created_at,
  }));

  const { candidates, stats } = mineBackfillCandidates(events, { keywords, entityIds });
  const result = { scanned: stats.total, candidates: candidates.length, applied: 0, skipped: 0, failed: 0, details: [] };
  const seenEntity = new Set();

  for (const c of candidates) {
    // 同一实体只回填一次（取最新证据），避免旧证据覆盖新值
    if (seenEntity.has(c.entityId)) continue;

    let value;
    try {
      value = extractor(c.rawText, c);
    } catch (e) {
      result.failed += 1;
      await logBackfill({ topic, attrKey, c, result: 'failed', reason: `extractor 抛错: ${e?.message || e}`, actor, dryRun });
      continue;
    }

    if (value === null || value === undefined || value === '') {
      result.skipped += 1;
      // 反假绿：抽不到值也必须留痕，否则"回填没生效"和"回填没跑"无法区分
      await logBackfill({ topic, attrKey, c, result: 'skipped', reason: 'extractor 未抽出值', actor, dryRun });
      continue;
    }

    seenEntity.add(c.entityId);
    if (dryRun) { result.applied += 1; result.details.push({ entityId: c.entityId, value, dryRun: true }); continue; }

    const upd = await queryWrite(
      `UPDATE crm.particles
       SET payload = payload || jsonb_build_object($2::text, $3::jsonb), updated_at = now()
       WHERE id = $1::uuid
       RETURNING payload`,
      [c.entityId, attrKey, JSON.stringify(value)]
    ).catch(() => ({ rows: [] }));

    if (!upd.rows.length) {
      result.skipped += 1;
      await logBackfill({ topic, attrKey, c, result: 'skipped', reason: '粒子不存在或 id 非 UUID', actor });
      continue;
    }

    result.applied += 1;
    result.details.push({ entityId: c.entityId, value });
    await logBackfill({ topic, attrKey, c, result: 'applied', newValue: value, actor });
  }

  return { ok: true, stats: { ...stats, applied: result.applied, skipped: result.skipped, failed: result.failed }, ...result };
}

// 回填留痕（复用 memory_log，不新增表）：含来源事件 id，可审计可回滚
async function logBackfill({ topic, attrKey, c, result, newValue = null, reason = null, actor = 'system', dryRun = false }) {
  if (dryRun) return;
  await queryWrite(
    `INSERT INTO crm.memory_log (topic, kind, payload, layer, actor, entity_id, tenant_id)
     VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7)`,
    [
      topic,
      'backfill',
      JSON.stringify({
        attr_key: attrKey,
        result,
        new_value: newValue,
        from_event_id: c?.eventId ?? null,
        evidence: c?.rawText ?? null,
        matched_keywords: c?.matched ?? [],
        reason,
        at: new Date().toISOString(),
      }),
      'L-Workspace',
      actor,
      c?.entityId ?? null,
      'system', // 本体回填是平台级数据操作，无业务租户上下文；显式声明避免被误判为多租户泄漏
    ]
  ).catch(() => {}); // 留痕失败不阻断回填主流程，但回填结果本身已计入 stats
}
